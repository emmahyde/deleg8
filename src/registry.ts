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

  constructor(opts: RegistryOptions = {}) {
    this.binary = opts.binary ?? "omp";
    this.onUIRequest = opts.onUIRequest;
    this.logDir = opts.logDir;
  }

  async spawn(opts: SpawnOptions = {}): Promise<PiAgent> {
    const aid = opts.agentId ?? this.autoId();
    if (!ID_RE.test(aid)) {
      throw new PiAgentError(`invalid agent_id ${aid} — must match ${ID_RE.source}`);
    }
    const existing = this.agents.get(aid);
    if (existing) {
      const state = existing.status().state;
      // running: refuse — same id can't have two live procs.
      // idle: refuse — agent is paused mid-session; caller should pi_send
      //   to resume or pi_stop({remove: true}) to discard.
      // dead: ok to replace transparently — proc gone and no resumable session.
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
    return await this.get(agentId).stop({ force: opts.force });
  }

  remove(agentId: string): void {
    this.agents.delete(agentId);
  }

  /** Remove every agent matching one of the given states. Returns removed ids. */
  prune(states: Array<"idle" | "dead"> = ["dead"]): string[] {
    const removed: string[] = [];
    for (const [id, agent] of this.agents) {
      if (states.includes(agent.status().state as "idle" | "dead")) {
        this.agents.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  async stopAll(opts: { force?: boolean } = {}): Promise<void> {
    await Promise.allSettled(this.list().map((a) => a.stop({ force: opts.force })));
  }

  private autoId(): string {
    AUTO_ID += 1;
    return `pi-${String(AUTO_ID).padStart(3, "0")}`;
  }
}
