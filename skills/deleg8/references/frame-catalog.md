# Frame Catalog for jq Filters

This is a condensed version of the `deleg8://schema/frames` MCP resource.
Use it when writing jq filters against `output(format="raw")`.

## Frame types

### Lifecycle frames

| Type | Fields | Meaning |
|---|---|---|
| `ready` | — | Subprocess startup signal |
| `agent_start` | — | Agent begins a multi-turn run |
| `agent_end` | `reason` (string?) | Agent run finished |
| `turn_start` | — | A turn begins (prompt + response cycle) |
| `turn_end` | — | A turn ends |

### Message frames

| Type | Fields | Meaning |
|---|---|---|
| `message_start` | `message.role`, `message.model?` | Message begins |
| `message_update` | `message.content[]` | Incremental content block (streaming) |
| `message_end` | `message.role`, `message.content[]`, `message.model?`, `message.usage?`, `message.stopReason?` | Complete message |

### Message shape

Message objects (in `message_start`/`end`/`update`):

| Field | Type |
|---|---|
| `role` | `"user" \| "assistant" \| "tool"` |
| `content` | ContentBlock[]; `block.type` ∈ `{text, thinking, tool_use, tool_result}` |
| `model`, `provider` | string? (assistant only) |
| `usage` | `{input, output, cacheRead, cacheWrite, totalTokens, cost}?` |
| `stopReason` | string? |
| `timestamp` | number? |

Content block shapes: `text` → `{text}`; `thinking` → `{thinking, thinkingSignature?}`; `tool_use` → `{id, name, input}`; `tool_result` → `{tool_use_id, content, isError?}`.

### Control frames

Fields live directly on the frame object (`.frame.method`, not `.frame.request.method`).

| Type | Fields | Meaning |
|---|---|---|
| `response` | `id`, `command` (`"prompt"`/`"set_model"`/`"abort"`/...), `success` (boolean), `data?`, `error?` | Response to a request, correlated by `id` |
| `extension_ui_request` | `id`, `method`, `title?`, `message?`, `options?` (select), `placeholder?` (input), `prefill?` (editor) | Host dialog. ACTIVE methods (`select`/`confirm`/`input`/`editor`) need a response; PASSIVE (`notify`/`setStatus`/`setWidget`/`setTitle`/`open_url`/`cancel`/`set_editor_text`) are fire-and-forget |
| `host_tool_call` | `id`, `name`, `input` | omp calling a registered host tool (e.g. `msg`, `task_create`, `exclusive_acquire`) |
| `host_uri_request` | `id`, `uri` | omp asking the host to resolve a custom URI |

## jq patterns

### Find the last assistant message text (raw mode)

```jq
.frames | map(select(.frame.type == "message_end" and .frame.message.role == "assistant")) | last.frame.message.content | map(select(.type == "text") | .text) | join("")
```

### Find failed responses (raw mode)

```jq
[.frames[] | select(.frame.type == "response" and .frame.success == false)]
```

### Find all errors (summary mode)

```jq
.entries | map(select(.kind == "error"))
```

### Check for pending UI requests (summary mode)

```jq
.entries | map(select(.kind == "ui_request")) | .[-1]
```

### Extract modified file paths (digest mode)

```jq
.modified_files
```

### Get agent model info (raw mode, first turn)

```jq
.frames | map(select(.frame.type == "message_start" and .frame.message.role == "assistant")) | first.frame.message.model
```

## Summary mode kinds

When using `format: "summary"`, each entry is collapsed to `{seq, ts, kind, data}`:

| kind | data contains |
|---|---|
| `message` | `{role, text, blocks?, model?, usage?, stopReason?}` |
| `error` | `{error: string}` |
| `ui_request` | `{method, ...requestFields}` |
| `host_request` | `{type: "tool_call" \| "uri_request", ...}` |

Summary mode drops per-token streaming noise (`message_update`, `thinking_delta`)
and lifecycle frames (`ready`, `agent_start`, `turn_start`). Use it when you need
full turn history without the raw volume.
