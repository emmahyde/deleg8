# Review Scope

## Target

Entire `deleg8` repository at `/Users/emmahyde/projects/deleg8` — a Claude Code plugin that makes oh-my-pi persistent subagents the default delegation mechanism. Two layers:

1. **Plugin layer** — skill markdown, PreToolUse enforcement hook, manifests, MCP config.
2. **MCP server** (`pi-agent-mcp/`) — Bun/TypeScript server wrapping `omp --mode rpc` as named, persistent subagents (7 tools: spawn, send, output, status, list, stop, prune).

Excluded: `banks/` (runtime SQLite memory DB, not source), `.git/`, lockfiles.

## Files

### MCP server source (`pi-agent-mcp/src/`)
- `server.ts` (34.7 KB) — MCP server, tool handlers
- `agent.ts` (26.6 KB) — omp agent lifecycle (spawn/send/stop, process management)
- `summarize.ts` (8.1 KB) — frame digest/summary logic
- `registry.ts` (3.3 KB) — agent registry
- `schema.ts` (5.6 KB) — tool schemas/validation
- `jq-filter.ts` (1.3 KB) — jq projection of frames
- `ui-bridge.ts` (4.5 KB) — UI bridge
- `frames.ts` (1.1 KB) — frame types

### MCP server tests (`pi-agent-mcp/tests/`)
- `server.test.ts` (16.6 KB), `agent.test.ts` (14.3 KB), `summarize.test.ts` (6.7 KB)
- `parent-death.test.ts` (3.7 KB), `ui-bridge.test.ts` (5.0 KB), `frames.test.ts` (2.8 KB), `jq-filter.test.ts` (1.6 KB)
- `fixtures/mock-omp.ts` (7.6 KB)

### Plugin layer
- `skills/deleg8/SKILL.md` (7.4 KB) + `references/` (frame-catalog.md, when-to-use.md, tools.md)
- `hooks/deny-anthropic-models.sh` (817 B), `hooks/hooks.json` (1.0 KB)
- `.claude-plugin/plugin.json`, `.mcp.json`, `.gitignore`
- `README.md`
- `pi-agent-mcp/package.json`, `tsconfig.json`

### Context (reference only, not reviewed)
- `docs/audit-arch-2026-07-21.md` — prior architectural audit (10.8 KB)

## Flags

- Security Focus: no
- Performance Critical: no
- Strict Mode: no
- Framework: bun/typescript-mcp (auto-detected)
- **User emphasis: architecture, maintainability, best-practices** — weigh these dimensions heavily in every phase

## Review Phases

1. Code Quality & Architecture
2. Security & Performance
3. Testing & Documentation
4. Best Practices & Standards
5. Consolidated Report
