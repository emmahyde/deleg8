// PiAgent — one long-lived `omp --mode rpc` subprocess driven over NDJSON stdio.
//
// Frame model (from the omp README):
//   > {"id":"r1","type":"prompt","message":"..."}
//   < {"id":"r1","type":"response", ...}
//   > {"id":"r2","type":"set_model","provider":"...","modelId":"..."}
//   > {"id":"r3","type":"abort"}
//
// Response frames whose `id` matches a pending request complete that request's
// promise; every frame is also pushed to a bounded ring buffer for `pi_output`.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { encode, readLines, decode, type Frame } from "./frames.ts";

export class PiAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiAgentError";
  }
}

export type AgentState = "running" | "idle" | "dead";

export interface AgentStatus {
  agent_id: string;
  pid: number | null;
  state: AgentState;
  /** Convenience: `state === "running"`. Kept for clients that don't know about idle. */
  running: boolean;
  started_at: number;
  last_activity: number;
  message_count: number;
  buffered_frames: number;
  model: string | null;
  exit_code: number | null;
  log_path: string | null;
  session_id: string | null;
  session_file: string | null;
  session_dir: string | null;
  auto_suspend: boolean;
}

export interface BufferedFrame {
  seq: number;
  ts: number;
  frame: Frame;
}

interface Pending {
  resolve: (frame: Frame) => void;
  reject: (err: Error) => void;
}

const BUFFER_CAP = 1024;
let ID_COUNTER = 0;

export interface PiAgentOptions {
  binary?: string;
  extraArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** RPC mode: "rpc" (no UI) or "rpc-ui" (enables extension_ui_request frames). */
  rpcMode?: "rpc" | "rpc-ui";
  /**
   * Called when omp emits an active `extension_ui_request` (select/confirm/input/editor).
   * Must return the response frame to write back to omp (or null to send cancellation).
   */
  onUIRequest?: (request: Frame) => Promise<Frame | null>;
  /** Called for host_tool_call / host_uri_request — return the response frame. */
  onHostRequest?: (request: Frame) => Promise<Frame | null>;
  /** Escape hatch: full argv to Bun.spawn, overrides binary+rpcMode+extraArgs. */
  command?: string[];
  /** Directory to write `<agentId>.log` NDJSON into. Mutually exclusive with logPath. */
  logDir?: string;
  /** Explicit log path. Overrides logDir if both are set. */
  logPath?: string;
  /** Directory omp persists session state into (`--session-dir`). Defaults to `<logDir>/<agentId>-session`. */
  sessionDir?: string;
  /** If true, suspend the subprocess after every `turn_end` (default true). */
  autoSuspend?: boolean;
}

