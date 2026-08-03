# Phase 4: Best Practices & Standards

---

## TypeScript / Bun Framework Practices

### Strict Mode Compliance

`tsconfig.json` has `"strict": true` — **good**. This enables all strict checks (strictNullChecks, noImplicitAny, etc.).

However, the codebase makes heavy use of runtime type assertions that undermine strict mode's guarantees:

- `Frame = Record<string, unknown>` (frames.ts:3) — the universal type for all frame data. Every consumer must cast: `as Record<string, unknown>`, `as unknown as import("./frames.ts").Frame`. This pattern is idiomatic for a dynamic NDJSON bridge but effectively bypasses the type system.
- **No branded types** for agent IDs, session IDs, or frame IDs — they're all `string`. A function that expects a `sessionId` can receive an `agentId` without compile error.
- **No discriminated unions** for frame types. While `frame.type` is checked at runtime, TypeScript never narrows the type based on it.

**Recommendation:** At minimum, add a discriminated union for the frame types the system controls (`ready`, `prompt`, `response`, `abort`, `set_model`, `get_state`, `extension_ui_request`, `host_tool_call`). The NDJSON boundary is dynamic, but internal handling can be typed.

### Module Format

- `"module": "ESNext"`, `"moduleResolution": "bundler"`, `"verbatimModuleSyntax": true` — correct for Bun.
- `"allowImportingTsExtensions": true` — Bun-native, matches bun run convention.
- `"types": ["bun-types"]` — correct.

### Error Handling Pattern

The `guard<T>(fn)` wrapper at `server.ts:153-161` is a good pattern but has two issues:
1. Non-`PiAgentError` exceptions are wrapped as `unexpected: ${msg}` — losing stack traces.
2. It returns `fail()` on the error path, meaning tool handlers must de-alias success vs error results differently. The MCP SDK already distinguishes errors via `isError: true` in the response — `guard` should pass the error type through cleanly.

### Async Cleanup

- `Promise.allSettled` is used in `stopAll()` (registry.ts:102) — correct for graceful shutdown where some agents may already be dead.
- No explicit `AbortController` or cancellation token pattern — reads and writes rely on process exit to clean up.

### Logging Standards

- All logs prefixed with `deleg8:` — consistent. `console.error` for unexpected failures, `console.warn` for degraded but recoverable states, `console.debug` for routine shutdown noise. Good.
- Fire-and-forget notifications use `.catch((err) => console.error(...))` — acceptable for best-effort push.

---

## CI/CD & DevOps

### CI Pipeline

No CI configuration exists in the repository (no `.github/workflows/`, `.gitlab-ci.yml`, or similar).

Missing:
- **No automated type check** (`tsc --noEmit`) in CI
- **No automated test run** (`bun test`) in CI
- **No linting** (no ESLint, Biome, or similar configuration)
- **No dependency audit** (no `npm audit`, `snyk`, or Dependabot)
- **No build verification** (no `bun run build` check)
- **No release workflow** (no auto-changelog, version bump, or tag creation)

### Dependency Management

- **2 runtime dependencies:** `@modelcontextprotocol/sdk ^1.18.0`, `zod ^3.23.8`. Both well-maintained with no known CVEs.
- **2 dev dependencies:** `@types/bun`, `typescript ^5.6.0`.
- **No lockfile checked in** (`package.json` exists but no `bun.lock` or `yarn.lock` in the repo root). First-time installs may get different sub-dependency versions.
- **No dependabot or renovate configuration.** Dependency updates are manual.

### Tooling

- `"typecheck": "tsc --noEmit"` — useful script exists.
- `"test": "bun test"` — standard.
- `"build": "bun build src/server.ts --target=bun --outfile=dist/deleg8.js"` — present but the output `dist/` directory is not in `.gitignore`.
- `"inspector": "bunx @modelcontextprotocol/inspector bun run src/server.ts"` — useful dev tool, documented.

### Security Scanning

- No SAST/SCA tooling configured.
- The hook-based model denial (`deny-anthropic-models.sh`) is the only security enforcement — it works, but has a silent-fail path if jq parsing fails (noted in Phase 2, S5).

---

## Code Organization & Conventions

### File Size

| File | Lines | Assessment |
|---|---|---|
| `server.ts` | ~840 | **Too large** — the 725-line registerTools function dominates. Should be extracted into per-tool files |
| `agent.ts` | ~730 | **Large but cohesive** — a single class with clear life-cycle responsibilities. Acceptable at this size |
| `summarize.ts` | ~220 | Appropriate |
| `registry.ts` | ~110 | Appropriate |
| `schema.ts` | ~130 | Appropriate — data file |
| `ui-bridge.ts` | ~150 | Appropriate |
| `jq-filter.ts` | ~40 | Appropriate |
| `frames.ts` | ~42 | Appropriate |

### Naming

- Snake_case for MCP tool parameter names (`agent_id`, `initial_prompt`, `extra_args`, `timeout_ms`, `rpc_mode`) — consistent with the MCP SDK convention.
- camelCase for internal code (`agentId`, `logPath`, `messageCount`, `sessionDir`) — consistent TypeScript convention.
- Prefix convention: `mcp__deleg8__<tool>` for MCP tool names — correct for MCP namespace.
- `PiAgent`, `PiAgentError`, `PiAgentServerOptions`, `PiAgentServerHandle` — consistent naming but unnecessarily redundant with the import path (just `Agent`/`AgentError` would suffice).

### Imports Organization

```
node: builtins
@modelcontextprotocol/sdk + zod (external)
./agent.ts, ./jq-filter.ts, ... (internal)
```

Consistent pattern across all files. Good.

### Test File Placement

Tests live in `tests/` at the package root. Source in `src/`. Co-location of test files near source (e.g. `src/frames.test.ts`) is another valid convention this project doesn't follow, but the separate directory is fine.

---

## Recommendations

| # | Area | Finding | Action |
|---|---|---|---|
| B1 | CI/CD | No CI pipeline | Add GitHub Actions: `tsc --noEmit` + `bun test` on push/PR |
| B2 | CI/CD | No lockfile checked in | Run `bun install` and commit `bun.lock` |
| B3 | CI/CD | No build artifact cleanup | Add `dist/` to `.gitignore` |
| B4 | TypeScript | Runtime type assertions everywhere | Add discriminated union for known frame types |
| B5 | Code organization | server.ts too large | Extract per-tool registration files |
| B6 | Best practice | No linting config | Add Biome or ESLint for consistent formatting |
| B7 | Best practice | No changelog | Add CHANGELOG.md or use GitHub Releases |
| B8 | Framework | Names okay but `Pi` prefix redundant | Minor — only worth changing if renaming other exports |
