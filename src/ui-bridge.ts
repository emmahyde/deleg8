// Bridges omp `extension_ui_request` frames to MCP `elicitInput` calls, and
// translates the user's reply back into the omp `extension_ui_response` shape.
//
// omp UI methods (from packages/coding-agent/src/modes/rpc/rpc-types.ts):
//   select  → user picks one of `options`         → { value: string }
//   confirm → yes/no on `message`                 → { confirmed: boolean }
//   input   → single-line text, optional placeholder → { value: string }
//   editor  → multi-line text, optional prefill      → { value: string }
//
// Decline / cancel → { cancelled: true }

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Frame } from "./frames.ts";

type Schema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

interface ElicitParams {
  message: string;
  requestedSchema: Schema;
}

interface ElicitResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function buildElicit(request: Frame): ElicitParams | null {
  const method = request.method;
  const title = asString(request.title);
  switch (method) {
    case "select": {
      const options = Array.isArray(request.options) ? request.options.filter((o): o is string => typeof o === "string") : [];
      return {
        message: title || "pi agent needs you to pick an option",
        requestedSchema: {
          type: "object",
          properties: {
            value: {
              type: "string",
              enum: options,
              description: "Pick one option",
            },
          },
          required: ["value"],
        },
      };
    }
    case "confirm": {
      const msg = asString(request.message);
      return {
        message: title ? `${title}\n\n${msg}` : msg || "pi agent needs confirmation",
        requestedSchema: {
          type: "object",
          properties: {
            confirmed: {
              type: "boolean",
              description: "Confirm (true) or reject (false)",
            },
          },
          required: ["confirmed"],
        },
      };
    }
    case "input": {
      const placeholder = asString(request.placeholder);
      return {
        message: title || "pi agent needs input",
        requestedSchema: {
          type: "object",
          properties: {
            value: {
              type: "string",
              description: placeholder || "Your answer",
            },
          },
          required: ["value"],
        },
      };
    }
    case "editor": {
      const prefill = asString(request.prefill);
      return {
        message: title || "pi agent needs a longer response",
        requestedSchema: {
          type: "object",
          properties: {
            value: {
              type: "string",
              description: "Multi-line text",
              ...(prefill ? { default: prefill } : {}),
            },
          },
          required: ["value"],
        },
      };
    }
    default:
      return null;
  }
}

function buildOmpResponse(request: Frame, result: ElicitResult): Frame {
  const id = asString(request.id);
  if (result.action !== "accept" || !result.content) {
    return { type: "extension_ui_response", id, cancelled: true };
  }
  switch (request.method) {
    case "confirm":
      return {
        type: "extension_ui_response",
        id,
        confirmed: Boolean(result.content.confirmed),
      };
    case "select":
    case "input":
    case "editor":
      return {
        type: "extension_ui_response",
        id,
        value: asString(result.content.value),
      };
    default:
      return { type: "extension_ui_response", id, cancelled: true };
  }
}

/** Returns a callback suitable for AgentRegistry.onUIRequest. */
export function makeElicitBridge(server: McpServer): (req: Frame) => Promise<Frame | null> {
  return async (request) => {
    const params = buildElicit(request);
    if (!params) return null;
    // `server.server` is the underlying low-level Server from the SDK; elicitInput
    // lives there in v1.x. It returns { action, content? }.
    const inner = (server as unknown as { server: { elicitInput: (p: ElicitParams) => Promise<ElicitResult> } }).server;
    try {
      const result = await inner.elicitInput(params);
      return buildOmpResponse(request, result);
    } catch (e) {
      console.error(`elicitation failed for ${request.method}:`, e);
      return null; // -> cancellation
    }
  };
}
