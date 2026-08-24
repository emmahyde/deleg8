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

import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";

import { encode, readLines, decode, type Frame } from "./frames.ts";
import type { AgentSnapshot } from "./persist.ts";

/**
 * A tool deleg8 implements on omp's behalf. Mirrors omp's `RpcHostToolDefinition`
 * (dist/types/modes/rpc/rpc-types.d.ts:650) — omp is a runtime peer, not a build
 * dependency, so the shape is restated rather than imported.
 */
export interface RpcHostToolDefinition {
  name: string;
  label?: string;
  description: string;
  /** JSON Schema object describing the tool's arguments. */
  parameters: Record<string, unknown>;
  hidden?: boolean;
}

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
  /** Number of commands blocked by denylist (this session). */
  denied_count: number;
  /** Number of file writes outside declared scope. */
  scope_violations: number;
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

// omp frames (esp. "response") embed the full accumulated conversation on
// every turn, so logging them verbatim makes the .log file grow ~quadratically
// with conversation length (observed: multi-GB files after long sessions).
// Cap what we write per line and cap+rotate the file itself so logs stay
// bounded regardless of session length. This only affects the NDJSON debug
// .log — the .jsonl session transcript written by omp itself is untouched.
const MAX_LOG_LINE_BYTES = 4 * 1024;
const MAX_LOG_FILE_BYTES = 50 * 1024 * 1024;

// ~100/sec, each carrying the whole partial message: they crowd tool calls out
// of the log faster than rotation trims it. message_end carries the assembled
// message, and summarize.ts drops these too.
const UNLOGGED_FRAME_TYPES = new Set(["message_update"]);

/** Reduce a frame to a bounded-size line for the debug .log, summarizing rather
 * than truncating mid-JSON when the full frame would exceed the per-line cap. */
function summarizeFrameForLog(frame: Frame): string {
  const full = JSON.stringify(frame);
  if (full.length <= MAX_LOG_LINE_BYTES) return full;
  const summary: Record<string, unknown> = { id: frame.id, type: frame.type };
  if (typeof frame.toolName === "string") summary.toolName = frame.toolName;
  if (typeof frame.model === "string") summary.model = frame.model;
  summary.truncated = true;
  summary.originalBytes = full.length;
  summary.preview = full.slice(0, MAX_LOG_LINE_BYTES);
  return JSON.stringify(summary);
}

/** Rotate log via cached size check. Only calls statSync once (first write).
 * Subsequent writes use the in-memory accumulator; on rotation the counter is
 * reset and the one-time stat repeats lazily. */
function rotateLogIfNeeded(logPath: string, incomingBytes: number, cachedSize: { value: number; init: boolean }): number | null {
  if (!cachedSize.init) {
    // First write — stat the file to initialize
    try {
      if (existsSync(logPath)) cachedSize.value = statSync(logPath).size;
    } catch { /* best-effort */ }
    cachedSize.init = true;
  }
  if (cachedSize.value + incomingBytes > MAX_LOG_FILE_BYTES) {
    try {
      renameSync(logPath, `${logPath}.1`);
    } catch { /* best-effort; if rotation fails we just keep appending */ }
    cachedSize.value = incomingBytes;
    // File rotated — next write will re-stat to confirm
    cachedSize.init = false;
    return cachedSize.value;
  }
  cachedSize.value += incomingBytes;
  return cachedSize.value;
}

