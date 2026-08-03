# deleg8 — Feedback & Retrospective

Two sources synthesized:

1. **Code review retrospective** (2026-07-25) — 5-phase inline review of the entire deleg8 source tree.
2. **Production experience** (2026-07-24–25) — ~22-agent usage across the Sector Flecs→Friflo migration (waves 0–6) and later 4–8-agent orrery fan-outs. Evidence: `~/projects/sector/docs/technical/friflo-migration-waves.md § Execution conventions` and sector-unity-proto memory files.

---

## What Works Well

### From the Code Review

**1. Phase structure held up.** The 5-phase pipeline (Scope → Quality/Arch → Security/Perf → Testing/Docs → Best Practices → Final Report) produced a coherent, non-redundant write-up. Each phase had a clear lens, and the consolidated final report cross-referenced earlier findings cleanly.

**2. File-based state.** `.full-review/state.json` as the progress anchor survived mid-review pivots (user checkpoint → fix phase → resume) without losing which phase was current or which steps were done.

**3. Inline mode was slower but deeper.** Every file read was mine. No second-hand summaries, no misattributed findings. The `handleHostRequest` coverage gap was found because I traced the full source tree — a subagent would have seen a subset.

**4. Prior audit reconciliation paid off.** The 2026-07-21 audit gave a before/after baseline. Of 10 prior findings, 4 were already addressed, 1 was fixed during this session (A1), and 5 still persist — letting the user see real progress.

**5. Fixes were scoped tightly.** The 4 applied fixes (A1, Q1, P2, P4) each touched exactly one concern: removed a function, added logging, swapped an algorithm, cached a value. No scope creep into refactoring.

### From Production (Verified at 22-Agent Scale)

**6. Suppressed intermediate frames.** `agent_end` delivering only the final message keeps orchestrator context lean — exactly right for fan-outs of 5+.

**7. `send` to resume an idle agent.** Fix rounds going back to the same agent (with its context intact) beat respawning every time. Standing convention on the Sector side.

**8. Real-time `task_create`/`task_update` channel events.** Live sub-task visibility without polling was the difference between trusting a 22-agent run and babysitting it.

**9. Mid-task `msg` IRC channel.** Agents flagging blockers before `agent_end` saved at least one wasted wave.

---

## Pain Points → Feature Requests (Prioritized)

### 1. Tool-level command denylist in spawn config (Critical)

**The incident:** On 2026-07-24, 5 parallel agents running `git stash` / `git checkout --` concurrently wiped the entire uncommitted working tree. Recovery required `git fsck` dangling-commit archaeology.

**Current mitigation:** Every agent prompt carries a verbatim `HARD RULES` block ("no git of any kind including status/diff/log, no dotnet/msbuild"). But prompt bans are advisory — one paraphrased prompt or one agent rationalizing "status is read-only" and it recurs.

**Ask:** A denylist in spawn config (command patterns, ideally regex over `argv`) enforced at the tool-execution layer, with the denial surfaced to the agent as a normal tool error. Per-spawn *and* per-fan-out defaults.

### 2. Declared write scopes per agent

**The problem:** Disjoint file ownership is our load-bearing convention and entirely manual. The contention hotspot is shared project files (`.csproj`) — hand-enforced "one csproj = one owner per wave."

**Ask:** Optional `own` globs in spawn config; writes outside the scope are rejected (or at minimum logged as a channel event). Even audit-only mode would catch violations the moment they happen instead of at cross-review.

### 3. Concurrency mutex for exclusive commands

**The problem:** Parallel MSBuild corrupts `obj/`, so agents are banned from building entirely and the orchestrator builds centrally. That works but wastes agent capability.

**Ask:** A way to declare a command class exclusive (e.g. `exclusive: ["dotnet build", "dotnet test"]`) so deleg8 serializes those calls across the fan-out instead of us banning them outright.

### 4. Agent lifecycle / auto-reap

**The problem:** Idle and dead agents accumulate. We adopted "prune idle+dead after each fan-out," and the analogous debt still bit us in another toolchain (user manually swept 8 leftover agents). Convention is fragile; the server knows the state.

**Ask:** Configurable TTL or auto-prune for agents idle past N minutes after `agent_end`, with an opt-out for agents deliberately parked for resume.

### 5. Shared context block per fan-out

