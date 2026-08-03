# deleg8 — Persistent omp Subagents Plugin

Makes oh-my-pi persistent subagents the default delegation mechanism in Claude Code.
Bundles the deleg8 MCP server, an enforcement hook, and a skill that teaches the
orchestrator when and how to use persistent subagents instead of bare `task()` calls.

## Components

| Component | Purpose |
|---|---|
| **MCP server** | `deleg8` — wraps `omp --mode rpc` as named, persistent subagents (7 tools: `spawn`, `send`, `output`, `status`, `list`, `stop`, `prune`) |
| **Hook** | `PreToolUse` on `task` — blocks bare/unnamed `task()` spawns; forces descriptive `agent_id` via deleg8 |
| **Skill** | `deleg8` — teaches the orchestrator when deleg8 beats native subagents, with workflow patterns and jq output discipline |

## Install

```bash
cc --plugin-dir ~/projects/deleg8
```

Or install from the project:

```bash
cd ~/projects/deleg8
cc --plugin-dir .
```

## Prerequisites

- **Bun** ≥ 1.1.0 (`brew install bun` or `curl -fsSL https://bun.sh/install | bash`)
- **omp** on PATH (or set `OMP_BIN` in settings)
- Dependencies installed: `cd pi-agent-mcp && bun install`

## Configuration

Create `.claude/deleg8.local.md` in your project (or `~/.claude/` for global):

```yaml
---
omp_bin: /opt/homebrew/bin/omp
default_model:
  provider: deepseek
  modelId: deepseek-v4-pro
---
```

| Field | Default | Description |
|---|---|---|
| `omp_bin` | `omp` (PATH lookup) | Path to omp binary |
| `default_model.provider` | `deepseek` | Model provider for deleg8 agents |
| `default_model.modelId` | `deepseek-v4-pro` | Model ID for deleg8 agents |

## Usage

Once installed, the skill loads on phrases like "fan out", "parallelize", "waves",
"delegate", "subagents", or when the orchestrator considers spawning a bare `task()`.

**Basic fan-out:**
```
spawn(agent_id="compiler", initial_prompt="Build the auth module")
spawn(agent_id="tester", initial_prompt="Write tests for auth", background=true)
```

**Multi-turn refinement:**
```
spawn(agent_id="impl", initial_prompt="Implement payment processor")
→ review output
send(agent_id="impl", message="Add retry logic for timeout failures")
```

Full workflow patterns: see the deleg8 skill output or `references/when-to-use.md`
in the skill directory.

## MCP Tools

| Tool | Purpose |
|---|---|
| `spawn` | Launch a new omp agent with optional initial prompt |
| `send` | Send follow-up to existing agent (auto-resumes idle agents) |
| `output` | Read buffered frames — digest/summary/raw with jq projection |
| `status` | Check one agent's state (running/idle/dead) |
| `list` | Snapshot of all registered agents |
| `stop` | Abort, terminate, remove from registry |
| `prune` | Drop dead/idle agents from registry |

### Spawn Parameters (New in v0.2)

The `spawn` tool now supports these enforcement parameters:

| Parameter | Type | Description |
|---|---|---|
| `denylist` | `string[]` | Regex patterns over tool commands. Prompt-level constraints + real-time violation monitoring. Note: omp runs Bash/Read/Edit internally — deleg8 cannot intercept before execution. |
| `own` | `string[]` | Glob patterns limiting write scope. Same injection + monitoring pattern. Same architectural constraint as denylist. |
| `preamble` | `string` | Shared context block every spawned agent receives before its prompt. |
| `fallback_model` | `{provider, modelId}` | If the primary model fails to apply (e.g. budget exceeded), try this one. |
| `idle_ttl` | `number` (ms) | Auto-reap idle agents after N ms of inactivity (registry-level, 0 = off). |
| `dead_ttl` | `number` (ms) | Auto-reap dead agents after N ms (registry-level, 0 = off). |
| `exclusive` | `{pattern, wait}[]` | Cooperative agent protocol — agents acquire/release locks via host tools. Voluntary: agents must call `exclusive_acquire`/`exclusive_release`. |

**Usage example:**
```
spawn(
  agent_id="builder",
  initial_prompt="Compile the .csproj",
  denylist=["git (stash|checkout)", "dotnet test"],
  own=["src/**", "*.csproj"],
  preamble="Friflo: Tags getter returns a struct copy — use AddTag/RemoveTag",
  idle_ttl=300_000,
  exclusive=[{pattern: "dotnet build", wait: true}]
)
```

**Host tools available to agents:**
- `exclusive_acquire(pattern)` — acquire an exclusive command lock
- `exclusive_release(pattern)` — release an exclusive command lock
- `msg(text)` — send IRC message back to orchestrator
- `task_create(label, note?)` — create sub-task visible to orchestrator
- `task_update(task_id, status?, note?)` — update sub-task status
## Enforcement Hook

The `PreToolUse` hook on `task` evaluates every subagent spawn:

- **Allows:** `explore` subagents (read-only scouting), tasks with descriptive `role` fields
- **Blocks:** Bare `task("do X")` calls, unnamed/generic subagents
- **Blocked message:** "Bare task() is banned. Use deleg8: spawn(agent_id='descriptive-name', initial_prompt='...')"
