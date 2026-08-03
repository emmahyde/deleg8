import { describe, expect, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { makeElicitBridge } from "../src/ui-bridge.ts";

type Schema = { type: "object"; properties: Record<string, any>; required?: string[] };
type ElicitParams = { message: string; requestedSchema: Schema };
type ElicitResult = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

function fakeServer(elicit: (p: ElicitParams) => Promise<ElicitResult>): McpServer {
  return { server: { elicitInput: elicit } } as unknown as McpServer;
}

describe("makeElicitBridge", () => {
  test("select → builds enum schema, returns {value}", async () => {
    let received: ElicitParams | null = null;
    const bridge = makeElicitBridge(
      fakeServer(async (p) => {
        received = p;
        return { action: "accept", content: { value: "b" } };
      }),
    );
    const resp = await bridge({
      id: "ui-1",
      type: "extension_ui_request",
      method: "select",
      title: "pick",
      options: ["a", "b", "c"],
    });
    expect(received?.requestedSchema.properties.value.enum).toEqual(["a", "b", "c"]);
    expect(received?.requestedSchema.required).toEqual(["value"]);
    expect(resp).toEqual({ type: "extension_ui_response", id: "ui-1", value: "b" });
  });

  test("confirm → builds boolean schema, returns {confirmed}", async () => {
    let received: ElicitParams | null = null;
    const bridge = makeElicitBridge(
      fakeServer(async (p) => {
        received = p;
        return { action: "accept", content: { confirmed: true } };
      }),
    );
    const resp = await bridge({
      id: "ui-2",
      type: "extension_ui_request",
      method: "confirm",
      title: "sure?",
      message: "go ahead?",
    });
    expect(received?.requestedSchema.properties.confirmed.type).toBe("boolean");
    expect(resp).toEqual({ type: "extension_ui_response", id: "ui-2", confirmed: true });
  });

  test("input → builds string schema, returns {value}", async () => {
    const bridge = makeElicitBridge(
      fakeServer(async () => ({ action: "accept", content: { value: "hello" } })),
    );
    const resp = await bridge({
      id: "ui-3",
      type: "extension_ui_request",
      method: "input",
      title: "say something",
      placeholder: "your answer",
    });
    expect(resp).toEqual({ type: "extension_ui_response", id: "ui-3", value: "hello" });
  });

  test("editor → string schema carries prefill as default", async () => {
    let received: ElicitParams | null = null;
    const bridge = makeElicitBridge(
      fakeServer(async (p) => {
        received = p;
        return { action: "accept", content: { value: "long text" } };
      }),
    );
    const resp = await bridge({
      id: "ui-4",
      type: "extension_ui_request",
      method: "editor",
      title: "write more",
      prefill: "starter",
    });
    expect(received?.requestedSchema.properties.value.default).toBe("starter");
    expect(resp).toEqual({ type: "extension_ui_response", id: "ui-4", value: "long text" });
  });

  test("decline → cancelled response", async () => {
    const bridge = makeElicitBridge(fakeServer(async () => ({ action: "decline" })));
    const resp = await bridge({
      id: "ui-5",
      type: "extension_ui_request",
      method: "input",
      title: "hi",
    });
    expect(resp).toEqual({ type: "extension_ui_response", id: "ui-5", cancelled: true });
  });

  test("cancel → cancelled response", async () => {
    const bridge = makeElicitBridge(fakeServer(async () => ({ action: "cancel" })));
    const resp = await bridge({
      id: "ui-6",
      type: "extension_ui_request",
      method: "confirm",
      title: "hi",
    });
    expect(resp).toEqual({ type: "extension_ui_response", id: "ui-6", cancelled: true });
  });

  test("unknown method → null (bridge declines to handle, caller cancels)", async () => {
    const bridge = makeElicitBridge(fakeServer(async () => ({ action: "accept" })));
    const resp = await bridge({
      id: "ui-7",
      type: "extension_ui_request",
      method: "wat",
      title: "?",
    });
    expect(resp).toBeNull();
  });

  test("elicitInput throwing → null", async () => {
    const bridge = makeElicitBridge(
      fakeServer(async () => {
        throw new Error("client offline");
      }),
    );
    const resp = await bridge({
      id: "ui-8",
      type: "extension_ui_request",
      method: "input",
      title: "x",
    });
    expect(resp).toBeNull();
  });

  test("select with non-string options filters them out", async () => {
    let received: ElicitParams | null = null;
    const bridge = makeElicitBridge(
      fakeServer(async (p) => {
        received = p;
        return { action: "accept", content: { value: "a" } };
      }),
    );
    await bridge({
      id: "ui-9",
      type: "extension_ui_request",
      method: "select",
      title: "pick",
      options: ["a", 1, null, "b"],
    });
    expect(received?.requestedSchema.properties.value.enum).toEqual(["a", "b"]);
  });
});
