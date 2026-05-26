// Frame-type catalog for `omp --mode rpc-ui` NDJSON, returned by the
// `pi_schema` tool. Lets the calling agent know what `.frame.type` values
// to expect (and what fields each carries) before writing a `jq` filter.
//
// Sourced from omp's packages/coding-agent/src/modes/rpc/rpc-types.ts.

export const FRAME_SCHEMA = {
  description:
    "Each entry in pi_output's `.frames[]` is `{seq, ts, frame}`. The shape of " +
    "`frame` depends on `frame.type`. Use this catalog to write jq filters.",
  frame_types: {
    // ── Lifecycle ──────────────────────────────────────────────────────
    ready: { description: "Subprocess startup signal.", fields: {} },
    agent_start: { description: "Agent begins a multi-turn run.", fields: {} },
    agent_end: { description: "Agent run finished.", fields: { reason: "string?" } },
    turn_start: { description: "A turn begins (one prompt + agent's response cycle).", fields: {} },
    turn_end: { description: "A turn ends.", fields: {} },

    // ── Messages ───────────────────────────────────────────────────────
    message_start: {
      description: "A message begins. Carries a snapshot of the partial message.",
      fields: { message: "Message" },
    },
    message_update: {
      description:
        "Per-token streaming delta. Noisy; usually filtered out. Carries " +
        "`assistantMessageEvent.{type, delta?, contentIndex?, partial?}`.",
      fields: { assistantMessageEvent: "object", message: "Message (snapshot)" },
    },
    message_end: {
      description: "A message is complete. Most useful frame for projections.",
      fields: { message: "Message" },
    },

    // ── Request/response control ───────────────────────────────────────
    response: {
      description: "Response to a request (correlated by id). Includes the original `command`.",
      fields: {
        id: "string",
        command: 'string ("prompt" | "set_model" | "abort" | ...)',
        success: "boolean",
        data: "object?",
        error: "string?",
      },
    },

    // ── UI requests (host has to answer) ───────────────────────────────
    extension_ui_request: {
      description: "Host dialog request. ACTIVE methods need a response; PASSIVE are fire-and-forget.",
      fields: {
        id: "string",
        method:
          'one of: "select" | "confirm" | "input" | "editor" (active) | ' +
          '"notify" | "setStatus" | "setWidget" | "setTitle" | "open_url" | ' +
          '"cancel" | "set_editor_text" (passive)',
        title: "string?",
        message: "string?",
        options: "string[]? (select)",
        placeholder: "string? (input)",
        prefill: "string? (editor)",
      },
    },

    // ── Host calls ─────────────────────────────────────────────────────
    host_tool_call: {
      description: "omp asking the host to invoke a registered tool.",
      fields: { id: "string", name: "string", input: "object" },
    },
    host_uri_request: {
      description: "omp asking the host to resolve a custom URI.",
      fields: { id: "string", uri: "string" },
    },
  },

  message_shape: {
    description: "Message objects (in message_start/end/update) follow this shape.",
    fields: {
      role: '"user" | "assistant" | "tool"',
      content:
        "ContentBlock[]; block.type ∈ {text, thinking, tool_use, tool_result}",
      model: "string? (assistant only)",
      provider: "string? (assistant only)",
      usage: "{input, output, cacheRead, cacheWrite, totalTokens, cost}?",
      stopReason: "string?",
      timestamp: "number?",
    },
    content_block_shapes: {
      text: { text: "string" },
      thinking: { thinking: "string", thinkingSignature: "string?" },
      tool_use: { id: "string", name: "string", input: "object" },
      tool_result: { tool_use_id: "string", content: "any", isError: "boolean?" },
    },
  },

  jq_examples: [
    {
      goal: "Just the assistant's text responses, in order.",
      filter:
        '[.frames[] | select(.frame.type == "message_end" and .frame.message.role == "assistant") | .frame.message.content[] | select(.type == "text") | .text]',
    },
    {
      goal: "All tool calls the agent made in this run.",
      filter:
        '[.frames[] | select(.frame.type == "message_end" and .frame.message.role == "assistant") | .frame.message.content[] | select(.type == "tool_use") | {name, input}]',
    },
    {
      goal: "Token usage per assistant message.",
      filter:
        '[.frames[] | select(.frame.type == "message_end" and .frame.message.role == "assistant") | .frame.message.usage]',
    },
    {
      goal: "Active UI dialogs the agent triggered (waiting on user).",
      filter:
        '[.frames[] | select(.frame.type == "extension_ui_request" and (.frame.method | IN("select","confirm","input","editor")))]',
    },
    {
      goal: "Any failed responses.",
      filter:
        '[.frames[] | select(.frame.type == "response" and .frame.success == false)]',
    },
  ],

  note:
    "If you pass `format: \"summary\"` (the default for pi_output), entries are " +
    "already collapsed to {seq, ts, kind, data} with kind ∈ {message, error, " +
    "ui_request, host_request}. jq against summary mode is simpler; jq against " +
    "raw mode gives full per-frame fidelity.",
} as const;
