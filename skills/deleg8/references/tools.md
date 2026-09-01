# deleg8 Tool Reference

Ten orchestrator-facing MCP tools: `spawn`, `send`, `output`, `status`, `list`, `stop`, `prune`, `tasks`, `task_create`, `task_update`. Spawned agents additionally get six deleg8-provided host tools in their own tool list — see [Agent-side host tools](#agent-side-host-tools).

## spawn

Launch a new `omp --mode rpc` subprocess and register it under `agent_id`. Mirrors the native `Agent` tool.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `agent_id` | string (regex `^[a-zA-Z0-9_.\-]{1,64}$`) | No | Auto-generated | Stable identifier. Auto-generated if omitted (e.g. `pi-001`). |
| `initial_prompt` | string | No | — | First prompt sent after spawn. CLAUDE.md is auto-prepended. |
| `model` | `{provider, modelId}` | No | omp default | e.g. `{provider: "anthropic", modelId: "sonnet-4.5"}`. Sent as a `set_model` frame before initial_prompt. |
| `fallback_model` | `{provider, modelId}` | No | — | If the primary model fails to apply (e.g. budget exceeded), try this one. |
| `extra_args` | string[] | No | — | Extra CLI args appended to the omp spawn command. |
| `cwd` | string | No | — | Working directory for the omp subprocess. |
| `rpc_mode` | `"rpc"` or `"rpc-ui"` | No | `"rpc-ui"` | `rpc-ui` routes omp's clarifying questions to MCP elicitation. Use `rpc` to disable. |
| `background` | boolean | No | `false` | If true, returns immediately without waiting for initial_prompt's response. Includes `monitor_cmd` in result. |
| `timeout_ms` | integer | No | `300000` | Wait timeout for initial_prompt (5 min default). |
| `role` | `"leaf"` | No | — | Prepends a preamble instructing the worker not to spawn sub-agents or delegate — it must do the work itself. |
| `denylist` | string[] | No | — | Regex patterns over toolName + command string (e.g. `["git (stash\|checkout\|reset\|clean)"]`). Injected as prompt-level constraints; matching tool executions fire real-time channel notifications. |
| `own` | string[] | No | — | Glob patterns limiting write scope (e.g. `["src/**", "docs/*"]`). Prompt-level instruction + violation notifications on out-of-scope writes. |
| `preamble` | string | No | — | Shared context block injected before the prompt. Use for fan-out-level ground truth (library idioms, API contracts). |
| `exclusive` | `{pattern, wait}[]` | No | — | Declare command patterns (case-insensitive regex) as exclusive across agents. Agents must call `exclusive_acquire`/`exclusive_release` around matching commands. `wait: true` queues the caller; `false` rejects immediately. |
| `idle_ttl` | integer (ms) | No | 1h | Auto-reap idle agents after N ms of inactivity. `0` disables. Registry-level. |
| `dead_ttl` | integer (ms) | No | 1h | Auto-reap dead agents after N ms. `0` disables. Registry-level. |

Response includes `agent_id`, `status`, and optionally `response` (if not background) or `monitor_cmd` (if background).

**Enforcement is cooperative, not interceptive.** omp runs its Bash/Read/Edit tools internally — deleg8 sees `tool_execution_start` frames only AFTER execution begins, so `denylist`/`own`/`exclusive` combine (a) prompt-level agent instruction (primary) with (b) real-time violation monitoring via channel notifications (visibility into bypass). A rogue agent can ignore the protocol.

**Capacity gates.** Spawn (and resume of an idle agent) is rejected when the concurrent-agent cap (`DELEG8_MAX_AGENTS`, default 6) is reached or system free memory is below the floor (`DELEG8_MIN_FREE_MEM_PCT`, default 15%). On rejection, wait for agents to finish or stop one.

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

Response fields: `agent_id`, `status` → `{agent_id, pid, state, running, started_at, last_activity, message_count, buffered_frames, model, exit_code, log_path, session_id, session_file, session_dir, auto_suspend, total_cost_usd}`. `total_cost_usd` is summed across the agent's buffered frames.

## list

Snapshot of every registered agent. Mirrors `TaskList`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `jq` | string | No | — | Optional jq filter. |

Response: `{count, agents: [{agent_id, pid, state, session_id, total_cost_usd, ...}], server}`.

States: `running` (process active), `idle` (suspended, session on disk, resumable), `dead` (crashed or stopped, inspect-only).

`server` carries the running process's commit / source mtime / boot time — compare it against the checkout to tell whether this server predates a fix you expect it to have.

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

## tasks

Query the agent task registry — tasks created by agents (via their `task_create`/`task_update` host tools) or by the orchestrator. Tasks are removed automatically when their agent finishes, is stopped, or is pruned.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `agent_id` | string | No | — | Filter by agent_id. Omit for all tasks. |
| `task_id` | string | No | — | Get a specific task by ID. |
| `jq` | string | No | — | Optional jq filter. |

Each task: `{task_id, agent_id, label, status, note?, created_at, updated_at}` with status ∈ `pending | in_progress | done | failed`.

## task_create

Create a task in the registry from the orchestrator side (agents have their own host-tool version).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | Yes | Agent ID this task belongs to. |
| `label` | string | Yes | Task label (5-10 words, ≤200 bytes). |
| `note` | string | No | Optional detail (≤1000 bytes). |

Returns the `task_id` to pass to `task_update`. Rejected past 100 tasks per agent.

## task_update

Update a task's status or note.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task_id` | string | Yes | ID from `task_create`. |
| `status` | `pending \| in_progress \| done \| failed` | No | New status. |
| `note` | string | No | Updated note. |

## Agent-side host tools

Spawned agents receive these deleg8-provided tools in their own tool list. They are invoked BY the agent (arriving as `host_tool_call` frames), not by the orchestrator — tell the agent to call them by name in its prompt.

| Tool | Input | Purpose |
|---|---|---|
| `msg` | `{text}` (≤2000 bytes) | Mid-task IRC-style message to the orchestrator. Longer content belongs in the final report. |
| `task_create` | `{label, note?}` | Register a unit of sub-work; returns `task_id`. |
| `task_update` | `{task_id, status, note?}` | Update sub-work status. |
| `task_list` | `{agent_id?}` | List tasks visible to the agent. |
| `exclusive_acquire` | `{pattern}` | Acquire a lock for a pattern the orchestrator declared `exclusive` at spawn. Blocks or rejects per the pattern's `wait` flag. |
| `exclusive_release` | `{pattern}` | Release the lock. Always release, even on failure. Locks are also released on agent stop/remove/prune. |

## Channel notifications

deleg8 pushes real-time events into the orchestrator session as `<channel source="deleg8" agent_id="X" event="...">` blocks:

| event | When |
|---|---|
| `agent_end` | Agent finished its run; carries the final assistant message. Intermediate turn frames are suppressed. Also fires a macOS desktop banner (disable with `DELEG8_NO_DESKTOP_NOTIFY`). |
| `msg` | Agent called its `msg` host tool mid-task. |
| `task_create` / `task_update` | Agent (or orchestrator) touched the task registry. |
| violation events | A `denylist` or `own` constraint was breached (monitoring, post-hoc). |

Every channel notification is also appended to `~/.claude/deleg8/events-global.ndjson` — a cross-session feed any session can tail or grep, which survives sessions that silently drop channel frames.

## MCP resources

- `deleg8://schema/frames` — the authoritative frame-type catalog with field shapes and worked jq examples. Read it before writing non-trivial jq filters against `output`.
- `deleg8://schema/channel-events` — channel-event catalog, the six agent-side host tools with input shapes and byte limits, and the events-global.ndjson feed. Read it when wiring agent prompts to the host-tool protocol.
