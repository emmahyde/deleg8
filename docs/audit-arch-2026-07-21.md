# deleg8 — Architecture Audit (2026-07-21)

Produced by `/audit-arch`, prompted by a live failure: mid-task agent→host `msg` events never reached the host conversation (only the first couple of spawn-time messages were seen), and both workers in the same run recursively spawned their own sub-agents unprompted.

**Headline verification result (negative, load-bearing):** nothing in deleg8 ever tells omp that the `msg`/`task_create`/`task_update`/`task_list` host tools exist. There are *handlers* for incoming `host_tool_call` frames (`server.ts:250-316`), but no registration/advertisement frame is ever written to omp (the only frames sent are `prompt`, `set_model`, `abort`, `get_state`, `extension_ui_response`, `host_tool_result` — `agent.ts`), the mock-omp test fixture never emits a `host_tool_call` (`grep host_tool tests/fixtures/mock-omp.ts` → empty), and no test covers the path. The model inside omp has no such tool to call, so mid-task messages structurally cannot arrive. The only automatic channel event is `agent_end`.

***

> Auditing as: resident senior engineer, with the mid-use reliability report as declared intent. Fitness bar: a plugin that makes delegation to persistent omp subagents reliable, observable, and context-cheap for the orchestrator. Ethos: the orchestrator must be able to trust what it's told about its fleet — core subsystems: spawn/prompt path, the notification/observability loop, session persistence. Peripheral: ui-bridge elicitation, jq projection.

## 1. Wholesale CLAUDE.md injection into workers → task-scoped prompts only

**Where:** `pi-agent-mcp/src/server.ts:84-102` (`collectClaudeMd`), `:318-321` (prefix onto every `initial_prompt`)

**Current flow:** Every spawn prepends the *orchestrator's* global `~/.claude/CLAUDE.md` plus the target repo's CLAUDE.md to the worker's first prompt. The global file is a procedure kit for the host session — including "fan out to subagents" and "route subagent work through deleg8."

**Conflict:** Config/identity bleed — instructions for one role delivered to another. This isn't context the worker needs; it's the reason both spike agents on 2026-07-21 burned their first four minutes writing guardrail `TRIGGER:` lines and spawning their *own* sub-agents (which died on a credit-limited provider). Recursive delegation is the built-in failure mode.

**Simpler architecture:** The spawn prompt is the whole contract. If shared context is wanted, a one-paragraph worker preamble ("you are a leaf worker; do not delegate; report via final message") — authored for the worker role, not inherited from the host.

**Deletion test:** `collectClaudeMd` (19 lines), and the entire recursive-delegation failure class observed live.

**Cost honesty:** Prompts must now carry any repo conventions the worker genuinely needs; the orchestrator writes slightly longer prompts.

## 2. Three push channels, none durable, one unverified → the log is the mailbox

**Where:** `server.ts:242-246, 258-261` (fire-and-forget `claude/channel` notifications), `server.ts:104-127` (`buildMonitorCmd` bash-tail fallback), `summarize.ts:104-116` (digest drops everything but assistant messages)

**Current flow:** "What is my agent doing/saying?" is answered by three parallel mechanisms: experimental channel notifications (fire-and-forget, `.catch(console.error)`, no record), a generated bash `tail -f` monitor script, and the pull tools (`output`/`status`). The advertised agent-initiated `msg`/`task_*` events additionally require omp to emit `host_tool_call` — but no code ever registers those tools with omp, and no test exercises the path (see headline result above). And even if a `msg` frame *did* arrive, the default `digest` read path filters it out.

**Conflict:** Duplicated coordination mechanism + push where a durable mailbox belongs. Not saved by the "events model one-shot facts" guard — these events are exactly the facts the orchestrator later needs to re-read, and today they vanish.

**Simpler architecture:** One substrate, which already exists: every frame lands in the ring buffer and NDJSON log. Make `digest` surface an `events` section (msgs, task changes, agent_end) so the pull path is complete; keep channel notifications as a best-effort hint on top. Either implement the omp host-tool registration handshake with a test against the fixture, or delete the agent-side msg/task instructions — advertising an unwired capability is worse than not having it.

**Deletion test:** `buildMonitorCmd` (24 lines of bash-in-a-string), the four near-identical notification blocks (the host-side `task_create`/`task_update` MCP tools at `server.ts:649-734` duplicate the agent-side handlers at `:265-315` — collapsing them is part of this), the "message silently vanished" failure class, and the false documentation in the server's own MCP instructions.

**Cost honesty:** Digest payloads grow slightly; the handshake work requires reading omp's actual RPC contract (or accepting the deletion branch).

## 3. In-memory fleet registry under a persistence ambition → disk manifest + boot rehydration

**Where:** `registry.ts:25` (`agents = new Map()`), `agent.ts:98` (`sessionId` captured only in RAM), `server.ts:788-809` (shutdown SIGKILLs the whole fleet)

**Current flow:** omp sessions are durable on disk and `send` transparently resumes idle agents via `--resume <sessionId>` — but the mapping agent_id → session_id/session_dir lives only in server-process memory. An MCP server restart or reconnect (observed: the twin `pi-agent` mount disconnected mid-session on 2026-07-21) leaves every resumable session stranded with no rehydration path; the new process boots with an empty registry.

