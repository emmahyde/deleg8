import { describe, expect, test } from "bun:test";

import { PiAgentError } from "../src/agent.ts";
import { jqFilter } from "../src/jq-filter.ts";

async function hasJq(): Promise<boolean> {
  try {
    const p = Bun.spawn(["jq", "--version"], { stdout: "ignore", stderr: "ignore" });
    await p.exited;
    return p.exitCode === 0;
  } catch {
    return false;
  }
}

const JQ = await hasJq();
const suite = JQ ? describe : describe.skip;

suite("jqFilter (requires jq on PATH)", () => {
  test("projects scalar", async () => {
    expect(await jqFilter({ a: 1, b: 2 }, ".a + .b")).toBe(3);
  });

  test("filters and maps array", async () => {
    const out = await jqFilter([{ x: 1 }, { x: 2 }, { x: 3 }], "[.[] | select(.x > 1) | .x]");
    expect(out).toEqual([2, 3]);
  });

  test("stream filter → returns array of results", async () => {
    expect(await jqFilter([1, 2, 3], ".[]")).toEqual([1, 2, 3]);
  });

  test("empty result → null", async () => {
    expect(await jqFilter([1, 2, 3], ".[] | select(. > 100)")).toBeNull();
  });

  test("bad filter throws PiAgentError carrying jq diagnostic", async () => {
    await expect(jqFilter({ a: 1 }, ".[")).rejects.toThrow(PiAgentError);
  });

  test("works on nested pi_output-shaped input", async () => {
    const input = {
      agent_id: "x",
      entries: [
        { kind: "message", data: { role: "assistant", text: "hi" } },
        { kind: "message", data: { role: "user", text: "q" } },
      ],
    };
    const out = await jqFilter(
      input,
      '[.entries[] | select(.data.role == "assistant") | .data.text]',
    );
    expect(out).toEqual(["hi"]);
  });
});
