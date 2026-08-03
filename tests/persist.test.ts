import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiAgent } from "../src/agent.ts";
import type { Frame } from "../src/frames.ts";
import { AgentRegistry } from "../src/registry.ts";
import {
  drainEvents,
  enqueueEvent,
  loadRegistrySnapshots,
  saveRegistry,
  type AgentSnapshot,
  type QueuedEvent,
} from "../src/persist.ts";

const MOCK_PATH = new URL("./fixtures/mock-omp.ts", import.meta.url).pathname;
const roots: string[] = [];
const registries: AgentRegistry[] = [];

function makeRoot(prefix = "deleg8-persist-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function makeSnapshot(sessionDir: string, overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  mkdirSync(sessionDir, { recursive: true });
  return {
    agent_id: "persisted-agent",
    session_id: "mock-session",
    session_dir: sessionDir,
    session_file: join(sessionDir, "mock-session.jsonl"),
    log_path: join(sessionDir, "agent.log"),
    cwd: null,
    extra_args: [],
    rpc_mode: "rpc-ui",
    model: "openai/gpt-5",
    started_at: 100,
    last_activity: 200,
    message_count: 2,
    ...overrides,
  };
}

function makeRegistry(logDir: string): AgentRegistry {
  const registry = new AgentRegistry({
    spawnCommand: ["bun", "run", MOCK_PATH],
    logDir,
    idleTTL: 0,
    deadTTL: 0,
    minFreeMemPct: 0,
  });
  registries.push(registry);
  return registry;
}

function waitForAgentEvent(agent: PiAgent, event: "session" | "suspend"): Promise<void> {
  const status = agent.status();
  if ((event === "session" && status.session_id !== null) || (event === "suspend" && status.state === "idle")) {
    return Promise.resolve();
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  const previous = agent.onStateChange;
  agent.onStateChange = (changedAgent, changedEvent) => {
    previous?.(changedAgent, changedEvent);
    if (changedEvent === event) resolve();
  };
  const current = agent.status();
  if ((event === "session" && current.session_id !== null) || (event === "suspend" && current.state === "idle")) {
    resolve();
  }
  return promise;
}

function responseData(frame: Frame | string): Record<string, unknown> {
  if (typeof frame === "string") throw new Error(`expected response frame, got ${frame}`);
  const data = frame.data;
  if (!data || typeof data !== "object") throw new Error(`response has no data: ${JSON.stringify(frame)}`);
  return data as Record<string, unknown>;
}


afterEach(async () => {
  for (const registry of registries.splice(0)) {
    registry.stopReap();
    await registry.stopAll({ force: true }).catch(() => {});
  }
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("registry persistence", () => {
  test("save → load preserves resumable snapshots", () => {
    const root = makeRoot();
    const sessionDir = join(root, "session-old", "agent", "omp");
    const snapshot = makeSnapshot(sessionDir);
    const statePath = join(root, "session-old", "registry.json");

    saveRegistry(statePath, {
      session: "session-old",
      server_pid: process.pid,
      saved_at: 1234,
      agents: [snapshot],
    });

    const file = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    expect(file.version).toBe(1);
    expect(file.server_pid).toBe(process.pid);
    expect(file.session).toBe("session-old");
    expect(file.saved_at).toBe(1234);
    expect(loadRegistrySnapshots(root)).toEqual([snapshot]);
  });

  test("skips a registry written by a live foreign server", () => {
    const root = makeRoot();
    const sessionDir = join(root, "session-live", "agent", "omp");
    const statePath = join(root, "session-live", "registry.json");
    const foreignPid = process.ppid;
    expect(foreignPid).not.toBe(process.pid);

    saveRegistry(statePath, {
      session: "session-live",
      server_pid: foreignPid,
      agents: [makeSnapshot(sessionDir)],
    });

    expect(loadRegistrySnapshots(root)).toEqual([]);
  });

  test("adopted idle agent resumes against mock omp", async () => {
    const root = makeRoot();
    const oldLogDir = join(root, "session-old");
    const previous = makeRegistry(oldLogDir);
    const original = await previous.spawn({ agentId: "adopted-1" });
    await waitForAgentEvent(original, "session");
    const suspended = waitForAgentEvent(original, "suspend");
    await original.sendPrompt("first", { wait: true, timeoutMs: 5000 });
    await suspended;

    const next = makeRegistry(join(root, "session-new"));
    const adopted = next.adoptPersisted(root);
    expect(adopted).toHaveLength(1);
    expect(adopted[0]!.agentId).toBe("adopted-1");
    expect(adopted[0]!.status().state).toBe("idle");
    expect(adopted[0]!.status().session_id).toBe(original.status().session_id);

    const response = await adopted[0]!.sendPrompt("COUNT", { wait: true, timeoutMs: 5000 });
    const data = responseData(response);
    expect(data.turn_count).toBe(2);
  }, 15_000);
});

describe("queued notifications", () => {
  test("enqueue → drain delivers prefixed event and deletes file", async () => {
    const root = makeRoot();
    const sessionDir = join(root, "session-events");
    const delivered: QueuedEvent[] = [];
    enqueueEvent(sessionDir, {
      method: "notifications/claude/channel",
      params: { content: "agent finished", meta: { agent_id: "a1" } },
    });
    expect(existsSync(join(sessionDir, "events.ndjson"))).toBe(true);

    const count = await drainEvents(root, (event) => delivered.push(event));

    expect(count).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.method).toBe("notifications/claude/channel");
    expect(delivered[0]!.params.content).toBe("[deleg8 queued from previous session] agent finished");
    expect(existsSync(join(sessionDir, "events.ndjson"))).toBe(false);
  });

  test("failed delivery remains queued for a later boot", async () => {
    const root = makeRoot();
    const sessionDir = join(root, "session-retry");
    enqueueEvent(sessionDir, {
      method: "notifications/claude/channel",
      params: { content: "retry me" },
    });

    await drainEvents(root, async () => {
      throw new Error("transport unavailable");
    });

    expect(existsSync(join(sessionDir, "events.ndjson"))).toBe(true);
  });
});
