// Integration test for the MCP layer: real McpServer + Client over an
// in-memory transport, wired to a registry whose binary is mock-omp. Verifies
// the full pi_spawn → pi_send → auto-suspend → pi_send-resumes flow that
// pi-agent's resumable lifecycle promises.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { PiAgent } from "../src/agent.ts";
import { AgentRegistry } from "../src/registry.ts";
import { createPiAgentServer } from "../src/server.ts";

const MOCK_PATH = new URL("./fixtures/mock-omp.ts", import.meta.url).pathname;

function callJson(result: { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }): any {
  if (result.structuredContent) return result.structuredContent;
  const textBlock = result.content?.find((c) => c.type === "text");
  if (textBlock?.text) return JSON.parse(textBlock.text);
  return null;
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000, intervalMs = 25): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

interface Harness {
  client: Client;
  registry: AgentRegistry;
  logDir: string;
  close: () => Promise<void>;
}

// Subclass AgentRegistry so spawned PiAgents use mock-omp via the `command`
// override — the real registry's `binary` field can't express "bun run X".
class TestRegistry extends AgentRegistry {
  private readonly testLogDir: string;
  constructor(logDir: string) {
    super({ binary: "bun", logDir });
    this.testLogDir = logDir;
  }
  async spawn(opts: { agentId?: string; cwd?: string; rpcMode?: "rpc" | "rpc-ui"; extraArgs?: string[] } = {}) {
    const aid = opts.agentId ?? `pi-${Math.random().toString(36).slice(2, 8)}`;
    const existing = (this as any).agents.get(aid);
    if (existing && existing.status().state !== "dead") {
      throw new Error(`agent ${aid} already exists`);
    }
    const agent = new PiAgent(aid, {
      command: ["bun", "run", MOCK_PATH],
      cwd: opts.cwd,
      logDir: this.testLogDir,
    });
    await agent.start();
    (this as any).agents.set(aid, agent);
    return agent;
  }
}

async function makeHarness(): Promise<Harness> {
  const logDir = mkdtempSync(join(tmpdir(), "pi-server-test-"));
  const registry = new TestRegistry(logDir);
  const { server } = createPiAgentServer({ registry });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    registry,
    logDir,
    close: async () => {
      await registry.stopAll({ force: true }).catch(() => {});
      await client.close().catch(() => {});
      try { rmSync(logDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

describe("pi-agent MCP server integration", () => {
  const harnesses: Harness[] = [];
  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.close();
  });

  test(
    "pi_spawn → pi_send → auto-suspend → pi_send transparently resumes",
    async () => {
      const h = await makeHarness();
      harnesses.push(h);

      // Spawn — first prompt rides on the spawn call.
      const spawnRes = await h.client.callTool({
        name: "pi_spawn",
        arguments: { agent_id: "int-1", initial_prompt: "first" },
      });
      const spawned = callJson(spawnRes as any);
      expect(spawned.agent_id).toBe("int-1");
      expect(spawned.response.data.echo).toBe("first");

      // Auto-suspend kicks in after turn_end; wait for it.
      await waitFor(async () => {
        const r = await h.client.callTool({ name: "pi_status", arguments: { agent_id: "int-1" } });
        return callJson(r as any).status.state === "idle";
      });

      // Snapshot session_id — must survive the resume cycle.
      const idleStatus = callJson(await h.client.callTool({ name: "pi_status", arguments: { agent_id: "int-1" } }) as any);
      expect(idleStatus.status.state).toBe("idle");
      expect(idleStatus.status.session_id).toMatch(/^mock-/);
      const originalSid = idleStatus.status.session_id;

      // Second send must transparently resume. The mock COUNT replies with
      // turn_count reflecting persisted history — if --resume was honored
      // (and session.jsonl was preserved), this is 2.
      const sendRes = await h.client.callTool({
        name: "pi_send",
        arguments: { agent_id: "int-1", message: "COUNT" },
      });
      const sendData = callJson(sendRes as any);
      expect(sendData.response.data.turn_count).toBe(2);
      expect(sendData.status.session_id).toBe(originalSid);

      // Digest from pi_output should reflect both turns.
      const outRes = await h.client.callTool({
        name: "pi_output",
        arguments: { agent_id: "int-1", format: "digest" },
      });
      const out = callJson(outRes as any);
      expect(out.format).toBe("digest");
      // After resume, the in-memory buffer is fresh — only the most recent
      // turn's frames are present. That's expected: the durable history lives
      // in the omp session file on disk; the buffer is per-spawn.
      expect(out.full_output_path).toContain(h.logDir);
    },
    15_000,
  );

  test(
    "pi_list reports state and session metadata",
    async () => {
      const h = await makeHarness();
      harnesses.push(h);
      await h.client.callTool({ name: "pi_spawn", arguments: { agent_id: "a1" } });
      await h.client.callTool({ name: "pi_spawn", arguments: { agent_id: "a2" } });
      const listRes = await h.client.callTool({ name: "pi_list", arguments: {} });
      const list = callJson(listRes as any);
      expect(list.count).toBe(2);
      const ids = list.agents.map((a: any) => a.agent_id).sort();
      expect(ids).toEqual(["a1", "a2"]);
      for (const a of list.agents) {
        expect(["running", "idle", "dead"]).toContain(a.state);
        expect(a).toHaveProperty("session_dir");
      }
    },
    15_000,
  );

  test(
    "pi_prune drops dead agents from the registry",
    async () => {
      const h = await makeHarness();
      harnesses.push(h);
      await h.client.callTool({ name: "pi_spawn", arguments: { agent_id: "doomed" } });
      // Force-stop without remove — leaves a dead entry in the registry.
      await h.client.callTool({
        name: "pi_stop",
        arguments: { agent_id: "doomed", force: true, remove: false },
      });
      // status should still show the agent (state=dead).
      const before = callJson(await h.client.callTool({ name: "pi_list", arguments: {} }) as any);
      expect(before.count).toBe(1);

      const pruneRes = await h.client.callTool({ name: "pi_prune", arguments: {} });
      const pruned = callJson(pruneRes as any);
      expect(pruned.removed).toEqual(["doomed"]);
      const after = callJson(await h.client.callTool({ name: "pi_list", arguments: {} }) as any);
      expect(after.count).toBe(0);
    },
    15_000,
  );
});
