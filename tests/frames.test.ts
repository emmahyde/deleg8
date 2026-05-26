import { describe, expect, test } from "bun:test";

import { decode, encode, readLines } from "../src/frames.ts";

describe("encode/decode", () => {
  test("encodes a frame as NDJSON", () => {
    const bytes = encode({ id: "r1", type: "prompt", message: "hi" });
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe('{"id":"r1","type":"prompt","message":"hi"}\n');
  });

  test("round-trips through decode", () => {
    const f = { id: "r1", type: "prompt", message: "hi" };
    const text = new TextDecoder().decode(encode(f));
    expect(decode(text)).toEqual(f);
  });

  test("decode returns null for blank input", () => {
    expect(decode("")).toBeNull();
    expect(decode("   ")).toBeNull();
    expect(decode("\n")).toBeNull();
  });

  test("decode returns null for malformed JSON", () => {
    expect(decode("not json")).toBeNull();
    expect(decode("{broken")).toBeNull();
  });

  test("decode rejects non-object JSON", () => {
    expect(decode("123")).toBeNull();
    expect(decode('"a string"')).toBeNull();
    expect(decode("[1,2,3]")).toBeNull();
    expect(decode("null")).toBeNull();
  });

  test("decode tolerates surrounding whitespace", () => {
    expect(decode('  {"a":1}  ')).toEqual({ a: 1 });
  });
});

describe("readLines", () => {
  function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
        controller.close();
      },
    });
  }

  async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
    const out: string[] = [];
    for await (const line of readLines(stream)) out.push(line);
    return out;
  }

  test("splits on newlines", async () => {
    expect(await collect(streamOf(["a\nb\nc\n"]))).toEqual(["a", "b", "c"]);
  });

  test("stitches chunks split mid-line", async () => {
    expect(await collect(streamOf(["hel", "lo\nwo", "rld\n"]))).toEqual(["hello", "world"]);
  });

  test("yields trailing partial line without newline", async () => {
    expect(await collect(streamOf(["a\nb"]))).toEqual(["a", "b"]);
  });

  test("preserves blank lines as empty strings", async () => {
    expect(await collect(streamOf(["a\n\nb\n"]))).toEqual(["a", "", "b"]);
  });

  test("handles multi-byte utf8 split across chunks", async () => {
    const full = new TextEncoder().encode("héllo\n");
    // "é" is two bytes (0xc3 0xa9). Split between them so the first chunk has only the
    // leading byte — `TextDecoder({ stream: true })` should buffer it.
    expect(await collect(streamOf([full.slice(0, 2), full.slice(2)]))).toEqual(["héllo"]);
  });

  test("empty stream yields nothing", async () => {
    expect(await collect(streamOf([]))).toEqual([]);
  });
});