// Real sessions produce 14k-24k frames but the ring buffer above only keeps
// the last BUFFER_CAP — early tool calls are long gone by the time a digest
// is requested. modifiedFiles (below) tracks paths durably, independent of
// the buffer, from the same frame-intake path. omp emits lowercase
// `tool_execution_start` frames with a `toolName` + `args` object; "write"
// carries a clean args.path, "edit" has no path field — the path lives in a
// patch-header line embedded in args.input (e.g. `[docs/STATE.md#1D48]`,
// possibly several per patch) — strip the `#...` suffix and pull every header.
const FILE_MODIFYING_TOOL_NAMES = new Set(["write", "edit", "multiedit"]);
const PATCH_HEADER_RE = /^\[([^\]#]+)/gm;

function extractToolCallPaths(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  const path = args.path ?? args.file_path;
  if (typeof path === "string" && path.length > 0) return [path];
  if (typeof args.input === "string") {
    const paths: string[] = [];
    for (const m of args.input.matchAll(PATCH_HEADER_RE)) {
      const p = m[1]?.trim();
      if (p) paths.push(p);
    }
    return paths;
  }
  return [];
}

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
  /** Snapshot from a previous server session; starts idle and resumes on first send. */
  resumeState?: AgentSnapshot;
  /** If true, suspend the subprocess after every `turn_end` (default true). */
  autoSuspend?: boolean;
  /**
   * Regex patterns over argv for denied commands. When a tool_execution_start frame
   * matches, the tool is NOT blocked at the OS level (omp runs it internally), but a
   * violation is recorded and a callback fires. Paired with prompt injection at the
   * spawn site for agent-level enforcement.
   *
   * Each string is a case-insensitive regex tested against the concatenated
   * `toolName + " " + command` (or just `toolName` if no command arg).
   */
  denylist?: string[];
  /**
   * Glob patterns constraining which files this agent may write. When a
   * tool_execution_start frame for write/edit/multiedit targets a path outside
   * all `own` patterns, a scope violation is recorded and a callback fires.
   * Paired with prompt injection at the spawn site.
   */
  own?: string[];
  /**
   * Shared context block prepended to every initial_prompt. Designed for
   * fan-out-level ground-truth that every spawned agent receives — library
   * idioms, API contracts, forbidden patterns — without repeating it per prompt.
   */
  preamble?: string;
  /** Fallback model if the primary set_model fails (e.g. budget exceeded). */
  fallbackModel?: { provider: string; modelId: string };
  /**
   * Called when a tool_execution_start frame violates a denylist pattern or
   * write-scope constraint. The deleg8 server wires this to channel notifications.
   */
  onViolation?: (agentId: string, type: "denied" | "scope", detail: Record<string, unknown>) => void;
  /**
   * Called before resume() respawns the subprocess; throw to refuse. The
   * registry wires this to its capacity/memory gate so resumed agents count
   * against the same cap as fresh spawns.
   */
  preResumeGate?: () => void;
}

export class PiAgent {
  readonly agentId: string;
  private readonly binary: string;
  private readonly extraArgs: string[];
  private readonly cwd: string | undefined;
  private readonly env: Record<string, string> | undefined;
  private readonly rpcMode: "rpc" | "rpc-ui";
  private readonly onUIRequest: ((req: Frame) => Promise<Frame | null>) | undefined;
  private readonly _optOnHostRequest: ((req: Frame) => Promise<Frame | null>) | undefined;
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
  /**
   * Set by stop(). An operator-issued stop is terminal even when a resumable
   * sessionId exists — without this the agent is indistinguishable from an
   * auto-suspended one and prune(["dead"]) skips it forever.
   */
  private stopped = false;
  private suspendTask: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly buffer: BufferedFrame[] = [];
  /** Files touched by write/edit tool calls, survives ring-buffer eviction. */
  readonly modifiedFiles: Set<string> = new Set();
  private bufferSeq = 0;
  private startedAt = 0;
  private lastActivity = 0;
  private messageCount = 0;
  private model: string | null = null;
  /** Running total of message.usage.cost.total across all frames, O(1) query cost. */
  private totalCostUsd: number = 0;
  /** Cached log file size to avoid statSync on every frame. Reset on rotation. */
  private logSize: number = 0;
  private logSizeInitialized: boolean = false;
  private writeChain: Promise<void> = Promise.resolve();
  /** Denylist regex patterns compiled at construction. Server can append. */
  denylistRe: RegExp[] = [];
  /** Write-scope glob patterns compiled at construction (minimatch not used — host-side server does minimatch). */
  /** Write-scope glob patterns. Server can extend post-construction. */
  own: string[] = [];
  /** Shared context injected before every prompt. */
  preamble: string | null = null;
  /** Commands that matched a denylist entry, in chronological order. */
  readonly deniedCommands: Array<{
    seq: number;
    toolName: string;
    command: string;
    pattern: string;
    ts: number;
  }> = [];
  /** File writes that fell outside `own` scope, in chronological order. */
  readonly scopeViolations: Array<{
    seq: number;
    toolName: string;
    path: string;
    ts: number;
  }> = [];
  /** Fallback model spec for when the primary model fails to apply. */
  fallbackModel: { provider: string; modelId: string } | null = null;

  /**
   * Called for every turn_end and agent_end frame — used by channel push.
   * Must be set by every code path that creates a PiAgent.
   */
  onChannelFrame?: (agentId: string, frame: Frame, ftype: "turn_end" | "agent_end") => void;

  /**
   * Called for every host_tool_call / host_uri_request. Return the response frame to write back,
   * or null to fall through to the default error response. Set by the spawn handler to enable
   * IRC-style messaging and task tracking without needing opts at construction time.
   */
  onHostRequest?: (agentId: string, request: Frame) => Promise<Frame | null>;

  /**
   * Called when a tool_execution_start frame violates a denylist or scope constraint.
   * Wired by the server to fire channel notifications for real-time orchestrator visibility.
   */
  onViolation?: (agentId: string, type: "denied" | "scope", detail: Record<string, unknown>) => void;

  /** Called when persisted lifecycle state changes. */
  onStateChange?: (agent: PiAgent, event: "session" | "agent_end" | "suspend") => void;

  /**
   * Host tools advertised to omp via `set_host_tools`. omp's tool registry is
   * per-process, so this is re-sent on every start() — including the respawn
   * inside resume(). Empty means the agent sees no host tools at all, which was
   * deleg8's behavior before 2026-07-31 despite the docs claiming otherwise.
   */
  hostTools: RpcHostToolDefinition[] = [];

  /** Capacity gate run before resume() respawns the subprocess. See PiAgentOptions.preResumeGate. */
  private readonly preResumeGate: (() => void) | undefined;

  constructor(agentId: string, opts: PiAgentOptions = {}) {
    this.agentId = agentId;
    const resumed = opts.resumeState;
    this.binary = opts.binary ?? "omp";
    this.extraArgs = opts.extraArgs ?? resumed?.extra_args ?? [];
    this.cwd = opts.cwd ?? resumed?.cwd ?? undefined;
    this.env = opts.env;
    this.rpcMode = opts.rpcMode ?? resumed?.rpc_mode ?? "rpc-ui";
    this.onUIRequest = opts.onUIRequest;
    this._optOnHostRequest = opts.onHostRequest;
    this.command = opts.command;
    this.logDir = opts.logDir ?? null;
    this.logPath = opts.logPath ?? resumed?.log_path ?? null;
    this.sessionDir = opts.sessionDir ?? resumed?.session_dir ?? (this.logDir ? join(this.logDir, agentId, "omp") : null);
    this.sessionId = resumed?.session_id ?? null;
    this.sessionFile = resumed?.session_file ?? null;
    this.startedAt = resumed?.started_at ?? 0;
    this.lastActivity = resumed?.last_activity ?? 0;
    this.messageCount = resumed?.message_count ?? 0;
    this.model = resumed?.model ?? null;
    this.state = resumed ? "idle" : "dead";
    this.autoSuspend = opts.autoSuspend ?? true;
    this.fallbackModel = opts.fallbackModel ?? null;
    this.preamble = opts.preamble ?? null;
    this.own = opts.own ?? [];
    this.denylistRe = (opts.denylist ?? []).map((p) => new RegExp(p, "i"));
    this.preResumeGate = opts.preResumeGate;
    // Wire violation callback from options (used when PiAgent is constructed
    // directly, e.g. in tests; the normal path is server.ts setting onViolation
    // post-construction to combine with its own channel-wiring logic).
    this.onViolation = opts.onViolation;
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
        console.error(`deleg8: could not create session dir ${this.sessionDir}:`, (e as Error).message);
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
    this.stopped = false; // a restart un-does a prior stop
    this.writeChain = Promise.resolve();
    if (!this.logPath && this.logDir) {
      try {
        mkdirSync(this.logDir, { recursive: true });
        this.logPath = join(this.logDir, `${this.agentId}.log`);
      } catch (e) {
        console.error(`deleg8: could not create log dir ${this.logDir}:`, (e as Error).message);
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
          this.state = this.sessionId && !this.stopped ? "idle" : "dead";
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

    // Awaited, unlike captureSession: the tools must exist in omp's registry
    // before the first prompt, or the model's first turn can't see them.
    await this.registerHostTools();
  }

  private async captureSession(): Promise<void> {
    try {
      const res = await this.sendRaw({ id: this.nextId(), type: "get_state" }, { wait: true, timeoutMs: 5_000 });
      if (typeof res === "string") return;
      const data = (res as { data?: unknown }).data ?? res;
      const obj = data as { sessionId?: unknown; sessionFile?: unknown };
      let changed = false;
      if (typeof obj.sessionId === "string") {
        this.sessionId = obj.sessionId;
        changed = true;
      }
      if (typeof obj.sessionFile === "string") {
        this.sessionFile = obj.sessionFile;
        changed = true;
      }
      if (changed) this.notifyStateChange("session");
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
        console.error(`deleg8: get_state failed for ${this.agentId}:`, msg);
      }
    }
  }

  async stop(opts: { force?: boolean; timeoutMs?: number } = {}): Promise<number | null> {
    this.stopped = true;
    this.state = "dead";
    const proc = this.proc;
    if (proc === null) return null;
    const timeoutMs = opts.timeoutMs ?? 5000;
    const force = opts.force ?? false;

    if (proc.exitCode === null && proc.signalCode === null) {
      if (!force) {
        try {
          await this.sendRaw({ type: "abort" }, { wait: false });
        } catch { console.debug(`deleg8: abort send failed for ${this.agentId} (process may have already exited)`); }
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
      } catch { console.debug(`deleg8: readerTask rejected for ${this.agentId} during stop (expected during shutdown)`); }
    }
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
    if (this.sessionId === null) return; // can't resume without sessionId — leave proc alive
    this.state = "idle";
    this.suspendTask = this.suspendProc(opts.timeoutMs).finally(() => this.notifyStateChange("suspend"));
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
      try { await this.readerTask; } catch { console.debug(`deleg8: readerTask rejected for ${this.agentId} during suspend (expected)`); }
    }
  }

  /** Respawn an idle agent against its prior session. No-op if already running. */
  async resume(): Promise<void> {
    if (this.sessionId === null) {
      throw new PiAgentError(`agent ${this.agentId} has no sessionId — cannot resume`);
    }
    // Refuse before touching any state — the agent stays cleanly idle/resumable.
    this.preResumeGate?.();
    if (this.suspendTask) {
      try { await this.suspendTask; } catch { console.warn(`deleg8: suspendTask rejected for ${this.agentId} during resume`); }
      this.suspendTask = null;
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

  /**
   * Advertise `hostTools` to omp so the model can actually call them. Without
   * this the agent has no `msg`/`task_create`/... tool and any attempt to use
   * one is a hallucination. Returns the names omp accepted.
   *
   * Tolerant by design: an omp too old to know `set_host_tools` answers with an
   * error response, which costs the agent its host tools but must not abort the
   * spawn — every other capability still works.
   */
  async registerHostTools(): Promise<string[]> {
    if (this.hostTools.length === 0) return [];
    try {
      const res = await this.sendRaw(
        { id: this.nextId(), type: "set_host_tools", tools: this.hostTools },
        { wait: true, timeoutMs: 10_000 },
      );
      if (typeof res === "string") return [];
      if ((res as { success?: unknown }).success === false) {
        console.error(`deleg8: set_host_tools rejected for ${this.agentId}:`, (res as { error?: unknown }).error);
        return [];
      }
      const data = (res as { data?: { toolNames?: unknown } }).data;
      return Array.isArray(data?.toolNames) ? (data.toolNames as string[]) : [];
    } catch (e) {
      console.error(`deleg8: set_host_tools failed for ${this.agentId}:`, (e as Error).message);
      return [];
    }
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
    if (frame.type === "tool_execution_start") {
      const toolName = typeof frame.toolName === "string" ? frame.toolName.toLowerCase() : "";
      const args = frame.args as Record<string, unknown> | undefined;
      if (FILE_MODIFYING_TOOL_NAMES.has(toolName)) {
        for (const p of extractToolCallPaths(args)) this.modifiedFiles.add(p);
      }

      // ── Denylist check ──────────────────────────────────────────────
      if (this.denylistRe.length > 0) {
        const command = typeof args?.command === "string" ? args.command : "";
        const probe = command ? `${toolName} ${command}` : toolName;
        for (const re of this.denylistRe) {
          if (re.test(probe)) {
            const entry = { seq: this.bufferSeq, toolName, command, pattern: re.source, ts: this.lastActivity };
            this.deniedCommands.push(entry);
            this.onViolation?.(this.agentId, "denied", { ...entry });
            break;
          }
        }
      }

      // ── Write-scope check ───────────────────────────────────────────
      if (this.own.length > 0 && FILE_MODIFYING_TOOL_NAMES.has(toolName)) {
        const paths = extractToolCallPaths(args);
        for (const p of paths) {
          const inScope = this.own.some((pattern) => {
            // Simple glob-to-regex conversion: * matches anything except /
            // ** matches everything; anchored at both ends.
            const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "___DOUBLESTAR___").replace(/\*/g, "[^/]*").replace(/___DOUBLESTAR___/g, ".*");
            return new RegExp(`^${escaped}$`).test(p);
          });
          if (!inScope) {
            const entry = { seq: this.bufferSeq, toolName, path: p, ts: this.lastActivity };
            this.scopeViolations.push(entry);
            this.onViolation?.(this.agentId, "scope", { ...entry });
          }
        }
      }
    }
    // Accumulate running cost from assistant message_end frames — O(1) per frame
    // instead of scanning the full buffer on every list/status call.
    if (frame.type === "message_end") {
      const message = (frame as Record<string, unknown>).message as Record<string, unknown> | undefined;
      if (message?.role === "assistant") {
        const usage = message.usage as Record<string, unknown> | undefined;
        const cost = (usage?.cost as Record<string, unknown> | undefined)?.total;
        if (typeof cost === "number") this.totalCostUsd += cost;
      }
    }
    if (this.logPath && !UNLOGGED_FRAME_TYPES.has(frame.type ?? "")) {
      try {
        const line = summarizeFrameForLog(frame) + "\n";
        const cache = { value: this.logSize, init: this.logSizeInitialized };
        const newSize = rotateLogIfNeeded(this.logPath, line.length, cache);
        this.logSize = cache.value;
        this.logSizeInitialized = cache.init;
        appendFileSync(this.logPath, line);
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

    if (ftype === "agent_end" || ftype === "turn_end") {
      this.onChannelFrame?.(this.agentId, frame, ftype);
    }

    if (ftype === "agent_end") {
      if (this.autoSuspend && this.state === "running" && this.sessionId !== null && this.sessionDir !== null) {
        // agent_end fires once after omp's full agentic loop completes (all
        // tool-call cycles done). turn_end fires after each individual cycle
        // and is NOT a completion signal.
        this.state = "idle";
        this.notifyStateChange("agent_end");
        this.suspendTask = this.suspendProc().finally(() => this.notifyStateChange("suspend"));
        return;
      }
      this.notifyStateChange("agent_end");
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
      console.error(`deleg8: UI request handler threw for ${this.agentId} — declining`);
      await this.safeWrite({ type: "extension_ui_response", id, cancelled: true });
    }
  }
  
  private async handleHostRequest(request: Frame): Promise<void> {
    const id = typeof request.id === "string" ? request.id : "";
    if (!id) return;
    // Public per-agent handler (set by server.ts spawn handler for msg/task tools).
    if (this.onHostRequest) {
      try {
        const response = await this.onHostRequest(this.agentId, request);
        if (response) {
          await this.safeWrite(response);
          return;
        }
      } catch {
        console.error(`deleg8: onHostRequest first handler threw for ${this.agentId}`);
        /* fall through */
      }
    }
    // Legacy options-level handler.
    if (this._optOnHostRequest) {
      try {
        const response = await this._optOnHostRequest(request);
        if (response) {
          await this.safeWrite(response);
          return;
        }
      } catch {
        console.error(`deleg8: onHostRequest legacy handler threw for ${this.agentId}`);
        /* fall through to error response */
      }
    }
    // Default: refuse so omp doesn't hang. Shape depends on the request type.
    if (request.type === "host_tool_call") {
      const toolName = typeof request.toolName === "string" ? request.toolName : "?";
      await this.safeWrite({
        type: "host_tool_result",
        id,
        isError: true,
        // AgentToolResult requires an array `content`; a bare error object is
        // rejected by omp and the tool call hangs instead of failing.
        result: {
          content: [{ type: "text", text: `deleg8 has no handler for host tool "${toolName}"` }],
          details: {},
        },
      });
    } else if (request.type === "host_uri_request") {
      await this.safeWrite({
        type: "host_uri_result",
        id,
        isError: true,
        error: "deleg8 registered no host URI schemes",
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
      console.debug(`deleg8: safeWrite failed for ${this.agentId} (expected if process already exited)`);
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
      this.state = this.sessionId && !this.stopped ? "idle" : "dead";
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
      denied_count: this.deniedCommands.length,
      scope_violations: this.scopeViolations.length,
    };
  }

  snapshot(): AgentSnapshot {
    const status = this.status();
    return {
      agent_id: this.agentId,
      session_id: status.session_id,
      session_file: status.session_file,
      session_dir: status.session_dir,
      log_path: status.log_path,
      cwd: this.cwd ?? null,
      extra_args: [...this.extraArgs],
      rpc_mode: this.rpcMode,
      model: status.model,
      started_at: status.started_at,
      last_activity: status.last_activity,
      message_count: status.message_count,
    };
  }
  
  costUsd(): number {
    return this.totalCostUsd;
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
  private notifyStateChange(event: "session" | "agent_end" | "suspend"): void {
    try {
      this.onStateChange?.(this, event);
    } catch (error) {
      console.error(`[deleg8] lifecycle callback failed for ${this.agentId}:`, error);
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
