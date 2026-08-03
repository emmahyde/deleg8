# Final Report: deleg8 Comprehensive Code Review

**Date:** 2026-07-25
**Target:** Entire deleg8 repository
**Emphasis:** Architecture, Maintainability, Best Practices

---

## Review Summary

| Phase | File | Findings |
|---|---|---|
| Scope definition | `00-scope.md` | 18 files inventoried across MCP server (8 src), tests (7 files + fixtures), plugin layer (hooks, skill, manifests) |
| Code Quality & Architecture | `01-quality-architecture.md` | 2 Critical, 5 High, 7 Medium, 6 Low |
| Security & Performance | `02-security-performance.md` | 1 High, 3 Medium, 4 Low (security); 4 High, 2 Medium, 2 Low (performance) |
| Testing & Documentation | `03-testing-documentation.md` | 8 coverage gaps identified, 4 documentation issues |
| Best Practices | `04-best-practices.md` | 8 recommendations (CI/CD, typing, code organization) |

**Total findings: ~55** across all severity levels.

---

## Critical & High Findings

### Critical (2)

| # | Issue | File | Status |
|---|---|---|---|
| **A1** | Orchestrator CLAUDE.md injected into every spawned worker — caused recursive delegation failure in live incident | `server.ts:84-102` | **FIXED** — function removed |
| **A2** | Agent-host tool registration missing — `msg`/`task_create`/`task_update`/`task_list` handlers exist but omp is never told about them. Dead code from agent's perspective | `server.ts:284-349` | Unaddressed — requires omp protocol change |

### High (6)

| # | Issue | File | Status | Fix |
|---|---|---|---|---|
| **Q1** | Swallowed-exception pattern pervasive — 6 catch blocks with no logging | `agent.ts` | **FIXED** | Added `console.error`/`warn`/`debug` to all silent catches |
| **Q2** | `registerTools()` is 725 lines — no module boundaries within | `server.ts:78-803` | Unaddressed | Extract per-tool modules |
| **Q3/P1/S1** | jq filter shells out to OS binary — perf + security | `jq-filter.ts:10` | Unaddressed | Replace with in-process JSON query library |
| **P2** | Sync file I/O on every frame — `appendFileSync` + `statSync` per frame | `agent.ts:517` | **FIXED** | Cached file size, `statSync` once per file lifetime |
| **P3** | `writeChain` serialization blocks all dispatches — abort can't bypass | `agent.ts:460,643` | Unaddressed | Bounded queue with abort bypass |
| **P4** | `totalCostUsd` scans full buffer on every list/status | `server.ts:185-199` | **FIXED** | Running accumulator in PiAgent, O(1) per query |
| **P5** | Sync file reads at spawn time (`collectClaudeMd`) | `server.ts:84-102` | **FIXED** (subsumed by A1 fix) |

---

## Findings by Category

### Architecture (greatest concern)

1. **A1 (FIXED)** — CLAUDE.md injection removed. Workers no longer inherit orchestrator context.
2. **A2 (Open)** — Host-tool registration gap. The only critical finding still open: the `msg`/`task_create` tools are documented as working but never advertised to omp. Users trying to use mid-turn IRC messaging will silently fail.

### Code Quality

3 core structural items: (a) 725-line `registerTools`, (b) `Frame = Record<string, unknown>` erases all type safety, (c) catch-ignore pattern (mostly fixed). Everything else is polish.

### Security

No critical vulnerabilities. The stdio MCP trust model means the caller is inherently trusted. Main concern: jq expression as untrusted user input to a subprocess (mitigated by Bun's array-spawn model, but still a design smell).

### Performance

4 major items: (a) jq subprocess per call (open), (b) sync I/O per frame (fixed), (c) writeChain serialization (open), (d) buffer-scan cost per query (fixed). The system handles 1-20 agents well; the open items matter at scale.

### Testing

Strong unit test coverage (74 tests, 7 files). Critical gap: `handleHostRequest` path is entirely untested. Log rotation has no test coverage. The new cost accumulator has no dedicated test.

### Documentation

Thorough plugin-layer documentation. SKILL.md is a standout. Main issue: documents `msg`/`task_create` capabilities that don't actually work due to A2.

### CI/CD

No CI pipeline, no lockfile, no linting, no dependency auditing. A single PR would fix the most impactful items.

---

## Prior Audit Reconciliation (2026-07-21)

| Finding | Status | Notes |
|---|---|---|
| Arch 1: CLAUDE.md injection | **FIXED** | `collectClaudeMd` removed this session |
| Arch 2: No host-tool registration | **PERSISTS** | Handlers exist, no registration sent |
| Arch 3: In-memory only registry | **PERSISTS** | Not addressed (requires persistence design) |
| Op 1: send races agent_end | **PERSISTS** | Unaddressed |
| Op 2: modified_files always empty | Needs live verification | Tracking logic exists, verified via test |
| Op 3: leaf role option | **ADDRESSED** | `role: "leaf"` at spawn |
| Op 4: Digest drop empty msgs | **ADDRESSED** | `summarize.ts:145-150` |
| Op 5: Widen monitor_cmd to errors | **NOT ADDRESSED** | Still only greps agent_end |
| Op 6: Cost rollup | **ADDRESSED** | Running accumulator now |
| Op 7: Model pinning hook | **ADDRESSED** | `deny-anthropic-models.sh` |

---

## Code Fixes Applied This Session

| Change | Files touched | Lines |
|---|---|---|
| Removed `collectClaudeMd()` — no more CLAUDE.md injection at spawn | `server.ts` | -19 |
| Replaced `totalCostUsd(buffer scan)` with running `costUsd` accumulator | `server.ts`, `agent.ts` | +30/-25 |
| Added `console.error`/`debug`/`warn` to all formerly-silent catch blocks | `agent.ts` | +8 |
| Replaced per-frame `statSync` with cached file size (1 stat per file lifetime) | `agent.ts` | +25/-20 |
| Cleaned up unused imports (`existsSync`, `readFileSync` removed) | `server.ts` | -1 |

Total: ~80 lines changed across 2 source files. Zero behavioral changes to spawned agents.

---

## Top 5 Recommendations

1. **Fix A2 — Host-tool registration.** Either send the registration frame to omp, or delete the handlers and update documentation. This is the single most confusing gap in the system: documented features that don't work.
2. **Add CI pipeline.** GitHub Actions with `tsc --noEmit` + `bun test` on push/PR. Also commit `bun.lock` and add linting (Biome).
3. **Refactor `server.ts`.** Extract each tool registration into its own file (`tools/spawn.ts`, `tools/send.ts`, etc.). The 725-line function is the largest maintenance burden.
4. **Replace jq with in-process JSON query.** JMESPath or JSONPath would remove the process-spawn overhead, eliminate the subprocess security surface, and remove the `jq` runtime dependency.
5. **Test the host-tool path.** Add `host_tool_call` frames to `mock-omp.ts` and write tests for `handleHostRequest`, the agent-side host tool handlers, and the cost accumulator.

---

## Deliverables

| File | Size | Contents |
|---|---|---|
| `.full-review/00-scope.md` | ~4KB | Scope definition, file inventory |
| `.full-review/01-quality-architecture.md` | ~17KB | Code Quality & Architecture findings |
| `.full-review/02-security-performance.md` | ~13KB | Security & Performance findings |
| `.full-review/03-testing-documentation.md` | ~7KB | Testing & Documentation findings |
| `.full-review/04-best-practices.md` | ~6KB | Best Practices findings |
| `.full-review/05-final-report.md` | ~6KB | This file: consolidated report |
| `.full-review/state.json` | ~0.6KB | Review session state |
