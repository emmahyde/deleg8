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

Message content blocks: `{type: "text", text: "..."}` or `{type: "tool_use", ...}` etc.

### Control frames

| Type | Fields | Meaning |
|---|---|---|
| `response` | `response` (object or null) | omp's response to a prompt frame. Non-null on success. |
| `extension_ui_request` | `request.method` (`select`/`confirm`/`input`/`editor`), `request.*` | Clarifying question for the user |
| `host_tool_call` | `tool.name`, `tool.input` | omp calling a host tool |
| `host_uri_request` | `request.uri`, `request.method` | omp requesting a URI read |

## jq patterns

### Find the last assistant message text (raw mode)

```jq
.frames | map(select(.frame.type == "message_end" and .frame.message.role == "assistant")) | last.frame.message.content | map(select(.type == "text") | .text) | join("")
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
