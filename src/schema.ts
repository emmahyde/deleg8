// Frame-type catalog for `omp --mode rpc-ui` NDJSON, served as the
// `deleg8://schema/frames` resource. Lets the calling agent know what `.frame.type` values
// to expect (and what fields each carries) before writing a `jq` filter.
//
// Sourced from omp's packages/coding-agent/src/modes/rpc/rpc-types.ts.

export const FRAME_SCHEMA = {
  description:
    "Each entry in the `output` tool's `.frames[]` (format: \"raw\") is `{seq, ts, frame}`. The shape of " +
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
    "If you pass `format: \"summary\"` to the `output` tool (its default is \"digest\"), entries are " +
    "already collapsed to {seq, ts, kind, data} with kind ∈ {message, error, " +
    "ui_request, host_request}. jq against summary mode is simpler; jq against " +
    "raw mode gives full per-frame fidelity.",
} as const;

export const CHANNEL_EVENTS_SCHEMA = {
  description:
    "Catalog of deleg8 channel notifications and the host tools spawned agents can call. " +
    "Channel events arrive in the orchestrator session as " +
    '<channel source="deleg8" agent_id="X" event="..."> blocks and are mirrored to ' +
    "~/.claude/deleg8/events-global.ndjson.",
  events: {
    agent_end: {
      description:
        "Agent finished its run; carries the final assistant message. Intermediate turn " +
        "frames are suppressed. Also fires a macOS desktop banner unless " +
        "DELEG8_NO_DESKTOP_NOTIFY is set.",
    },
    msg: { description: "Agent called its `msg` host tool mid-task; carries the text." },
    task_create: { description: "A task was created (by the agent's host tool or the orchestrator tool)." },
    task_update: { description: "A task's status or note changed; content is `[task_id] [status] label — note`." },
    violation: {
      description:
        "A denylist or own constraint was breached. Monitoring is post-hoc: omp executes " +
        "tools internally, so deleg8 observes violations after the fact rather than blocking them.",
    },
  },
  host_tools: {
    description:
      "Tools deleg8 registers into each spawned agent's own tool list (arriving back as " +
      "host_tool_call frames). Tell the agent to call them by name in its prompt.",
    tools: {
      msg: { input: { text: "string (≤2000 bytes)" }, purpose: "Mid-task message to the orchestrator." },
      task_create: {
        input: { label: "string (≤200 bytes)", note: "string? (≤1000 bytes)" },
        purpose: "Register a unit of sub-work; returns task_id. Max 100 tasks per agent.",
      },
      task_update: {
        input: { task_id: "string", status: '"pending" | "in_progress" | "done" | "failed"', note: "string?" },
        purpose: "Update sub-work status.",
      },
      task_list: { input: { agent_id: "string?" }, purpose: "List tasks visible to the agent." },
      exclusive_acquire: {
        input: { pattern: "string" },
        purpose:
          "Acquire the lock for a pattern the orchestrator declared `exclusive` at spawn. " +
          "Blocks or rejects per the pattern's `wait` flag.",
      },
      exclusive_release: {
        input: { pattern: "string" },
        purpose: "Release the lock. Locks are also released on agent stop/remove/prune.",
      },
    },
  },
  global_feed: {
    path: "~/.claude/deleg8/events-global.ndjson",
    description:
      "Every channel notification is appended here as one JSON line — a cross-session feed " +
      "any session can tail or grep, surviving clients that drop channel frames.",
  },
} as const;