**Conflict:** Ambition mismatch, and the ambition is loudly signaled — the README's first line is "persistent subagents"; `send`'s description promises "context preserved across pauses." Persistence currently means "as long as the server process lives," which is the weakest link in the chain.

**Simpler architecture:** A `registry.json` manifest beside the logs (already per-session-dir), written on spawn/suspend, read at boot to rehydrate idle entries. The idiomatic shape for a process supervising resumable children.

**Deletion test:** The "reconnect = total fleet loss" failure class; the need to treat `prune` as the only hygiene mechanism; the mental distinction users must track between "idle-and-reachable" and "idle-but-orphaned."

**Cost honesty:** Introduces one file with staleness risk (manifest says idle, session dir deleted); needs a validity check on rehydrate.

***

**Fitness bar used:** reliable, observable, context-cheap delegation to persistent omp subagents; the orchestrator must be able to trust what it's told about its fleet.

**Explicitly not flagged:** the `ui-bridge` elicitation layer (peripheral, and it's the one place interactive dialogs must cross the boundary); `Frame = Record<string, unknown>` loose typing (idiomatic for an NDJSON bridge this size); stale `pi_send`/`pi_list` names in error strings and the README/hooks.json matcher mismatch (`task` vs `Agent`) — real, but code-review-scale, not architecture.

***

## Evidence appendix

- Full reads: `server.ts` (818 lines), `agent.ts` (651), `registry.ts` (109), `summarize.ts` (162), `ui-bridge.ts` (152), `frames.ts` (41), `hooks/hooks.json`, `.claude-plugin/plugin.json`, `README.md`, `.mcp.json`.
- `agent.ts:118-123` comment: `onChannelFrame` "Must be set by every code path that creates a PiAgent (currently only the spawn handler)" — landmine acknowledged in-source.
- Frames written TO omp (exhaustive, from `agent.ts`): `prompt`, `set_model`, `abort`, `get_state`, `extension_ui_response`, `host_tool_result`. No registration/advertisement frame exists.
- `grep host_tool tests/fixtures/mock-omp.ts` → no hits: the agent-side host-tool path is untested against even the mock.
- `.mcp.json` registers only the `deleg8` server (`bun run ${CLAUDE_PLUGIN_ROOT}/pi-agent-mcp/src/server.ts`); the duplicate `pi-agent` mount seen in-session comes from configuration outside this repo.
- Live incident (2026-07-21): two `openai-codex/gpt-5.6-luna` workers each inherited the orchestrator's global CLAUDE.md, emitted guardrail TRIGGER lines, and attempted sub-delegation; sub-agents failed on the API-key `openai` provider ("requested 65,536 tokens against an 893-token credit limit"). Fixed operationally by a direct `send` instructing no delegation.

Findings only — no implementation. To pursue one, hand off to `/improve-codebase-architecture`.

***

## Addendum: operational findings from live use (2026-07-21, same session)

Smaller than the architecture findings, but each observed directly while orchestrating five agents (spike waves 1–2 + two audit mappers). Roughly ranked by pain-per-line-of-code.

### Evidence-backed bugs

1. **`send` reports dispatch, not delivery.** A steering message sent to unity-bootstrap while it was finishing raced its `agent_end` and silently vanished — the tool returned `dispatched: true` and the agent ended without ever seeing the prompt; the miss was only discovered by inspecting the unchanged output artifact. Fix: when the target ends before the prompt is consumed, return "agent ended before delivery" or queue the message for the next `--resume`.

2. **`modified_files` is always empty.** seam-surgeon changed 17 files and asset-wrangler wrote models/loaders; every `output` digest across all agents showed `modified_files: []`. Either file tracking is unwired for this omp version or the frame parsing misses it. As shipped, the field reads as "agent did nothing" — worse than absent.

### Quick wins

3. **`role: "leaf"` spawn option.** The "you are a leaf worker, do NOT delegate" override had to be hand-pasted into every spawn prompt to suppress recursive delegation (see finding 1). Make it a spawn flag that injects a standard worker preamble.

4. **Digest should drop empty messages by default.** Tool-heavy turns produce assistant messages with empty text; every useful `output` call ended up appending the same jq (`map(select(.data.text != ""))`). Default digest to non-empty texts.

5. **Widen `monitor_cmd` to terminal errors.** The generated watch greps only `"type":"agent_end"` — silent on crashes. The hand-fixed variant used in-session: `grep -E '"type":"agent_end"|"type":"error"'`. Ship that as the default.

### Medium leverage

6. **Cost rollup in `list`/`status`.** Per-message cost is already in every frame (e.g. ~$0.03/message on openai-codex/gpt-5.6-luna); summing per agent would give "this run cost $X across N agents" for free instead of burying it in raw frames.

7. **Encode model pinning as a hook.** The standing rule "deleg8 never runs anthropic/* models" lives in operator memory today; a PreToolUse hook rejecting `provider: "anthropic"` on spawn/set_model makes it structural.

Note: fixing architecture finding 2 (log-as-mailbox) subsumes items 1 and 5 — the durable substrate makes delivery observable and crash frames first-class.