export class PiAgent {
  readonly agentId: string;
  private readonly binary: string;
  private readonly extraArgs: string[];
  private readonly cwd: string | undefined;
  private readonly env: Record<string, string> | undefined;
  private readonly rpcMode: "rpc" | "rpc-ui";
  private readonly onUIRequest: ((req: Frame) => Promise<Frame | null>) | undefined;
  private readonly onHostRequest: ((req: Frame) => Promise<Frame | null>) | undefined;
  private readonly command: string[] | undefined;
  private readonly logDir: string | null;
  private logPath: string | null = null;
  private sessionDir: string | null;
  private sessionId: string | null = null;
  private sessionFile: string | null = null;
  readonly autoSuspend: boolean;

  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private readerTask: Promise<void> | null = null;
  private whenReady: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private state: AgentState = "dead";
  private suspendTask: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly buffer: BufferedFrame[] = [];
  private bufferSeq = 0;
  private startedAt = 0;
  private lastActivity = 0;
  private messageCount = 0;
  private model: string | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(agentId: string, opts: PiAgentOptions = {}) {
    this.agentId = agentId;
    this.binary = opts.binary ?? "omp";
    this.extraArgs = opts.extraArgs ?? [];
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.rpcMode = opts.rpcMode ?? "rpc-ui";
    this.onUIRequest = opts.onUIRequest;
    this.onHostRequest = opts.onHostRequest;
    this.command = opts.command;
    this.logDir = opts.logDir ?? null;
    this.logPath = opts.logPath ?? null;
    this.sessionDir = opts.sessionDir ?? (this.logDir ? join(this.logDir, agentId, "omp") : null);
    this.autoSuspend = opts.autoSuspend ?? true;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  private buildSpawnArgs(): string[] {
    // omp persists conversation state in a session file; we name a per-agent
    // dir so multiple agents in the same cwd don't trample each other. On
    // first start, omp creates a fresh session in the dir; on subsequent
    // starts (resume), --resume <sessionId> re-attaches to the same file.
    // When `command` is provided (tests), it replaces the binary+rpc-mode
    // prefix; session/resume/extra flags are appended either way.
    const prefix = this.command ?? [this.binary, "--mode", this.rpcMode];
    const args = [...prefix];
    if (this.sessionDir) {
      try {
        mkdirSync(this.sessionDir, { recursive: true });
      } catch (e) {
        console.error(`pi-agent: could not create session dir ${this.sessionDir}:`, (e as Error).message);
      }
      args.push("--session-dir", this.sessionDir);
    }
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }
    args.push(...this.extraArgs);
    return args;
  }

  async start(): Promise<void> {
    if (this.proc !== null) {
      throw new PiAgentError(`agent ${this.agentId} already started`);
    }
    const args = this.buildSpawnArgs();
    try {
      this.proc = Bun.spawn(args, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.cwd,
        env: this.env ? { ...process.env, ...this.env } : undefined,
      });
    } catch (e) {
      const err = e as Error;
      throw new PiAgentError(
        `failed to spawn ${this.binary}: ${err.message} — install oh-my-pi first (npm i -g @oh-my-pi/pi-coding-agent)`,
      );
    }
    this.startedAt = Date.now();
    this.lastActivity = this.startedAt;
    this.state = "running";
    this.writeChain = Promise.resolve();
    if (!this.logPath && this.logDir) {
      try {
        mkdirSync(this.logDir, { recursive: true });
        this.logPath = join(this.logDir, `${this.agentId}.log`);
      } catch (e) {
        console.error(`pi-agent: could not create log dir ${this.logDir}:`, (e as Error).message);
      }
    }
    this.whenReady = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.readerTask = this.readLoop();
    // Detect immediate spawn failure (binary missing / exit during startup).
    queueMicrotask(() => {
      this.proc?.exited.then((code) => {
        for (const [, p] of this.pending) {
          p.reject(new PiAgentError(`agent ${this.agentId} exited with code ${code}`));
        }
        this.pending.clear();
        if (this.readyReject) {
          this.readyReject(new PiAgentError(`agent ${this.agentId} exited before ready (code=${code})`));
          this.readyReject = null;
          this.readyResolve = null;
        }
        if (this.state !== "idle") {
          this.state = this.sessionId ? "idle" : "dead";
        }
      });
    });

    // Wait for omp to emit `ready` before returning. Without this, callers can
    // race and write a prompt before omp has finished initializing.
    await withTimeout(this.whenReady, 30_000, () =>
      new PiAgentError(`agent ${this.agentId} did not emit ready frame within 30s`),
    );

