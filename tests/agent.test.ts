import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PiAgent, type PiAgentOptions } from "../src/agent.ts";
import type { Frame } from "../src/frames.ts";

const MOCK_PATH = new URL("./fixtures/mock-omp.ts", import.meta.url).pathname;

async function waitFor(predicate: () => boolean, timeoutMs = 1000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for predicate`);
}

const tracked: PiAgent[] = [];

afterEach(async () => {
  for (const a of tracked.splice(0)) {
    try {
      await a.stop({ timeoutMs: 2000 });
    } catch {
      /* already gone */
    }
  }
});

let agentSeq = 0;
function makeAgent(opts: Partial<PiAgentOptions> = {}): PiAgent {
  // No logDir passed → no on-disk log written during tests.
  const a = new PiAgent(`mock-${++agentSeq}`, {
    command: ["bun", "run", MOCK_PATH],
    ...opts,
  });
  tracked.push(a);
  return a;
}

function data(frame: Frame | string): Record<string, unknown> {
  if (typeof frame === "string") throw new Error(`expected frame, got string: ${frame}`);
  const d = frame.data;
  if (!d || typeof d !== "object") throw new Error(`response has no data: ${JSON.stringify(frame)}`);
  return d as Record<string, unknown>;
}

describe("PiAgent over mock omp", () => {
  test(
    "start → running, pid set, exit_code null",
    async () => {
      const a = makeAgent();
      await a.start();
      const s = a.status();
      expect(s.running).toBe(true);
      expect(s.pid).not.toBeNull();
      expect(s.exit_code).toBeNull();
    },
    10_000,
  );

  test(
    "sendPrompt round-trips and correlates by id",
    async () => {
      const a = makeAgent();
      await a.start();
      const r = await a.sendPrompt("hello", { wait: true, timeoutMs: 5000 });
      expect(typeof r).toBe("object");
      expect((r as Frame).type).toBe("response");
      expect(data(r).echo).toBe("hello");
    },
    10_000,
  );

  test(
    "two concurrent prompts get the right responses",
    async () => {
      const a = makeAgent();
      await a.start();
      const [r1, r2] = await Promise.all([
        a.sendPrompt("one", { wait: true, timeoutMs: 5000 }),
        a.sendPrompt("two", { wait: true, timeoutMs: 5000 }),
      ]);
      expect(data(r1).echo).toBe("one");
      expect(data(r2).echo).toBe("two");
    },
    10_000,
  );

  test(
    "UI request: select → onUIRequest invoked, response flows back to prompt",
    async () => {
      let captured: Frame | null = null;
      const a = makeAgent({
        onUIRequest: async (req) => {
          captured = req;
          return { type: "extension_ui_response", id: String(req.id), value: "b" };
        },
      });
      await a.start();
      const r = await a.sendPrompt("ASK:select:a,b,c", { wait: true, timeoutMs: 5000 });
      expect(captured?.method).toBe("select");
      expect(captured?.options).toEqual(["a", "b", "c"]);
      expect(data(r).user_picked).toBe("b");
    },
    10_000,
  );

  test(
    "UI request: confirm carries boolean back through prompt response",
    async () => {
      const a = makeAgent({
        onUIRequest: async (req) => ({
          type: "extension_ui_response",
          id: String(req.id),
          confirmed: true,
        }),
      });
      await a.start();
      const r = await a.sendPrompt("ASK:confirm", { wait: true, timeoutMs: 5000 });
      expect(data(r).user_confirmed).toBe(true);
    },
    10_000,
  );

  test(
    "UI request with no handler → auto-cancellation reaches mock",
    async () => {
      const a = makeAgent(); // no onUIRequest
      await a.start();
      const r = await a.sendPrompt("ASK:input", { wait: true, timeoutMs: 5000 });
      // Mock relays a cancelled UI response as data.user_input = {cancelled: true}.
      expect(data(r).user_input).toEqual({ cancelled: true });
    },
    10_000,
  );

  test(
    "passive UI frame (notify) is buffered, doesn't invoke handler",
    async () => {
      let called = 0;
      const a = makeAgent({
        onUIRequest: async () => {
          called += 1;
          return null;
        },
      });
      await a.start();
      const r = await a.sendPrompt("NOTIFY hi", { wait: true, timeoutMs: 5000 });
      expect(called).toBe(0);
      expect(data(r).echo).toBe("NOTIFY hi");
      const seen = a.output().map((f) => f.frame.method);
      expect(seen).toContain("notify");
    },
    10_000,
  );

  test(
    "stop() terminates the subprocess and flips running to false",
    async () => {
      const a = makeAgent();
      await a.start();
      expect(a.status().running).toBe(true);
      await a.stop({ timeoutMs: 2000 });
      expect(a.status().running).toBe(false);
    },
    10_000,
  );

  test(
    "sendPrompt after stop rejects with PiAgentError",
    async () => {
      const a = makeAgent();
      await a.start();
      await a.stop({ timeoutMs: 2000 });
      await expect(a.sendPrompt("nope", { wait: true, timeoutMs: 1000 })).rejects.toThrow();
    },
    10_000,
  );

  test(
    "output({sinceSeq}) returns only newer frames",
    async () => {
      const a = makeAgent();
      await a.start();
      await a.sendPrompt("first", { wait: true, timeoutMs: 5000 });
      const before = a.output();
      const lastSeq = before[before.length - 1]!.seq;
      await a.sendPrompt("second", { wait: true, timeoutMs: 5000 });
      const incremental = a.output({ sinceSeq: lastSeq });
      expect(incremental.length).toBeGreaterThan(0);
      expect(incremental.every((f) => f.seq > lastSeq)).toBe(true);
    },
    10_000,
  );
});

describe("PiAgent lifecycle (session + suspend/resume)", () => {
  const tempDirs: string[] = [];
  function makeSessionDir(): string {
    const d = mkdtempSync(join(tmpdir(), "deleg8-test-"));
    tempDirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test(
    "captures sessionId after ready (status.session_id populated)",
    async () => {
      const sessionDir = makeSessionDir();
      const a = makeAgent({ sessionDir });
      await a.start();
      // captureSession is fire-and-forget after start() resolves.
      await waitFor(() => a.status().session_id !== null, 2000);
      const s = a.status();
      expect(s.session_id).toMatch(/^mock-/);
      expect(s.session_file).toContain(sessionDir);
      expect(s.session_dir).toBe(sessionDir);
      expect(s.state).toBe("running");
      expect(s.auto_suspend).toBe(true);
    },
    10_000,
  );

  test(
    "turn_end auto-suspends: state flips to idle, proc dies",
    async () => {
      const sessionDir = makeSessionDir();
      const a = makeAgent({ sessionDir });
      await a.start();
      await waitFor(() => a.status().session_id !== null, 2000);
      await a.sendPrompt("hello", { wait: true, timeoutMs: 5000 });
      // turn_end arrives right after the response; suspend is async.
      await waitFor(() => a.status().state === "idle", 2000);
      const s = a.status();
      expect(s.state).toBe("idle");
      expect(s.running).toBe(false);
      expect(s.session_id).not.toBeNull();
    },
    10_000,
  );

  test(
    "autoSuspend: false keeps proc running after turn_end",
    async () => {
      const sessionDir = makeSessionDir();
      const a = makeAgent({ sessionDir, autoSuspend: false });
      await a.start();
      await waitFor(() => a.status().session_id !== null, 2000);
      await a.sendPrompt("hello", { wait: true, timeoutMs: 5000 });
      // Give a beat for the (suppressed) suspend logic to NOT run.
      await new Promise((r) => setTimeout(r, 100));
      expect(a.status().state).toBe("running");
    },
    10_000,
  );

  test(
    "sendPrompt to an idle agent transparently resumes and preserves history",
    async () => {
      const sessionDir = makeSessionDir();
      const a = makeAgent({ sessionDir });
      await a.start();
      await waitFor(() => a.status().session_id !== null, 2000);
      const sid1 = a.status().session_id;
      const r1 = await a.sendPrompt("first", { wait: true, timeoutMs: 5000 });
      expect(data(r1).echo).toBe("first");
      await waitFor(() => a.status().state === "idle", 2000);

      // Second send transparently resumes — mock-omp reports persisted history.
      // (After the response, auto-suspend fires again — so we don't assert on
      // the live state here; the turn_count proves --resume was honored.)
      const r2 = await a.sendPrompt("COUNT", { wait: true, timeoutMs: 5000 });
      expect(a.status().session_id).toBe(sid1); // same session across respawn
      // turn_count = persisted_turns + this_turn (mock returns turnCount+1 before increment)
      expect(data(r2).turn_count).toBe(2);
    },
    10_000,
  );

  test(
    "explicit resume() on idle agent restores running state",
    async () => {
      const sessionDir = makeSessionDir();
      const a = makeAgent({ sessionDir });
      await a.start();
      await waitFor(() => a.status().session_id !== null, 2000);
      await a.sendPrompt("hi", { wait: true, timeoutMs: 5000 });
      await waitFor(() => a.status().state === "idle", 2000);
      await a.resume();
      expect(a.status().state).toBe("running");
      expect(a.status().pid).not.toBeNull();
    },
    10_000,
  );

  test(
    "resume() without a sessionId throws",
    async () => {
      const a = new PiAgent("never-started", { command: ["bun", "run", MOCK_PATH] });
      tracked.push(a);
      await expect(a.resume()).rejects.toThrow(/no sessionId/);
    },
    10_000,
  );
});
