// Covers the set_host_tools → host_tool_call → host_tool_result round trip.
// Before 2026-07-31 deleg8 never sent set_host_tools, so agents saw no host
// tools at all and every msg/task_* call in a prompt was a hallucination.

import { afterEach, describe, expect, test } from "bun:test";

import { PiAgent, type RpcHostToolDefinition } from "../src/agent.ts";
import type { Frame } from "../src/frames.ts";

const MOCK_PATH = new URL("./fixtures/mock-omp.ts", import.meta.url).pathname;

const ECHO_TOOL: RpcHostToolDefinition = {
  name: "msg",
  description: "Send a message to the operator.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

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

let seq = 0;
function makeAgent(): PiAgent {
  const a = new PiAgent(`hosttools-${++seq}`, { command: ["bun", "run", MOCK_PATH] });
  tracked.push(a);
  return a;
}

function data(frame: Frame | string): Record<string, unknown> {
  if (typeof frame === "string") throw new Error(`expected frame, got string: ${frame}`);
  const d = frame.data;
  if (!d || typeof d !== "object") throw new Error(`response has no data: ${JSON.stringify(frame)}`);
  return d as Record<string, unknown>;
}

describe("host tools", () => {
  test(
    "start() registers hostTools with omp",
    async () => {
      const a = makeAgent();
      a.hostTools = [ECHO_TOOL];
      await a.start();
      const r = await a.sendPrompt("TOOLS", { wait: true, timeoutMs: 5000 });
      expect(data(r).host_tools).toEqual(["msg"]);
    },
    10_000,
  );

  test(
    "no hostTools set → omp's registry stays empty",
    async () => {
      const a = makeAgent();
      await a.start();
      const r = await a.sendPrompt("TOOLS", { wait: true, timeoutMs: 5000 });
      expect(data(r).host_tools).toEqual([]);
    },
    10_000,
  );

  test(
    "host_tool_call reaches onHostRequest and the result reaches omp",
    async () => {
      const a = makeAgent();
      a.hostTools = [ECHO_TOOL];
      const seen: Frame[] = [];
      a.onHostRequest = async (_agentId, request) => {
        seen.push(request);
        const text = String((request.arguments as Record<string, unknown>)?.text ?? "");
        return {
          type: "host_tool_result",
          id: request.id as string,
          result: { content: [{ type: "text", text: JSON.stringify({ delivered: text }) }], details: {} },
        } as unknown as Frame;
      };
      await a.start();

      const r = await a.sendPrompt(`CALL:msg:{"text":"hi there"}`, { wait: true, timeoutMs: 5000 });

      expect(seen).toHaveLength(1);
      expect(seen[0]!.toolName).toBe("msg");
      expect(seen[0]!.arguments).toEqual({ text: "hi there" });

      const d = data(r);
      expect(d.tool_is_error).toBe(false);
      const content = (d.tool_result as { content: { text: string }[] }).content;
      expect(JSON.parse(content[0]!.text)).toEqual({ delivered: "hi there" });
    },
    10_000,
  );

  test(
    "unhandled tool name comes back as an error result, not a hang",
    async () => {
      const a = makeAgent();
      a.hostTools = [ECHO_TOOL, { ...ECHO_TOOL, name: "unwired" }];
      a.onHostRequest = async () => null; // no branch for either tool
      await a.start();

      const r = await a.sendPrompt(`CALL:unwired:{}`, { wait: true, timeoutMs: 5000 });
      const d = data(r);
      expect(d.tool_is_error).toBe(true);
      const content = (d.tool_result as { content: { text: string }[] }).content;
      expect(content[0]!.text).toContain(`"unwired"`);
    },
    10_000,
  );
});
