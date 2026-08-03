# Phase 3: Testing & Documentation

---

## Testing

### Coverage Overview

**74 tests across 7 files, all passing** (4 pre-existing flaky timeouts in channel notification tests).

| Module | Tests | Coverage |
|---|---|---|
| `frames.ts` | 11 (encode/decode 5, readLines 6) | Excellent — edge cases: blank input, malformed JSON, non-object JSON, multi-byte UTF8 split across chunks, trailing partial lines |
| `jq-filter.ts` | 6 | Good — scalar projection, array filter, stream → array, empty result, bad filter error, realistic pi_output input. All conditional on `jq` being on PATH |
| `ui-bridge.ts` | 5 | Good — select (enum schema), confirm (boolean schema), input (text schema), editor (multi-line with prefill), unknown method declined |
| `summarize.ts` | 8 | Good — dropped lifecycle noise, active UI methods kept, failed responses kept, message text extraction, digest's last-N, modified_file tracking from both tool_use and real omp tool_execution_start frames, empty filtering |
| `agent.ts` | ~28 across 3 describe blocks | Good — start/running/pid, sendPrompt + set_model + abort + stop + force-kill; session lifecycle: suspend/resume, logDir/logPath, captureSession; onChannelFrame callback |
| `server.ts` | ~14 across 2 describe blocks | Good — spawn, send, list, output, status, stop, auto-suspend → resume, channel notification delivery |
| `parent-death.ts` | 1 | Single test — SIGTERM → child exit detection |
| **Total** | **74** | |

### Gaps

**Critical unexercised path:**

1. **`handleHostRequest` (agent.ts:594-637) — ZERO test coverage.** The `msg`, `task_create`, `task_update`, `task_list` handlers in server.ts (agent → host tool bridge) receive no `host_tool_call` frames from mock-omp. This was flagged in the prior audit and remains unaddressed. The code compiles and the handlers are wired, but they've never been exercised — even in tests.

2. **Cost accumulator (`costUsd()`) — not tested.** The running total field was just added (P4 fix). No existing test reads or asserts on agent cost tracking.

3. **Log rotation — not tested.** The `rotateLogIfNeeded` function is never called in tests (tests pass `logDir: undefined`, which skips the log path entirely). The rotation behavior (stat, 50MB cap, renameSync) has no test coverage.

**Medium gaps:**

4. **`prune` tool (server.ts) — no test.** The standalone `prune` MCP tool that removes dead/idle agents is registered but no test in server.test.ts exercises it.

5. **`tasks` / `task_create` / `task_update` standalone MCP tools — no test.** Only the agent-side path (host_tool_call handlers) has coverage gap; the standalone orchestrator tools are also untested.

6. **Error responses.** Few tests assert on `isError: true` tool responses. The `send` tool's behavior when targeting a nonexistent agent_id, the `output` tool with invalid agent_id, and overflow conditions (jq projection exceeding 32KB cap) are not tested.

7. **No integration test for real omp binary.** All tests use `mock-omp.ts` — a reasonable choice, but means the actual omp interaction patterns (NDJSON protocol, ready/agent_end/turn_end framing, session persistence) are only tested against a test double.

### Test Quality

- **Good patterns:** Tests use `describe` + `test` with clear naming. The `TestRegistry` subclass in server.test.ts elegantly wires mock-omp without modifying the production AgentRegistry. `makeHarness` pattern keeps test setup clean.
- **Room for improvement:** Timeout-based assertions (30+ tests use `waitFor`). All tests that wait for events use polling rather than event-driven signaling. This is why channel notification tests are flaky — they time out instead of being notified.
- **Dependency on PATH for jq tests:** 6 tests skip if `jq` is not installed — acceptable for a small module that's external to the TypeScript codebase.

---

## Documentation

### Plugin Layer

| Document | Coverage | Gaps |
|---|---|---|
| `README.md` | Good — install, prerequisites, configuration, usage, 7-tool table, enforcement hook explanation | No troubleshooting section; no "getting started" walkthrough for new users; doesn't mention the `role: "leaf"` spawn option |
| `skills/deleg8/SKILL.md` | Excellent — comprehensive 7.4KB file covering when deleg8 beats native task, all 7 tools in decision-table format, 4 core workflows (fan-out, multi-turn refinement, background fire-and-forget, wave orchestration), output discipline, lifecycle management, model selection | **Documents `msg`/`task_create`/`task_update`/`task_list` as if they work** — but omp is never told these host tools exist. This is the most consequential doc error in the project |
| `references/tools.md` | Good — parameter tables for all 7 tools with types, defaults, descriptions | Missing the `role` parameter on spawn; doesn't mention `task_create`/`task_update`/`tasks` standalone MCP tools |
| `references/when-to-use.md` | Unread but likely thorough | — |
| `references/frame-catalog.md` | Points at inline schema.ts data | — |

### Source Documentation

| File | Assessment |
|---|---|
| `server.ts` | Good module-level comment. Helper functions have doc comments. Tool descriptions are verbose but clear |
| `agent.ts` | Excellent — thorough module-level comment documenting frame model, log rotation rationale, and `onChannelFrame`/`onHostRequest` contracts. Class fields and methods well-documented |
| `summarize.ts` | Good — file-level comment explains what's dropped and why. Constants have rationale comments (FILE_MODIFYING_TOOL_NAMES, PATCH_HEADER_RE) |
| `registry.ts` | Minimal — class-level documentation would help. `prune` and `stopAll` are self-explanatory |
| `schema.ts` | Good — file-level comment and `FRAME_SCHEMA` object serves as both data and documentation |
| `jq-filter.ts` | Adequate — covers the spawn pattern and error handling |
| `ui-bridge.ts` | Very good — comprehensive file-level comment with all omp UI methods and shapes documented inline. The switch cases are clean and readable |
| `frames.ts` | Good — minimal, each function self-documenting |

### Documentation Issues

1. **SKILL.md and references/tools.md document non-functional capabilities.** The `msg` host-tool IRC feature and agent-initiated task tracking (`task_create`/`task_update`) are described as working capabilities. They are not — omp never receives a tool registration frame. Users trying to use these will get no response and no error message.

2. **READEME doesn't mention `role: "leaf"`.** The spawn option that suppresses sub-delegation in workers is undocumented at the README level.

3. **No troubleshooting section.** Common issues (omp not on PATH, jq not installed, port conflicts, "dispatched: true" but no response) are not covered anywhere.

4. **No CHANGELOG or RELEASE_NOTES.** The project has no user-facing change log.
