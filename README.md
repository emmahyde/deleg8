# deleg8

An MCP server that exposes [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp --mode rpc`) as a fleet of **named, resumable subagents** addressable from Claude Code — mirroring the surface of the native `Agent` + `SendMessage` tools.

Each agent is an `omp --mode rpc-ui` subprocess with session persistence. Agents auto-suspend after completing their work (`agent_end`) and transparently resume via `--resume <sessionId>` on the next `pi_send`, preserving full conversation context across pauses. Multiple agents run concurrently under different IDs.

## Why

Claude Code's native `Agent` / `SendMessage` lets you spawn sub-Claude sessions and resume them by ID. This server gives you the same primitive for `omp`: spawn it once, keep pushing prompts at it, read its output, kill it when done. Agents inherit your `CLAUDE.md` preferences automatically.

## Install

```bash
bun install
```

Then wire it into Claude Code. **User-level** (`~/.mcp.json`, applies everywhere):

```jsonc
{
  "mcpServers": {
    "deleg8": {
      "command": "bun",
      "args": ["run", "/path/to/deleg8/src/server.ts"]
    }
  }
}
```

Or **project-level** (`.mcp.json` in the project root, committed for the team):

```jsonc
{
  "mcpServers": {
    "deleg8": {
      "command": "bun",
      "args": ["run", "./src/server.ts"],
      "env": { "OMP_BIN": "omp" }
    }
  }
}
```

Set `OMP_BIN` if `omp` isn't on the spawning shell's `PATH` (e.g. `/Users/you/.bun/bin/omp`).

## Tools

| Tool        | Mirrors             | Purpose                                                          |
|-------------|---------------------|------------------------------------------------------------------|
| `pi_spawn`  | `Agent`             | Launch a new `omp` subprocess, optionally send first prompt      |
| `pi_send`   | `SendMessage`       | Send another prompt to an existing agent (auto-resumes if idle)  |
| `pi_list`   | `TaskList`          | List every registered agent and its state                        |
| `pi_status` | `TaskGet`           | Detailed status for one agent                                    |
| `pi_output` | `TaskOutput`        | Read buffered frames (digest/summary/raw with jq projection)     |
| `pi_stop`   | `TaskStop`          | Send `abort`, terminate, remove from registry                    |
| `pi_prune`  | —                   | Drop dead/idle agents from the registry                          |

### Background mode + Monitor

`pi_spawn` and `pi_send` support `background: true` to return immediately. The response includes a `monitor_cmd` — a bash one-liner you can pass to Claude Code's `Monitor` tool. It tails the NDJSON log, waits for `agent_end`, extracts the final assistant message, and prints it. You get an automatic notification when the agent finishes.

### Agent lifecycle

```
pi_spawn → running → (tool calls, thinking) → agent_end → idle (proc killed, session on disk)
                                                              ↓
pi_send  → resume (--resume <sessionId>) → running → ... → agent_end → idle
                                                              ↓
pi_stop  → removed from registry
```

### Clarifying questions (MCP elicitation)

Agents spawn in `--mode rpc-ui` by default, which lets omp emit `extension_ui_request` frames mid-turn. The wrapper bridges these to **MCP elicitation** (`elicitInput`), so Claude Code surfaces the question to you and forwards your answer back. Methods: `select`, `confirm`, `input`, `editor`. Pass `rpc_mode: "rpc"` to disable.

### CLAUDE.md injection

On `pi_spawn`, the server reads `~/.claude/CLAUDE.md` (user-level) and `<cwd>/CLAUDE.md` or `<cwd>/.claude/CLAUDE.md` (project-level) and prepends them to the initial prompt. Agents inherit your conventions automatically.

### Frame model

omp speaks NDJSON over stdio:

```
> {"id":"r1","type":"prompt","message":"list .ts files"}
< {"id":"r1","type":"response", ...}
> {"id":"r2","type":"set_model","provider":"anthropic","modelId":"sonnet-4.5"}
> {"id":"r3","type":"abort"}
```

Frame IDs are auto-generated and correlated. Every frame is buffered (cap: 1024) for `pi_output`. The resource `deleg8://schema/frames` has the full frame catalog + jq examples.

## Smoke test with MCP Inspector

```bash
bun run inspector
```

Opens the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) at `http://localhost:5173`. Try:

1. `pi_spawn` with `initial_prompt: "echo hello"` → returns `agent_id` and response.
2. `pi_send` with that `agent_id` and `message: "what did I just ask?"` → context is preserved.
3. `pi_list` → see the agent listed.
4. `pi_stop` → clean up.

## Development

```bash
bun run typecheck   # tsc --noEmit
bun test            # 55 tests across 7 files
bun run dev         # bun --watch
bun run build       # bundle to dist/
```

## Caveats

- Output buffer is bounded at 1024 frames per agent — older frames drop off. Use `pi_output` with `since_seq` to stream incrementally.
- `pi_send` with `wait: true` (default) blocks until a `response` frame arrives. Intermediate event frames accumulate in the buffer.
- Elicitation requires the MCP client to support `elicitation/create`. Claude Code does; some other clients don't yet.
- The server registers no host tools or URI schemes. If omp tries `host_tool_call` / `host_uri_request` it gets an error response.
- Logs go to stderr (never stdout — stdout is the MCP JSON-RPC channel).
- Session logs live at `~/.claude/deleg8/<session>/<agent_id>.log`.
