# pi-agent-mcp

An MCP server that exposes [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp --mode rpc`) as a fleet of **named, long-lived subagents** addressable from Claude Code — mirroring the surface of the native `Agent` + `SendMessage` tools.

Each agent is one `omp --mode rpc --no-session` subprocess. `pi_send` writes another `prompt` frame to the same subprocess's stdin, so conversation context persists across calls. Multiple agents run concurrently under different IDs.

## Why

Claude Code's native `Agent` / `SendMessage` lets you spawn sub-Claude sessions and resume them by ID. This server gives you the same primitive for `omp`: spawn it once, keep pushing prompts at it, read its output, kill it when done.

## Install

```bash
cd pi-agent-mcp
bun install
```

Then wire it into Claude Code. **User-level** (`~/.claude.json`, applies everywhere):

```jsonc
{
  "mcpServers": {
    "pi-agent": {
      "command": "bun",
      "args": ["run", "/Users/you/projects/deleg8/pi-agent-mcp/src/server.ts"]
    }
  }
}
```

Or **project-level** (`.mcp.json` in the project root, committed for the team):

```jsonc
{
  "mcpServers": {
    "pi-agent": {
      "command": "bun",
      "args": ["run", "./pi-agent-mcp/src/server.ts"],
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
| `pi_send`   | `SendMessage`       | Send another prompt to an existing agent_id (resumes context)    |
| `pi_list`   | `TaskList`          | List every registered agent and its status                       |
| `pi_status` | `TaskGet`           | Detailed status for one agent                                    |
| `pi_output` | `TaskOutput`        | Read buffered NDJSON frames (response/event/tool-call frames)    |
| `pi_stop`   | `TaskStop`          | Send `abort`, terminate (or SIGKILL with `force: true`)          |

All tools that "act" (`pi_spawn`, `pi_send`) support `background: true` to return immediately; poll `pi_output` with `since_seq` to stream results.

### Clarifying questions (MCP elicitation)

Agents spawn in `--mode rpc-ui` by default, which lets omp emit `extension_ui_request` frames mid-turn — the same channel its `ask` tool and structured pickers use. The wrapper bridges these to **MCP elicitation** (`elicitInput`), so Claude Code surfaces the question to you and forwards your answer back into the same long-lived omp process. Methods translated: `select` (enum), `confirm` (boolean), `input` (string), `editor` (multi-line string). Passive UI frames (`notify`, `setStatus`, `setWidget`, etc.) are buffered silently. Pass `rpc_mode: "rpc"` on spawn to disable.

### Frame model

The RPC mode of `omp` speaks NDJSON over stdio. From their README:

```
> {"id":"r1","type":"prompt","message":"list .ts files"}
< {"id":"r1","type":"response", ...}
> {"id":"r2","type":"set_model","provider":"anthropic","modelId":"sonnet-4.5"}
> {"id":"r3","type":"abort"}
```

This server generates frame IDs and correlates `response` frames back to their originating request. Every frame received is also buffered (cap: 1024) for `pi_output`.

## Smoke test with MCP Inspector

```bash
bun run inspector
```

Opens the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) at `http://localhost:5173`. Try:

1. `pi_spawn` with `initial_prompt: "echo hello"` → returns `agent_id` and response.
2. `pi_send` with that `agent_id` and `message: "what did I just ask?"` → context is preserved.
3. `pi_list` → see the agent listed.
4. `pi_stop` with `remove: true` → clean up.

## Development

```bash
bun run typecheck   # tsc --noEmit
bun run dev         # bun --watch
bun run build       # bundle to dist/
```

## Caveats

- Output buffer is bounded at 1024 frames per agent — older frames drop off. Use `pi_output` with `since_seq` to stream incrementally if you care about every frame.
- `pi_send` with `wait: true` (default) blocks until a `response` frame with the matching `id` arrives. If `omp` emits intermediate event frames they accumulate in the buffer but don't unblock the wait.
- Elicitation requires the MCP client to support the 2025-06-18 `elicitation/create` request. Claude Code does; some other clients don't yet — agents spawned in those clients will see UI requests auto-cancel.
- This wrapper registers no host tools or URI schemes. If omp tries `host_tool_call` / `host_uri_request` it gets an error response so it doesn't hang.
- The server logs to stderr (never stdout — stdout is the MCP JSON-RPC channel).
