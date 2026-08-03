// AgentRegistry capacity + reaping guards, exercised through the real spawn
// path with mock-omp via the `spawnCommand` override. These gates exist
// because an uncapped fan-out (~15 concurrent omp processes) exhausted RAM +
// swap and kernel-panicked the host on 2026-07-25.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../src/registry.ts";

const MOCK_PATH = new URL("./fixtures/mock-omp.ts", import.meta.url).pathname;

interface Ctx {
  registry: AgentRegistry;
  logDir: string;
}

function makeRegistry(opts: Partial<ConstructorParameters<typeof AgentRegistry>[0]> = {}): Ctx {
  const logDir = mkdtempSync(join(tmpdir(), "pi-registry-test-"));
  const registry = new AgentRegistry({
    spawnCommand: ["bun", "run", MOCK_PATH],
    logDir,
    minFreeMemPct: 0, // memory gate off unless a test opts in
    ...opts,
  });
  return { registry, logDir };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("AgentRegistry capacity guards", () => {
  const ctxs: Ctx[] = [];
  afterEach(async () => {
    for (const c of ctxs.splice(0)) {
      c.registry.stopReap();
      await c.registry.stopAll({ force: true }).catch(() => {});
      try { rmSync(c.logDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test("spawn past maxAgents is rejected until capacity frees", async () => {
    const c = makeRegistry({ maxAgents: 2 });
    ctxs.push(c);
    await c.registry.spawn({ agentId: "a1" });
    await c.registry.spawn({ agentId: "a2" });
    expect(c.registry.runningCount()).toBe(2);

    expect(c.registry.spawn({ agentId: "a3" })).rejects.toThrow(/max 2/);

    await c.registry.stop("a1");
    await c.registry.spawn({ agentId: "a3" });
    expect(c.registry.runningCount()).toBe(2);
  });

  test("concurrent spawns count in-flight starts against the cap", async () => {
    const c = makeRegistry({ maxAgents: 2 });
    ctxs.push(c);
    const results = await Promise.allSettled(
      ["c1", "c2", "c3", "c4"].map((id) => c.registry.spawn({ agentId: id })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(2);
    expect(failed.length).toBe(2);
    for (const f of failed as PromiseRejectedResult[]) {
      expect(String(f.reason)).toMatch(/max 2/);
    }
  });

  test("resume of an idle agent is gated by the same cap", async () => {
    const c = makeRegistry({ maxAgents: 1 });
    ctxs.push(c);
    const a1 = await c.registry.spawn({ agentId: "r1" });
    // A completed turn auto-suspends the agent (agent_end → idle, proc killed).
    await a1.sendPrompt("hello");
    await waitFor(() => a1.status().state === "idle");

    await c.registry.spawn({ agentId: "r2" }); // fills the single slot
    expect(c.registry.runningCount()).toBe(1);

    expect(a1.sendPrompt("wake up")).rejects.toThrow(/resume r1 rejected/);
    expect(a1.status().state).toBe("idle"); // still cleanly resumable later
  });

  test("memory gate refuses spawns below the floor and fails open on unknown", async () => {
    const low = makeRegistry({ minFreeMemPct: 15, readFreeMemPct: () => 5 });
    ctxs.push(low);
    expect(low.registry.spawn({ agentId: "m1" })).rejects.toThrow(/free memory 5%/);

    const unknown = makeRegistry({ minFreeMemPct: 15, readFreeMemPct: () => null });
    ctxs.push(unknown);
    await unknown.registry.spawn({ agentId: "m2" }); // fail open
    expect(unknown.registry.runningCount()).toBe(1);
  });

  test("idle/dead TTLs default to 1h and setTTL updates partially", () => {
    const c = makeRegistry();
    ctxs.push(c);
    expect(c.registry.ttls).toEqual({ idle: 3_600_000, dead: 3_600_000 });

    c.registry.setTTL(0, undefined); // disable idle reap, keep dead
    expect(c.registry.ttls).toEqual({ idle: 0, dead: 3_600_000 });

    c.registry.setTTL(undefined, 60_000);
    expect(c.registry.ttls).toEqual({ idle: 0, dead: 60_000 });
  });
});
