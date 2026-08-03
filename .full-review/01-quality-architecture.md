# Phase 1: Code Quality & Architecture

Produced: 2026-07-25 via inline review (all subagent spawns hit OpenRouter 402).
Files reviewed: pi-agent-mcp/src/*.ts (8 files ~84KB), pi-agent-mcp/tests/ (setup only, signals), hooks/, skills/deleg8/, README.md, plugin manifests.
Prior audit reference: docs/audit-arch-2026-07-21.md — its 3 architecture-level and 7 operational findings are verified against current code.

---

## Code Quality Findings

### Critical
None identified. No bugs found that would corrupt data or crash in normal operation.

### High

**Q1. Swallowed-exception pattern is pervasive (agent.ts, server.ts)**

The codebase has a consistent `catch { /* ignore */ }` / `catch { /* fall through */ }` idiom across agent.ts and server.ts. Many are intentional (best-effort logging, safe fallback), but the prevalence makes it hard to distinguish "this failure is expected and safe" from "we don't know what happens":

| Location | Pattern | Assessment |
|---|---|---|
| `agent.ts:342` | `catch { /* ignore */ }` after sendRaw(abort) in stop() | Safe — graceful abort is best-effort |
| `agent.ts:359` | `catch { /* ignore */ }` awaiting readerTask in stop() | Safe — reader already cleaned up |
| `agent.ts:403` | `catch { /* ignore */ }` awaiting suspendTask in resume() | **Medium risk** — a hung suspend could mask failures |
| `agent.ts:519` | `catch { /* logging is best-effort */ }` | Safe — log flush shouldn't crash agent |
| `agent.ts:590` | `catch { /* fall through */ }` in handleHostRequest first handler | **Medium risk** — falling through to the legacy handler masks the first handler's failure |
| `agent.ts:606` | `catch { /* fall through */ }` in handleHostRequest legacy handler | Safe — ends in default error response |
| `agent.ts:651` | `catch { /* surface via response correlation */ }` in safeWrite | **Medium risk** — safeWrite failures on responses make it look like the response was sent when it wasn't |
| `server.ts:350` | `.catch((err) => console.error(...))` on 3+ notification sends | Safe — notifications are best-effort, but means callers can't trust receipt |

A catch logger wrapper (cf. Rust's `.inspect_err`) would clarify intent at every site while preserving the short block.

**Q2. server.ts registerTools() is 725 lines (server.ts:78-803)**

The single function contains all 9 tool registrations plus 8 helper functions (collectClaudeMd, buildMonitorCmd, ok, fail, guard, project, totalCostUsd). No module boundaries within — every tool's handler has access to the full lexical scope (`taskMap`, `taskSeq`). Extract each tool registration into a standalone function or small module.

*Fix:* One file per tool registration (`tools/spawn.ts`, `tools/send.ts`, etc.) each exporting a `register(server, registry, ...)` function, or at minimum extract helper functions out of registerTools' scope into module-level named functions.

**Q3. jq-filter.ts shells out to `jq` binary for every filter operation**

`jq-filter.ts:10` — `Bun.spawn(["jq", "-c", expr])`. Every `output`/`list`/`status` call that uses jq projection forks a process. For a projection like `.agents | map({id, state})`, the in-process cost is trivial but the spawn overhead is ~50ms+ per call.

*Fix options (in order of preference):* (a) native jq-equivalent in TypeScript — the projections are simple path queries, JSONPath or JMESPath libraries exist; (b) cache the Bun.spawn across calls using a long-lived jq instance; (c) keep as-is and document the tradeoff.

### Medium

**Q4. Duplicate constants across agent.ts and summarize.ts**

Two files independently define:
- `FILE_MODIFYING_TOOL_NAMES` — `agent.ts:107` and `summarize.ts:82`
- `PATCH_HEADER_RE` — `agent.ts:108` and `summarize.ts:83`

These *must* stay in sync. Currently they are identical, but any change to one (e.g. adding a new tool name) requires changing both, with no compile-time check.

*Fix:* Extract to a shared constants file (`src/constants.ts` or `src/frames.ts`).

**Q5. PiAgent constructor accepts 13 options spread across two interfaces**

`agent.ts:200-214` — constructor takes `PiAgentOptions` with 11+ fields plus the documented comment at agent.ts:186-190 about `onChannelFrame` being "set by every code path that creates a PiAgent (currently only the spawn handler)". This is a landmine the source itself recognizes.

*Fix:* Split into a required-settings config object and a builder/setter pattern for optional callbacks. The spawn handler in server.ts already wires `onChannelFrame` and `onHostRequest` after construction — make this the construction interface explicit.

**Q6. `buildMonitorCmd` is 12 lines of bash-as-a-string (server.ts:104-127)**

A bash pipeline embedded in TypeScript: `tail -f | while read... grep | jq | echo`. Templates shell metacharacters thoughtfully escaped (`'${lp}'`), but it's untestable, carries no exit-on-error discipline, and embeds logic (what constitutes "done") in a totally different medium than the rest of the system.

*Fix:* (a) Replace with a lightweight Node-based watcher spawned as a child process, or (b) keep the bash template but extract to a `.sh` file in hooks/ and generate the command path at runtime.

**Q7. Synchronous filesystem calls at spawn time**

`collectClaudeMd()` at `server.ts:84-102` calls `existsSync()` and `readFileSync()` in a hot spawn path. For each spawn, it reads up to 3 files. A 10KB+ CLAUDE.md read blocks the event loop.

*Fix:* Cache the contents (keyed by path + mtime) with a TTL, or read asynchronously before returning the spawn result.

**Q8. Module-level mutable counters (agent.ts:57, registry.ts:7)**

```typescript
let ID_COUNTER = 0;  // agent.ts
let AUTO_ID = 0;     // registry.ts
```

These reset on process restart and are not synchronized in any way. If two PiAgentServer instances share the same process memory (e.g., tests that create then destroy servers), IDs could collide.

*Fix:* Use `randomUUID()` (already imported in server.ts) or `crypto.randomBytes(4).toString("hex")` for auto-generated IDs. The sequence counter is fine for runtime uniqueness within a single process.

### Low

- `nextId()` returns `r1`, `r2`... good enough for runtime but short-lived collisions are possible across server restarts.
- Frame type is `Record<string, unknown>` throughout; this is idiomatic for an NDJSON bridge at this size but costs type safety at every consumption point.
- `BUFFER_CAP = 1024` is hardcoded, not configurable. Sessions with very high frame throughput will lose early frames.
- Comment at `agent.ts:59-64` documents the log-rotation rationale well.

---

## Architecture Findings

### Critical

**A1. [PERSISTS — prior audit finding 1] Orchestrator CLAUDE.md injected into every worker (server.ts:84-102, 352-356)**

`collectClaudeMd()` reads `~/.claude/CLAUDE.md` plus repo-local CLAUDE.md files and prepends them to every spawn's `initial_prompt`. The orchestrator's CLAUDE.md includes subagent routing instructions, delegation rules, and tool policy — exactly the instructions that caused the 2026-07-21 live incident where spawned workers emitted guardrail TRIGGER lines and recursively delegated to their own subagents.

The `role: "leaf"` preamble added at server.ts:131-133 is a band-aid: it instructs the worker not to delegate, but the worker still gets irrelevant host context in its first prompt. If `role` is not set (the default), the full CLAUDE.md injection fires.

*Impact:* Structural — every spawned worker receives context written for the orchestrator. Instruction bleed causes wrong behavior (delegation) and token waste (~3-5KB per spawn for the global CLAUDE.md alone).

*Fix:* Remove `collectClaudeMd()` from the spawn path entirely. The spawn `initial_prompt` is the contract; if workers need shared context, the orchestrator writes it explicitly.

**A2. [PERSISTS — prior audit finding 2] Agent-host tool registration is missing (server.ts:284-349)**

The `msg`, `task_create`, `task_update`, `task_list` handlers at `server.ts:284-349` are fully implemented and documented in SKILL.md, but **omp is never told these tools exist**. No advertisement/registration frame is ever sent. The handlers catch incoming `host_tool_call` frames that omp's AI model will never generate because it doesn't know about the tools.

Confirmed: the exhaustive frame types written TO omp are only `prompt`, `set_model`, `abort`, `get_state`, `extension_ui_response`, `host_tool_result` — no registration frame. The mock-omp test fixture (`tests/fixtures/mock-omp.ts`) does not emit `host_tool_call` frames either (confirmed by `grep host_tool` on the prior audit).

*Impact:* Every documented capability around mid-task IRC messaging and task tracking in SKILL.md and reference docs is non-functional. The handlers and ~80 lines of code are dead from the agent's perspective.

*Fix:* Either (a) remove the handlers and references/tools.md documentation for msg/task tools, or (b) implement the omp host-tool registration handshake and add a test.

### High

**A3. [PERSISTS — prior audit finding 3] In-memory only registry (registry.ts:25)**

`private readonly agents = new Map<string, PiAgent>()`. On MCP server restart or reconnect, every resumable/historical agent is lost. The omp session files persist on disk, but the agent_id → session_id mapping is gone.

The prior audit recommended a `registry.json` manifest written on spawn/suspend and read at boot. This has not been implemented.

*Impact:* "Persistent subagents" (the README's first claim) is only true while the server process lives. A restart orphans every agent.

**A4. send races with agent_end — delivery is unconfirmed (server.ts:406-426)**

When `send` dispatches a message in background mode, it returns `{ dispatched: true }`. No confirmation that the target process consumed the frame before ending. If the target's agent_end races with the write, the message vanishes — `monitor_cmd` tails the log for agent_end and never sees the message because it arrived after the process exited.

This was observed in the 2026-07-21 live session: a steering message sent to unity-bootstrap while it was finishing was silently lost.

*Impact:* Lost messages in race conditions, unrecoverable without manual log inspection.

*Fix:* When the target is idle (about to resume) or running near agent_end, either (a) wait for a response ack before returning, or (b) buffer the message for the next `--resume`.

### Medium

**A5. Plugin-layer contract mismatch: hook matcher + bash guard**

Three issues in the plugin layer:
1. `hooks/hooks.json` has two PreToolUse entries — `Agent` matcher (prompt-based blocking) and `mcp__deleg8__spawn|mcp__deleg8__set_model` (bash-based model denial). The Agent matcher checks for generic native task() calls and redirects to deleg8. This is good, but uses prompt-based hooks which are evaluated by the model — the model can potentially ignore the instruction.
2. `deny-anthropic-models.sh` uses `grep -iE '(anthropic|^claude)'` — the `^claude` anchor means "starts with claude", but the second pattern `/anthropic/i` matches anywhere in the string. This is correct for the intended use case but could block legitimate model names like `deepseek-claude-adapter` if one exists.
3. The bash hook has `exit 0` on both allow and deny paths — the PreToolUse contract distinguishes via the permissionDecision field. If `printf ... | grep` fails for some jq-parsing reason, no stdout is written and the hook effectively allows everything. Adding a `jq -e` guard or a schema validation step would harden it.

**A6. Duplicated task_create/task_update logic (server.ts:299-347 vs server.ts:693-778)**

The same task creation/update logic exists in two places:
- Agent-side `host_tool_call` handlers (lines 299-347) — called when omp emits host_tool_call
- Standalone MCP tools (lines 693-778) — called when the orchestrator directly calls task_create/task_update

The core logic (increment seq, create TaskEntry, set in Map, fire notification) is copy-pasted. Any change to one must be applied to the other.

*Fix:* Extract a shared `createTask(agentId, label, note)` and `updateTask(taskId, status?, note?)` helper.

**A7. Test gap around host-tool path**

No test covers `PiAgent.handleHostRequest()` with a real `host_tool_call` frame. The mock-omp fixture doesn't emit these frames. The agent-side host-tool handler (agent.ts:594-637) is a critical path — if it fails or returns null, omp hangs waiting for the response. This is the most dangerous untested path in the system.

**A8. `server.ts:185 totalCostUsd()` iterates the entire ring buffer**

`totalCostUsd()` reads `agent.output({ maxFrames: 1024 })` — always the full buffer. For `list`, this runs O(N×M) where N = agents × 1024. With 20 agents at 1024 frames each, that's 20K frame iterations per `list` call. Minor at current scale, but a linear scan of the full buffer for an O(1) aggregate field is an architectural smell.

*Fix:* Maintain a running cost accumulator on PiAgent, updated on every `message_end` frame in `onFrame()`. Removes the O(buffer) cost.

### Low

- `ui-bridge.ts` is well-designed. Clean separation of `buildElicit` and `buildOmpResponse`, correct handling of passive method declines, correctly uses `makeElicitBridge` as a factory. No issues.
- `summarize.ts:145-150` now correctly filters empty assistant messages from digest (addressing prior audit finding 4 — good).
- `frames.ts` is minimal and correct. 42 lines, one type + three functions. The NDJSON `readLines` async generator is clean.
- Cost rollup (`totalCostUsd`, used in list/status) is implemented (addressing prior audit finding 6 — good).
- Model pinning hook (`deny-anthropic-models.sh`) is implemented (addressing prior audit finding 7 — good).
- The `role: "leaf"` spawn option is added (addressing prior audit finding 3 operational — good).

---

## Critical Issues for Phase 2 Context

The following findings inform Phase 2 (Security & Performance):

1. **A2 — Host-tool registration missing.** If msg/task_create capabilities are misleading users, Phase 2 should confirm no security risk from advertising capabilities that don't exist.
2. **Q3 — jq shells out to an OS binary.** Security concern: command injection via jq expression. `jq-filter.ts:10` passes `expr` from the MCP tool call directly to `Bun.spawn(["jq", "-c", expr])`. Bun's spawn handles args safely (not shell), but the expression string itself could trigger unintended jq behavior.
3. **Q5 — buildMonitorCmd embeds bash.** The `logPath` is escaped with `replace(/'/g, "'\\''")`, but the command template is complex enough that a carefully crafted logPath could escape. Long shot, but the whole monitor mechanism needs review.
4. **A4 — send races with agent_end.** Message delivery is unconfirmed, which has operational reliability implications.
5. **A7 — Unbounded `totalCostUsd` loop.** Performance impact at scale.

---

## Prior Audit Reconciliation

| Finding | Status | Current |
|---|---|---|
| Arch 1: CLAUDE.md injection | **PERSISTS** | Not addressed |
| Arch 2: No host-tool registration | **PERSISTS** | Handlers exist, no registration sent |
| Arch 3: In-memory only registry | **PERSISTS** | Not addressed |
| Op 1: send races agent_end | **PERSISTS** | Not addressed |
| Op 2: modified_files always empty | Could not reproduce from source — tracking logic exists | Needs live verification |
| Op 3: leaf role option | **ADDRESSED** | `role: "leaf"` at spawn |
| Op 4: Digest drop empty msgs | **ADDRESSED** | summarize.ts:145-150 |
| Op 5: Widen monitor_cmd to errors | **NOT ADDRESSED** | Still only greps agent_end |
| Op 6: Cost rollup | **ADDRESSED** | totalCostUsd in list/status |
| Op 7: Model pinning hook | **ADDRESSED** | deny-anthropic-models.sh |

---

## Module Dependency Summary

```
server.ts → agent.ts, jq-filter.ts, registry.ts, schema.ts, summarize.ts, ui-bridge.ts, frames.ts
agent.ts → frames.ts
registry.ts → agent.ts, frames.ts
summarize.ts → agent.ts, frames.ts
ui-bridge.ts → frames.ts
jq-filter.ts → agent.ts
schema.ts → (standalone, no imports)
frames.ts → (standalone, no imports)
```

Clean dependency tree (no cycles). `server.ts` is the sole orchestrator importing 6 of 7 other modules. `frames.ts` and `agent.ts` are the foundation. `schema.ts` is a pure data file. 

---

## Executive Summary

Code quality is **sound but has systematic debt in error handling** — the catch-ignore pattern makes failure paths opaque. The architecture has **two unfixed critical issues** from the prior audit (CLAUDE.md injection, missing host-tool registration) that will cause recurring confusion and "broken feature" reports until resolved. The codebase shows good taste in module boundaries and the NDJSON frame model, but `server.ts` is overdue for extraction from its 725-line monolithic function.