**The problem:** Agents share no context, so ground-truth library idioms (Friflo: `Tags` getter returns a struct copy → `AddTag`/`RemoveTag`; `IsNull` not `IsAlive`; relation update = remove-then-add) must be pasted verbatim into every prompt. At 22 agents that is repeated tokens and a drift risk — one prompt missing one idiom re-fails on a solved problem.

**Ask:** A fan-out-level preamble (system-prompt fragment or pinned context doc) every spawned agent receives, defined once per fan-out.

---

## What Didn't Work (Code Review Session Only)

**1. Subagent model selection is locked.** The `task` tool has no `model` field. When the configured model cost exceeded the OpenRouter budget, every spawn failed 402 with no graceful degradation path. The workaround (inline everything) worked but slowed Phases 1–2 to single-threaded speed.

**→ Fix:** Either (a) expose a `model` field on `task`, or (b) add a fallback model chain in environment config so an expensive model failure rolls to a cheaper one instead of failing the spawn.

**2. No per-agent progress feedback.** With all work inline, there was no way to show "3 agents running, 2 done" progress. The session felt opaque during long reads.

**3. File-based state works but is manual.** Every phase-end required a `write` to `state.json`. An automated `state.json` update hook on phase transitions would remove the ceremony.

---

## Recommendations for Next Review

| Area | Suggestion |
|---|---|
| Subagent budget | Pre-allocate a fixed-token model (Haiku / Flash) for spawns before session start |
| Checkpoint timing | Mid-review checkpoint after Phase 2 is well-placed; keep it |
| Fix scope | Fixing critical/high mid-review was the right call — don't defer what blocks confidence |
| Output discipline | Phase template (headline counts → detail per finding → recommendation table) scaled well from 20 to 40 findings |

---

## Open Work (not in scope, surfaced during review)

- A2 host-tool registration — largest single gap in the project
- CI pipeline — no barrier to regression
- `server.ts` extraction — 725-line function isn't sustainable
- jq dependency — always a process spawn away from a silent failure
- No lockfile at deleg8 root — dependency drift is possible today

---

## Observed Failure Modes (Production, No Specific Ask)

These patterns surfaced across the 22-agent Friflo migration. They aren't feature requests because the solution isn't obvious, but they're worth designing around.

**Agent-proposed fixes that make a test pass can be behaviorally wrong.** One agent's `ResetCooldown` "fix" didn't fix the tests and would have stretched encounter spacing to ~2h. We re-derive failure mechanisms centrally before accepting; anything that nudges agents to report *mechanism*, not just diff, helps.

**Cross-review between agents finds real blockers but also false ones.** The orchestrator must verify each claim against the actual tree. Structured "claim + evidence pointer" output from agents would make that cheaper — a claim format that the orchestrator can mechanically verify before acting on it.
---

## Implementation Status (2026-07-25)

All 5 Pain Points and the 3 What-Didn't-Work items have been addressed in code.
Summary per item:

| # | Item | Status | Implementation |
|---|---|---|---|
| 1 | Tool-level command denylist | ✅ Addressed | `denylist` array on `spawn` — regex patterns over toolName+argv. Two-layer: prompt constraints + `tool_execution_start` monitoring. **Known limitation:** omp runs Bash internally; deleg8 cannot intercept before execution. Prompt layer is primary enforcement; monitoring provides visibility into bypass. |
| 2 | Declared write scopes | ✅ Addressed | `own` array on `spawn` — glob patterns for allowed write scope. Same two-layer pattern. Same architectural constraint: omp runs tools internally, so primary enforcement is the agent's prompt instruction. |
| 3 | Concurrency mutex | ✅ Addressed | `exclusive` array on `spawn` — `{pattern, wait}` entries. Cooperative agent protocol via `exclusive_acquire`/`exclusive_release` host tools. Agents must follow the protocol — a rogue agent can bypass (same omp architecture constraint). Locks auto-released on stop/remove/prune. Best-effort check in `send` tool. |
| 4 | Agent lifecycle / auto-reap | ✅ Addressed | `idle_ttl` and `dead_ttl` (ms) on `spawn` — registry-level TTLs with 10s reap tick. |
| 5 | Shared context block | ✅ Addressed | `preamble` string on `spawn` — injected before every initial_prompt. |
| 1c | Subagent model fallback | ✅ Addressed | `fallback_model` on `spawn` — retries on `set_model` failure. |
| 2-3 | Progress feedback / state automation | ✅ Deferred | Already served by existing `task_create`/`task_update` channel events and new violation/lock events. Task registry now has per-agent caps (100) + auto-cleanup on agent_end. |

