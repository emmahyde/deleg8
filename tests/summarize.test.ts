import { describe, expect, test } from "bun:test";

import type { BufferedFrame } from "../src/agent.ts";
import { digest, summarize } from "../src/summarize.ts";

function buf(...frames: object[]): BufferedFrame[] {
  return frames.map((frame, i) => ({ seq: i + 1, ts: i + 1, frame: frame as any }));
}

describe("summarize", () => {
  test("keeps message_end, drops streaming + lifecycle noise", () => {
    const out = summarize(
      buf(
        { type: "ready" },
        { type: "agent_start" },
        { type: "turn_start" },
        { type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
        { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "He" } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "llo" } },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello!" }],
            model: "deepseek-v4",
            usage: { totalTokens: 42 },
          },
        },
      ),
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe("message");
    expect((out[0]!.data as any).role).toBe("user");
    expect(out[1]!.kind).toBe("message");
    expect((out[1]!.data as any).role).toBe("assistant");
    expect((out[1]!.data as any).text).toBe("Hello!");
    expect((out[1]!.data as any).model).toBe("deepseek-v4");
  });

  test("keeps active UI methods, drops passive", () => {
    const out = summarize(
      buf(
        { type: "extension_ui_request", method: "setWidget", widgetKey: "x" },
        { type: "extension_ui_request", method: "notify", message: "fyi" },
        { type: "extension_ui_request", id: "u1", method: "select", title: "pick", options: ["a", "b"] },
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("ui_request");
    expect((out[0]!.data as any).method).toBe("select");
  });

  test("keeps failed responses, drops success acks", () => {
    const out = summarize(
      buf(
        { type: "response", id: "r1", success: true },
        { type: "response", id: "r2", success: false, error: "boom" },
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("error");
  });

  test("surfaces structured blocks when message has non-text content", () => {
    const out = summarize(
      buf({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "answer" },
          ],
        },
      }),
    );
    expect((out[0]!.data as any).blocks).toEqual([
      { type: "thinking", text: "hmm" },
      { type: "text", text: "answer" },
    ]);
  });
});

describe("digest", () => {
  function assistantMsg(text: string, blocks?: any[]) {
    return {
      type: "message_end",
      message: {
        role: "assistant",
        content: blocks ?? [{ type: "text", text }],
      },
    };
  }

  test("returns the last N assistant messages and excludes user messages", () => {
    const frames = buf(
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "q1" }] } },
      assistantMsg("a1"),
      assistantMsg("a2"),
      assistantMsg("a3"),
      assistantMsg("a4"),
      assistantMsg("a5"),
      assistantMsg("a6"),
    );
    const d = digest(frames, { lastMessages: 3 });
    expect(d.total_assistant_messages).toBe(6);
    expect(d.messages.map((m) => (m.data as any).text)).toEqual(["a4", "a5", "a6"]);
  });

  test("default lastMessages is 5", () => {
    const frames = buf(...Array.from({ length: 8 }, (_, i) => assistantMsg(`m${i}`)));
    expect(digest(frames).messages).toHaveLength(5);
  });

  test("modified_files collects paths from file-modifying tool_use blocks", () => {
    const frames = buf(
      assistantMsg("editing", [
        { type: "tool_use", name: "Edit", input: { file_path: "/a/b.ts", old_string: "x", new_string: "y" } },
        { type: "tool_use", name: "Write", input: { file_path: "/c/d.ts", content: "hi" } },
        { type: "tool_use", name: "Read", input: { file_path: "/should-not-appear.ts" } },
      ]),
      assistantMsg("more", [
        // duplicate path → deduped
        { type: "tool_use", name: "Edit", input: { file_path: "/a/b.ts", old_string: "z", new_string: "w" } },
        { type: "tool_use", name: "str_replace_editor", input: { path: "/e/f.ts" } },
      ]),
    );
    const d = digest(frames);
    expect(d.modified_files.sort()).toEqual(["/a/b.ts", "/c/d.ts", "/e/f.ts"]);
  });

  test("empty when there are no assistant messages", () => {
    const d = digest(buf({ type: "ready" }, { type: "agent_start" }));
    expect(d.messages).toEqual([]);
    expect(d.modified_files).toEqual([]);
    expect(d.total_assistant_messages).toBe(0);
  });
});
