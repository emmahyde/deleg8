# deleg8 Tool Reference

## spawn

Launch a new `omp --mode rpc` subprocess and register it under `agent_id`.
Mirrors the native `Agent` tool.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `agent_id` | string (regex `^[a-zA-Z0-9_.\-]{1,64}$`) | No | Auto-generated | Stable identifier. Auto-generated if omitted (e.g. `pi-001`). |
| `initial_prompt` | string | No | — | First prompt sent after spawn. CLAUDE.md is auto-prepended. |
| `model` | `{provider, modelId}` | No | omp default | e.g. `{provider: "anthropic", modelId: "sonnet-4.5"}` |
| `extra_args` | string[] | No | — | Extra CLI args appended to the omp spawn command. |
| `cwd` | string | No | — | Working directory for the omp subprocess. |
| `rpc_mode` | `"rpc"` or `"rpc-ui"` | No | `"rpc-ui"` | `rpc-ui` routes omp's clarifying questions to MCP elicitation. Use `rpc` to disable. |
| `background` | boolean | No | `false` | If true, returns immediately without waiting for initial_prompt's response. Includes `monitor_cmd` in result. |
| `timeout_ms` | integer | No | `300000` | Wait timeout for initial_prompt (5 min default). |

Response includes `agent_id`, `status`, and optionally `response` (if not background) or `monitor_cmd` (if background).

## send

Send another prompt to an existing agent. If the agent is idle (auto-suspended),
transparently respawns omp with `--resume <session_id>` so conversation context
is preserved. Mirrors `SendMessage`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `agent_id` | string | Yes | — | Target agent_id from `spawn` or `list`. |
| `message` | string | Yes | — | Prompt to send (min 1 char). |
| `background` | boolean | No | `false` | If true, returns immediately. Includes `monitor_cmd`. |
| `timeout_ms` | integer | No | `300000` | Wait timeout for response. |

Response includes `agent_id`, `status`, and `response` (or `dispatched: true` + `monitor_cmd` for background).

## output

Read buffered frames from a subagent. Mirrors `TaskOutput`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `agent_id` | string | Yes | — | Target agent_id. |
| `format` | `"digest"`, `"summary"`, `"raw"` | No | `"digest"` | Output format. |
| `last_messages` | integer (1-50) | No | `5` | Trailing assistant messages in digest mode. |
| `since_seq` | integer (≥0) | No | `0` | Only consider frames with seq > this. Applies to summary/raw. |
| `max_frames` | integer (1-1000) | No | `200` | Max frames to return. |
| `jq` | string | No | — | jq `-c` filter applied to the structured result. |

**Digest response fields:** `agent_id`, `format`, `full_output_path`, `modified_files`, `messages[]`, `total_assistant_messages`, `total_entries`, `last_seq`.

**Summary response fields:** `agent_id`, `format`, `full_output_path`, `count`, `last_seq`, `entries[]` (each: `{seq, ts, kind, data}`).

**Raw response fields:** `agent_id`, `format`, `full_output_path`, `count`, `last_seq`, `frames[]` (each: `{seq, ts, frame}`).

Result is capped at 32KB. Exceeding returns `{truncated: true, bytes, cap, hint}`.
Use jq projection or `since_seq` streaming to stay under the cap.

## status

Detailed status for one agent. Mirrors `TaskGet`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `agent_id` | string | Yes | — | Target agent_id. |
| `jq` | string | No | — | Optional jq filter. |

Response fields: `agent_id`, `status` → `{agent_id, pid, state, running, started_at, last_activity, message_count, buffered_frames, model, exit_code, log_path, session_id, session_file, session_dir, auto_suspend}`.

## list

Snapshot of every registered agent. Mirrors `TaskList`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `jq` | string | No | — | Optional jq filter. |

Response: `{count, agents: [{agent_id, pid, state, ...}]}`.

States: `running` (process active), `idle` (suspended, session on disk, resumable), `dead` (crashed or stopped, inspect-only).

## stop

Send `abort` frame, terminate subprocess, and optionally remove from registry.
Mirrors `TaskStop`. Note: this discards the omp session. For end-of-turn auto-suspend
(resumable), do nothing — the agent suspends itself.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `agent_id` | string | Yes | — | Target agent_id. |
| `force` | boolean | No | `false` | SIGKILL immediately instead of graceful abort. |
| `remove` | boolean | No | `true` | Drop from registry. Set `false` to keep for log inspection. |

## prune

Remove agents whose state matches `states` from the registry. Use to clean up
after long sessions.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `states` | `("idle" \| "dead")[]` | No | `["dead"]` | Which lifecycle states to evict. Default keeps resumable agents. |

Response: `{removed: string[], count: number}`.