    // omp's ready frame is bare — we must explicitly ask for session info.
    // Fire-and-forget here; if it fails (e.g. older omp without get_state),
    // the agent still works, we just won't have a sessionId for resume.
    void this.captureSession();
  }

  private async captureSession(): Promise<void> {
    try {
      const res = await this.sendRaw({ id: this.nextId(), type: "get_state" }, { wait: true, timeoutMs: 5_000 });
      if (typeof res === "string") return;
      const data = (res as { data?: unknown }).data ?? res;
      const obj = data as { sessionId?: unknown; sessionFile?: unknown };
      if (typeof obj.sessionId === "string") this.sessionId = obj.sessionId;
      if (typeof obj.sessionFile === "string") this.sessionFile = obj.sessionFile;
    } catch (e) {
      // get_state is fire-and-forget on startup. The agent may be stopped
      // before the response arrives — those rejections come from readLoop's
      // finally clause and start()'s exit handler with these exact messages.
      // Everything else (timeout, malformed reply, older omp without
      // get_state support) is a real failure worth surfacing.
      const msg = (e as Error).message;
      const isShutdownRace =
        msg === "agent process exited" || msg.startsWith(`agent ${this.agentId} exited with code`);
      if (!isShutdownRace) {
        console.error(`pi-agent: get_state failed for ${this.agentId}:`, msg);
      }
    }
  }

  async stop(opts: { force?: boolean; timeoutMs?: number } = {}): Promise<number | null> {
    const proc = this.proc;
    if (proc === null) return null;
    const timeoutMs = opts.timeoutMs ?? 5000;
    const force = opts.force ?? false;

    if (proc.exitCode === null && proc.signalCode === null) {
      if (!force) {
        try {
          await this.sendRaw({ type: "abort" }, { wait: false });
        } catch {
          /* ignore */
        }
      }
      proc.kill(force ? "SIGKILL" : "SIGTERM");
      const exited = proc.exited;
      const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
      const winner = await Promise.race([exited.then(() => "exited" as const), timer]);
      if (winner === "timeout") {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }

    if (this.readerTask) {
      try {
        await this.readerTask;
      } catch {
        /* ignore */
      }
    }
    for (const [, p] of this.pending) p.reject(new PiAgentError("agent stopped"));
    this.pending.clear();
    return proc.exitCode;
  }

  /**
   * Kill the subprocess but keep registry state (sessionId, buffer, log). The
   * agent becomes resumable via `resume()` or transparently via `sendPrompt`.
   * Called automatically on `turn_end` when `autoSuspend` is true.
   */
  async suspend(opts: { timeoutMs?: number } = {}): Promise<void> {
    if (this.state !== "running" || !this.proc) return;
    if (!this.sessionId) return; // can't resume without sessionId — leave proc alive
    this.state = "idle";
    this.suspendTask = this.suspendProc(opts.timeoutMs);
    await this.suspendTask;
  }

  private async suspendProc(timeoutMs = 3_000): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    proc.kill("SIGTERM");
    const exited = proc.exited;
    const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
    const winner = await Promise.race([exited.then(() => "exited" as const), timer]);
    if (winner === "timeout") {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    if (this.readerTask) {
      try { await this.readerTask; } catch { /* ignore */ }
    }
    for (const [, p] of this.pending) p.reject(new PiAgentError("agent suspended mid-request"));
    this.pending.clear();
    this.proc = null;
    this.readerTask = null;
  }

  /** Respawn an idle agent against its prior session. No-op if already running. */
  async resume(): Promise<void> {
    if (this.suspendTask) {
      try { await this.suspendTask; } catch { /* ignore */ }
      this.suspendTask = null;
    }
    if (this.state === "running") return;
    if (!this.sessionId) {
      throw new PiAgentError(`agent ${this.agentId} has no sessionId to resume from`);
    }
    this.proc = null;
    await this.start();
  }

  // ── messaging ─────────────────────────────────────────────────────────

  async sendPrompt(message: string, opts: { wait?: boolean; timeoutMs?: number } = {}): Promise<Frame | string> {
    const wait = opts.wait ?? true;
    const timeoutMs = opts.timeoutMs ?? 300_000;
    if (this.state === "idle") await this.resume();
    const id = this.nextId();
    const frame: Frame = { id, type: "prompt", message };
    this.messageCount += 1;
    return this.dispatch(frame, { wait, timeoutMs });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const id = this.nextId();
    await this.dispatch({ id, type: "set_model", provider, modelId }, { wait: false });
    this.model = `${provider}/${modelId}`;
  }

  async abort(): Promise<void> {
    await this.dispatch({ id: this.nextId(), type: "abort" }, { wait: false });
  }

  async sendRaw(frame: Frame, opts: { wait?: boolean; timeoutMs?: number } = {}): Promise<Frame | string> {
    const wait = opts.wait ?? true;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const withId: Frame = frame.id ? frame : { id: this.nextId(), ...frame };
    return this.dispatch(withId, { wait, timeoutMs });
  }

  private async dispatch(
    frame: Frame,
    opts: { wait: boolean; timeoutMs?: number },
  ): Promise<Frame | string> {
    this.requireRunning();
    const proc = this.proc!;
    const id = String(frame.id);
    const bytes = encode(frame);

    let pendingPromise: Promise<Frame> | null = null;
    if (opts.wait) {
      pendingPromise = new Promise<Frame>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
      });
    }

    // Serialize writes so two concurrent dispatches can't interleave frames.
    this.writeChain = this.writeChain.then(async () => {
      const sink = proc.stdin as Bun.FileSink;
      sink.write(bytes);
      await sink.flush();
    });
    try {
      await this.writeChain;
    } catch (e) {
      this.pending.delete(id);
      throw new PiAgentError(`agent ${this.agentId} stdin error: ${(e as Error).message}`);
    }
    this.lastActivity = Date.now();

    if (!pendingPromise) return `dispatched id=${id}`;

    const timeoutMs = opts.timeoutMs ?? 60_000;
    return await withTimeout(pendingPromise, timeoutMs, () => {
      this.pending.delete(id);
      return new PiAgentError(
        `timeout waiting for response to id=${id} after ${timeoutMs}ms (agent may still be working — use pi_output to inspect)`,
      );
    });
  }

  // ── reader ────────────────────────────────────────────────────────────

  private async readLoop(): Promise<void> {
    const proc = this.proc;
    if (!proc?.stdout) return;
    try {
      for await (const line of readLines(proc.stdout as ReadableStream<Uint8Array>)) {
        const frame = decode(line);
        if (frame === null) continue;
        this.onFrame(frame);
      }
    } finally {
      for (const [, p] of this.pending) p.reject(new PiAgentError("agent process exited"));
      this.pending.clear();
    }
  }

  private onFrame(frame: Frame): void {
    this.lastActivity = Date.now();
    this.bufferSeq += 1;
    this.buffer.push({ seq: this.bufferSeq, ts: this.lastActivity, frame });
    if (this.buffer.length > BUFFER_CAP) this.buffer.shift();
    if (this.logPath) {
      try {
        appendFileSync(this.logPath, JSON.stringify(frame) + "\n");
      } catch {
        /* logging is best-effort; don't crash the reader on disk errors */
      }
    }

    const fid = frame.id;
    const ftype = frame.type;

    if (ftype === "ready") {
      if (this.readyResolve) {
        this.readyResolve();
        this.readyResolve = null;
        this.readyReject = null;
      }
      return;
    }

    if (ftype === "turn_end" && this.autoSuspend && this.state === "running" && this.sessionId) {
      // Flip state synchronously so any in-flight sendPrompt sees "idle"
      // before dispatching to a soon-to-die proc. The actual subprocess kill
      // runs in the background and is awaited by resume().
      this.state = "idle";
      this.suspendTask = this.suspendProc();
      return;
    }

    if (typeof fid === "string" && ftype === "response") {
      const p = this.pending.get(fid);
      if (p) {
        this.pending.delete(fid);
        p.resolve(frame);
      }
      return;
    }

    if (ftype === "extension_ui_request") {
      void this.handleUIRequest(frame);
      return;
    }

    if (ftype === "host_tool_call" || ftype === "host_uri_request") {
      void this.handleHostRequest(frame);
      return;
    }
  }

  private async handleUIRequest(request: Frame): Promise<void> {
    const id = typeof request.id === "string" ? request.id : "";
    const method = request.method;
    const ACTIVE = new Set(["select", "confirm", "input", "editor"]);
    if (typeof method !== "string" || !ACTIVE.has(method)) {
      // Passive methods (notify/setStatus/setWidget/setTitle/set_editor_text/open_url/cancel)
      // are fire-and-forget — already buffered, nothing to do.
      return;
    }
    if (!this.onUIRequest || !id) {
      // No handler wired — decline so omp doesn't hang.
      await this.safeWrite({ type: "extension_ui_response", id, cancelled: true });
      return;
    }
    try {
      const response = await this.onUIRequest(request);
      if (response) {
        await this.safeWrite(response);
      } else {
        await this.safeWrite({ type: "extension_ui_response", id, cancelled: true });
      }
    } catch {
      await this.safeWrite({ type: "extension_ui_response", id, cancelled: true });
    }
  }

  private async handleHostRequest(request: Frame): Promise<void> {
    const id = typeof request.id === "string" ? request.id : "";
    if (!id) return;
    if (this.onHostRequest) {
      try {
        const response = await this.onHostRequest(request);
        if (response) {
          await this.safeWrite(response);
          return;
        }
      } catch {
        /* fall through to error response */
      }
    }
    // Default: refuse so omp doesn't hang. Shape depends on the request type.
    if (request.type === "host_tool_call") {
      await this.safeWrite({
        type: "host_tool_result",
        id,
        isError: true,
        result: { error: "pi-agent-mcp registered no host tools" },
      });
    } else if (request.type === "host_uri_request") {
      await this.safeWrite({
        type: "host_uri_result",
        id,
        isError: true,
        error: "pi-agent-mcp registered no host URI schemes",
      });
    }
  }

  private async safeWrite(frame: Frame): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const bytes = encode(frame);
    this.writeChain = this.writeChain.then(async () => {
      const sink = proc.stdin as Bun.FileSink;
      sink.write(bytes);
      await sink.flush();
    });
    try {
      await this.writeChain;
    } catch {
      /* surface via response correlation if it matters */
    }
  }

  // ── introspection ─────────────────────────────────────────────────────

  status(): AgentStatus {
    const proc = this.proc;
    // Bun sets `signalCode` instead of `exitCode` for signal-terminated children,
    // so consider both when deciding liveness.
    const procAlive = proc !== null && proc.exitCode === null && proc.signalCode === null;
    if (!procAlive && this.state === "running") {
      // Process died unexpectedly. If we have a sessionId, we can still resume → idle.
      this.state = this.sessionId ? "idle" : "dead";
    }
    return {
      agent_id: this.agentId,
      pid: proc?.pid ?? null,
      state: this.state,
      running: this.state === "running",
      started_at: this.startedAt,
      last_activity: this.lastActivity,
      message_count: this.messageCount,
      buffered_frames: this.buffer.length,
      model: this.model,
      exit_code: proc && !procAlive ? proc.exitCode : null,
      log_path: this.logPath,
      session_id: this.sessionId,
      session_file: this.sessionFile,
      session_dir: this.sessionDir,
      auto_suspend: this.autoSuspend,
    };
  }

  getLogPath(): string | null {
    return this.logPath;
  }

  output(opts: { sinceSeq?: number; maxFrames?: number } = {}): BufferedFrame[] {
    const since = opts.sinceSeq ?? 0;
    const max = opts.maxFrames ?? 200;
    const filtered = since > 0 ? this.buffer.filter((f) => f.seq > since) : this.buffer.slice();
    return filtered.slice(-max);
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private nextId(): string {
    ID_COUNTER += 1;
    return `r${ID_COUNTER}`;
  }

  private requireRunning(): void {
    if (this.proc === null) {
      throw new PiAgentError(`agent ${this.agentId} not started`);
    }
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
      const how = this.proc.exitCode !== null ? `code=${this.proc.exitCode}` : `signal=${this.proc.signalCode}`;
      throw new PiAgentError(`agent ${this.agentId} has exited (${how})`);
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(onTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
