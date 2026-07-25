// AgentRegistry — directory of named, live PiAgent subprocesses.

import { PiAgent, PiAgentError } from "./agent.ts";
import type { Frame } from "./frames.ts";

const ID_RE = /^[a-zA-Z0-9_.\-]{1,64}$/;
let AUTO_ID = 0;

export interface RegistryOptions {
  binary?: string;
  /** Default UI-request handler injected into every spawned agent. */
  onUIRequest?: (req: Frame) => Promise<Frame | null>;
  /** Directory each agent writes its `<agentId>.log` NDJSON into. Omit to disable logging. */
  logDir?: string;
  /**
   * Auto-reap idle agents after N ms of inactivity after their last agent_end.
   * 0 (default) = no auto-reap.
   */
  idleTTL?: number;
  /**
   * Auto-reap dead agents after N ms. 0 (default) = no auto-reap.
   */
  deadTTL?: number;
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
    this.idleTTL = opts.idleTTL ?? 0;
    this.deadTTL = opts.deadTTL ?? 0;
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

  /** Update idle/dead TTL at runtime (e.g. from spawn config). */
  setTTL(idleTTL: number, deadTTL: number): void {
    this.idleTTL = idleTTL;
    this.deadTTL = deadTTL;
    if ((idleTTL > 0 || deadTTL > 0) && !this.reapInterval) {
      this.startReap();
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
    }
    const agent = new PiAgent(aid, {
      binary: this.binary,
      extraArgs: opts.extraArgs,
      cwd: opts.cwd,
      rpcMode: opts.rpcMode,
      onUIRequest: this.onUIRequest,
      logDir: this.logDir,
    });
    await agent.start();
    this.agents.set(aid, agent);
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

  async stop(agentId: string, opts: { force?: boolean } = {}): Promise<number | null> {
    const agent = this.get(agentId);
    const code = await agent.stop({ force: opts.force });
    this.releaseAgentLocks(agentId);
    return code;
  }

  remove(agentId: string): void {
    this.agents.delete(agentId);
    this.releaseAgentLocks(agentId);
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
    return removed;
  }

  async stopAll(opts: { force?: boolean } = {}): Promise<void> {
    await Promise.allSettled(this.list().map((a) => a.stop({ force: opts.force })));
    this.exclusiveLocks.clear();
    this.exclusiveQueue.clear();
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
    for (const [id, agent] of this.agents) {
      const s = agent.status();
      const sinceLast = now - s.last_activity;
      if (s.state === "idle" && this.idleTTL > 0 && sinceLast > this.idleTTL) {
        this.agents.delete(id);
        this.releaseAgentLocks(id);
        this.onReap?.(id, "idle");
      } else if (s.state === "dead" && this.deadTTL > 0 && sinceLast > this.deadTTL) {
        this.agents.delete(id);
        this.releaseAgentLocks(id);
        this.onReap?.(id, "dead");
      }
    }
  }

  private autoId(): string {
    AUTO_ID += 1;
    return `pi-${String(AUTO_ID).padStart(3, "0")}`;
  }
}
