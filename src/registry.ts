// AgentRegistry — directory of named, live PiAgent subprocesses.

import { PiAgent, PiAgentError } from "./agent.ts";
import type { Frame } from "./frames.ts";
import { basename, dirname, join } from "node:path";
import { loadRegistrySnapshots, saveRegistry } from "./persist.ts";

const ID_RE = /^[a-zA-Z0-9_.\-]{1,64}$/;
let AUTO_ID = 0;

// Each omp subprocess is a full LLM CLI (hundreds of MB to GB resident). An
// uncapped fan-out exhausted RAM + swap and kernel-panicked a 16GB machine on
// 2026-07-25 (~15 concurrent agents). These defaults are the safety net.
const DEFAULT_MAX_AGENTS = 6;
const DEFAULT_MIN_FREE_MEM_PCT = 15;
const DEFAULT_TTL_MS = 3_600_000; // 1h — idle/dead entries reaped by default

/**
 * System-wide free-memory percentage, or null when unknowable (non-macOS,
 * command missing, output changed). Callers must fail open on null.
 */
function readFreeMemPctDefault(): number | null {
  try {
    const res = Bun.spawnSync(["memory_pressure", "-Q"], { stderr: "ignore" });
    if (!res.success) return null;
    const m = res.stdout.toString().match(/free percentage:\s*(\d+)%/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export interface RegistryOptions {
  binary?: string;
  /** Default UI-request handler injected into every spawned agent. */
  onUIRequest?: (req: Frame) => Promise<Frame | null>;
  /** Directory each agent writes its `<agentId>.log` NDJSON into. Omit to disable logging. */
  logDir?: string;
  /** Explicit registry state path. Defaults to `<logDir>/registry.json`. */
  statePath?: string;
  /**
   * Auto-reap idle agents after N ms of inactivity after their last agent_end.
   * Default 1h; 0 = no auto-reap.
   */
  idleTTL?: number;
  /**
   * Auto-reap dead agents after N ms. Default 1h; 0 = no auto-reap.
   */
  deadTTL?: number;
  /**
   * Maximum agents with a live subprocess (running + mid-start). Spawn and
   * resume are rejected past the cap. Default 6; 0 = uncapped.
   */
  maxAgents?: number;
  /**
   * Refuse to start a subprocess when system free memory is below this
   * percentage. Default 15; 0 = disabled. Unknowable free memory (non-macOS)
   * fails open.
   */
  minFreeMemPct?: number;
  /** Test hook: replaces the `memory_pressure -Q` reader. */
  readFreeMemPct?: () => number | null;
  /**
   * Test hook: full argv passed to every spawned PiAgent as its `command`
   * override, replacing binary+rpcMode (e.g. ["bun", "run", mockPath]).
   */
  spawnCommand?: string[];
  /**
   * Called when an agent is auto-reaped (idle/dead TTL expiry).
   */
  onReap?: (agentId: string, state: "idle" | "dead") => void;
  /**
   * Declare command patterns as exclusive — only one agent may hold the lock
   * at a time. Agents acquire/release via the `exclusive_acquire` /
   * `exclusive_release` host tools (wired by the spawn handler).
   * `pattern` is a case-insensitive regex matched against the command string;
   * `wait: true` queues the caller, `wait: false` rejects immediately.
   */
  exclusive?: Array<{ pattern: string; wait: boolean }>;
}

export interface SpawnOptions {
  agentId?: string;
  extraArgs?: string[];
  cwd?: string;
  rpcMode?: "rpc" | "rpc-ui";
}

export class AgentRegistry {
  private readonly agents = new Map<string, PiAgent>();
  private readonly binary: string;
  private readonly onUIRequest: ((req: Frame) => Promise<Frame | null>) | undefined;
  private readonly logDir: string | undefined;
  private idleTTL: number;
  private deadTTL: number;
  private readonly maxAgents: number;
  private readonly minFreeMemPct: number;
  private readonly readFreeMemPct: () => number | null;
  private readonly spawnCommand: string[] | undefined;
  private readonly statePath: string | undefined;
  /** Spawns past assertCapacity but not yet registered — counted against the cap. */
  private inFlightStarts = 0;
  private readonly onReap: ((agentId: string, state: "idle" | "dead") => void) | undefined;
  readonly exclusive: ReadonlyArray<{ pattern: string; wait: boolean }>;

  /** Maps exclusive pattern → agentId currently holding the lock. */
  readonly exclusiveLocks: Map<string, string> = new Map();
  /** Maps exclusive pattern → queue of agentIds waiting for the lock (wait: true only). */
  readonly exclusiveQueue: Map<string, string[]> = new Map();

  /** Pre-compiled exclusive-pattern regexes for fast matching. */
  private readonly exclusiveRe: Array<{ compiled: RegExp; wait: boolean; pattern: string }> = [];

  private reapInterval: Timer | null = null;

  constructor(opts: RegistryOptions = {}) {
    this.binary = opts.binary ?? "omp";
    this.onUIRequest = opts.onUIRequest;
    this.logDir = opts.logDir;
    this.statePath = opts.statePath ?? (this.logDir ? join(this.logDir, "registry.json") : undefined);
    this.idleTTL = opts.idleTTL ?? DEFAULT_TTL_MS;
    this.deadTTL = opts.deadTTL ?? DEFAULT_TTL_MS;
    this.maxAgents = opts.maxAgents ?? DEFAULT_MAX_AGENTS;
    this.minFreeMemPct = opts.minFreeMemPct ?? DEFAULT_MIN_FREE_MEM_PCT;
    this.readFreeMemPct = opts.readFreeMemPct ?? readFreeMemPctDefault;
    this.spawnCommand = opts.spawnCommand;
    this.onReap = opts.onReap;
    this.exclusive = opts.exclusive ?? [];
    this.exclusiveRe = opts.exclusive?.map((e) => ({
      compiled: new RegExp(e.pattern, "i"),
      wait: e.wait,
      pattern: e.pattern,
    })) ?? [];
    if (this.idleTTL > 0 || this.deadTTL > 0) {
      this.startReap();
    }
  }

  /**
   * Update idle/dead TTL at runtime (e.g. from spawn config). An undefined
   * value keeps the current setting; an explicit 0 disables that reap.
   */
  setTTL(idleTTL?: number, deadTTL?: number): void {
    this.idleTTL = idleTTL ?? this.idleTTL;
    this.deadTTL = deadTTL ?? this.deadTTL;
    if ((this.idleTTL > 0 || this.deadTTL > 0) && !this.reapInterval) {
      this.startReap();
    }
  }

  /** Current TTL settings (ms). */
  get ttls(): { idle: number; dead: number } {
    return { idle: this.idleTTL, dead: this.deadTTL };
  }

  getLogDir(): string | undefined {
    return this.logDir;
  }

  persist(): void {
    if (!this.statePath) return;
    try {
      saveRegistry(this.statePath, {
        session: basename(this.logDir ?? dirname(this.statePath)),
        agents: this.list().map((agent) => agent.snapshot()),
      });
    } catch (error) {
      console.error(`[deleg8] registry persistence failed at ${this.statePath}:`, error);
    }
  }

  /** Agents whose subprocess is live (state "running"). */
  runningCount(): number {
    return this.list().filter((a) => a.status().state === "running").length;
  }

  /**
   * Throw unless another subprocess may start. Guards both spawn and resume —
   * the two paths that create an omp process. `action` names the caller for
   * the error message.
   */
  assertCapacity(action: string): void {
    const live = this.runningCount() + this.inFlightStarts;
    if (this.maxAgents > 0 && live >= this.maxAgents) {
      throw new PiAgentError(
        `${action} rejected: ${live} agents already running or starting (max ${this.maxAgents}). ` +
          `Wait for one to finish, stop one, or raise DELEG8_MAX_AGENTS.`,
      );
    }
    if (this.minFreeMemPct > 0) {
      const pct = this.readFreeMemPct();
      if (pct !== null && pct < this.minFreeMemPct) {
        throw new PiAgentError(
          `${action} rejected: system free memory ${pct}% is below the ${this.minFreeMemPct}% floor. ` +
            `Stop agents or free memory, or lower DELEG8_MIN_FREE_MEM_PCT (0 disables).`,
        );
      }
    }
  }

  /** Update exclusive patterns at runtime. */
  setExclusive(patterns: Array<{ pattern: string; wait: boolean }>): void {
    this.exclusiveRe.splice(0, this.exclusiveRe.length, ...patterns.map((e) => ({
      compiled: new RegExp(e.pattern, "i"),
      wait: e.wait,
      pattern: e.pattern,
    })));
    (this.exclusive as any).splice(0, this.exclusive.length, ...patterns);
  }

  /**
   * Check whether a command string matches any registered exclusive pattern.
   * Returns the matching entry or null.
   */
  matchExclusive(command: string): { pattern: string; wait: boolean; compiled: RegExp } | null {
    for (const entry of this.exclusiveRe) {
      if (entry.compiled.test(command)) return entry;
    }
    return null;
  }

  /**
   * Attempt to acquire an exclusive lock. Returns true if acquired, false if
   * another agent already holds it (queue the caller if wait: true).
   */
  acquireExclusive(pattern: string, agentId: string): boolean {
    const holder = this.exclusiveLocks.get(pattern);
    if (holder === agentId) return true; // already held by this agent
    if (holder !== undefined) {
      // Someone else holds the lock — queue if wait: true
      const info = this.exclusiveRe.find((e) => e.pattern === pattern);
      if (info?.wait) {
        const queue = this.exclusiveQueue.get(pattern) ?? [];
        if (!queue.includes(agentId)) queue.push(agentId);
        this.exclusiveQueue.set(pattern, queue);
      }
      return false;
    }
    this.exclusiveLocks.set(pattern, agentId);
    return true;
  }

  /**
   * Release an exclusive lock. If a queued agent is waiting, it acquires next.
   * Returns the agentId that now holds the lock, or null if no one is waiting.
   */
  releaseExclusive(pattern: string, agentId: string): string | null {
    const holder = this.exclusiveLocks.get(pattern);
    if (holder !== agentId) return null; // not the holder — no-op
    this.exclusiveLocks.delete(pattern);

    // Dequeue next waiter
    const queue = this.exclusiveQueue.get(pattern);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) this.exclusiveQueue.delete(pattern);
      else this.exclusiveQueue.set(pattern, queue);
      this.exclusiveLocks.set(pattern, next);
      return next;
    }
    return null;
  }

  /**
   * Release every exclusive lock held by `agentId`. Called on stop/remove.
   */
  releaseAgentLocks(agentId: string): void {
    for (const [pattern, holder] of this.exclusiveLocks) {
      if (holder === agentId) {
        this.releaseExclusive(pattern, agentId);
      }
    }
    // Also clean any queue entries referencing this agent
    for (const [pattern, queue] of this.exclusiveQueue) {
      const filtered = queue.filter((id) => id !== agentId);
      if (filtered.length === 0) this.exclusiveQueue.delete(pattern);
      else this.exclusiveQueue.set(pattern, filtered);
    }
  }

  async spawn(opts: SpawnOptions = {}): Promise<PiAgent> {
    const aid = opts.agentId ?? this.autoId();
    if (!ID_RE.test(aid)) {
      throw new PiAgentError(`invalid agent_id ${aid} — must match ${ID_RE.source}`);
    }
    const existing = this.agents.get(aid);
    if (existing) {
      const state = existing.status().state;
      if (state !== "dead") {
        throw new PiAgentError(
          `agent ${aid} already exists (state=${state}). ` +
            `Use pi_send to resume an idle agent, or pi_stop({remove: true}) to discard.`,
        );
      }
      this.agents.delete(aid);
      this.persist();
    }
    this.assertCapacity(`spawn ${aid}`);
    const agent = new PiAgent(aid, {
      binary: this.binary,
      command: this.spawnCommand,
      extraArgs: opts.extraArgs,
      cwd: opts.cwd,
      rpcMode: opts.rpcMode,
      onUIRequest: this.onUIRequest,
      logDir: this.logDir,
      // Resume respawns the subprocess, so it counts against the same cap.
      preResumeGate: () => this.assertCapacity(`resume ${aid}`),
    });
    agent.onStateChange = () => this.persist();
    this.inFlightStarts += 1;
    try {
      await agent.start();
      this.agents.set(aid, agent);
      this.persist();
    } finally {
      this.inFlightStarts -= 1;
    }
    return agent;
  }

  get(agentId: string): PiAgent {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new PiAgentError(`no agent named ${agentId} — call pi_list to see active agents`);
    }
    return agent;
  }

  list(): PiAgent[] {
    return Array.from(this.agents.values());
  }

  adoptPersisted(root: string): PiAgent[] {
    const adopted: PiAgent[] = [];
    for (const snapshot of loadRegistrySnapshots(root)) {
      if (!ID_RE.test(snapshot.agent_id) || this.agents.has(snapshot.agent_id)) continue;
      const agent = new PiAgent(snapshot.agent_id, {
        binary: this.binary,
        command: this.spawnCommand,
        onUIRequest: this.onUIRequest,
        logDir: this.logDir,
        resumeState: snapshot,
        preResumeGate: () => this.assertCapacity(`resume ${snapshot.agent_id}`),
      });
      agent.onStateChange = () => this.persist();
      this.agents.set(snapshot.agent_id, agent);
      adopted.push(agent);
    }
    if (adopted.length > 0) this.persist();
    return adopted;
  }

  async stop(agentId: string, opts: { force?: boolean } = {}): Promise<number | null> {
    const agent = this.get(agentId);
    const code = await agent.stop({ force: opts.force });
    this.releaseAgentLocks(agentId);
    this.persist();
    return code;
  }

  remove(agentId: string): void {
    this.agents.delete(agentId);
    this.releaseAgentLocks(agentId);
    this.persist();
  }

  /** Remove every agent matching one of the given states. Returns removed ids. */
  prune(states: Array<"idle" | "dead"> = ["dead"]): string[] {
    const removed: string[] = [];
    for (const [id, agent] of this.agents) {
      if (states.includes(agent.status().state as "idle" | "dead")) {
        this.agents.delete(id);
        this.releaseAgentLocks(id);
        removed.push(id);
      }
    }
    if (removed.length > 0) this.persist();
    return removed;
  }

  async stopAll(opts: { force?: boolean } = {}): Promise<void> {
    await Promise.allSettled(this.list().map((a) => a.stop({ force: opts.force })));
    this.exclusiveLocks.clear();
    this.exclusiveQueue.clear();
    this.persist();
  }

  // ── auto-reap ─────────────────────────────────────────────────────────

  private startReap(): void {
    if (this.reapInterval) return;
    this.reapInterval = setInterval(() => this.tickReap(), 10_000).unref();
  }

  stopReap(): void {
    if (this.reapInterval) {
      clearInterval(this.reapInterval);
      this.reapInterval = null;
    }
  }

  private tickReap(): void {
    const now = Date.now();
    let removed = false;
    for (const [id, agent] of this.agents) {
      const s = agent.status();
      const sinceLast = now - s.last_activity;
      if (s.state === "idle" && this.idleTTL > 0 && sinceLast > this.idleTTL) {
        this.agents.delete(id);
        this.releaseAgentLocks(id);
        this.onReap?.(id, "idle");
        removed = true;
      } else if (s.state === "dead" && this.deadTTL > 0 && sinceLast > this.deadTTL) {
        this.agents.delete(id);
        this.releaseAgentLocks(id);
        this.onReap?.(id, "dead");
        removed = true;
      }
    }
    if (removed) this.persist();
  }

  private autoId(): string {
    AUTO_ID += 1;
    return `pi-${String(AUTO_ID).padStart(3, "0")}`;
  }
}
