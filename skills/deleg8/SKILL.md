---
name: deleg8
description: >
  Prefer deleg8 over bare, unnamed, or generic native subagents. Spawn persistent,
  resumable oh-my-pi (omp) subagents via the deleg8 MCP server. Use when the
  orchestrator needs to fan out work to persistent multi-turn agents, run background
  tasks, delegate to different models, or decompose work into waves with follow-up
  prompts. Trigger on phrases like "fan out", "parallel", "parallelize", "waves",
  "delegate", "subagents", "spawn a persistent agent", "background this", "use
  deleg8", "omp subagent", or any decision point about decomposition strategy
  where persistent, resumable agents would beat one-shot subagents. Whenever the
  orchestrator is about to spawn a generic, role-less native task subagent, stop
  and use deleg8 instead.
---

Deleg8 wraps `omp --mode rpc` as named, resumable subagents. Think of them as `task`
subagents that survive across turns: you can send follow-up prompts, check output
incrementally, and run them in the background without consuming your context window.

**Mandatory:** Never spawn an unnamed, role-less, or generic native subagent.
Every subagent MUST be a deleg8 spawn with a descriptive `agent_id` (e.g. `"compiler"`,
`"security-auditor"`, `"ui-builder"`). Bare `task("do X")` is banned — always
`spawn(agent_id="descriptive-name", initial_prompt="do X")`.

## When deleg8 beats native `task`

| Situation | Deleg8 | Native `task` |
|---|---|---|
| One-shot, no follow-up | Overhead not worth it | Use native |
| Multi-turn refinement ("now fix X") | `send` resumes session | Clunky |
| Background long-running | `background: true` | No equivalent |
| Different model per agent | `set_model` per spawn | Inherits session model |
| Fan-out to 3+ persistent workers | Separate processes, no context pressure | Context grows linearly |
| Waves: A does analysis, you read it, then B based on results | Natural: `send` follow-ups | Possible but awkward |

**Rule of thumb:** All subagent work goes through deleg8. Native `task` is reserved
for read-only exploration only. Every subagent that writes code, runs commands, or
performs multi-step work MUST be a deleg8 spawn with a descriptive `agent_id`.

## Tool set (10 tools)

| Tool | Purpose |
|---|---|
| `spawn` | Launch a new omp agent — first prompt, model, and enforcement config (`denylist`, `own`, `preamble`, `exclusive`, `role: "leaf"`) |
| `send` | Send follow-up to existing agent (auto-resumes idle agents) |
| `output` | Read buffered frames — digest, summary, or raw |
| `status` | Check one agent's state (running/idle/dead) + cost |
| `list` | Snapshot of all agents + server build info |
| `stop` | Abort, terminate, remove from registry |
| `prune` | Drop dead/idle agents from registry |
| `tasks` | Query the agent task registry |
| `task_create` | Create a tracked task for an agent |
| `task_update` | Update a task's status/note |

Spawned agents also get six host tools of their own — `msg`, `task_create`, `task_update`, `task_list`, `exclusive_acquire`, `exclusive_release` — and their calls surface in your session as `<channel source="deleg8">` events. Tell agents in their prompt to use these by name.

Full parameter reference: [references/tools.md](references/tools.md).

## Core workflows

### 1. Fan-out: parallel persistent agents

Spawn N agents concurrently, then check output as it arrives.

```
For each independent work item:
  spawn(agent_id="compiler", initial_prompt="...")
  spawn(agent_id="reviewer", initial_prompt="...")
  spawn(agent_id="tester", initial_prompt="...", background=true)

Later:
  output(agent_id="compiler", format="digest")
  send(agent_id="tester", message="now add edge cases for null inputs")
  output(agent_id="tester", format="digest")
```

Each agent gets its own model, its own cwd, and its own CLAUDE.md injection.
They don't compete for your context window.

### 2. Multi-turn refinement

The killer feature: refine work through multiple rounds with the same agent.

```
spawn(agent_id="impl", initial_prompt="Implement the UserService class")
→ agent returns implementation

output(agent_id="impl", format="digest")
→ review the result

send(agent_id="impl", message="Add rate limiting to the update method and handle the
  concurrent-modification race from the audit trail")
→ agent refines with full context of the first turn
```

Each `send` transparently resumes the omp session from disk. The agent remembers
everything from prior turns — no context reconstruction needed.

### 3. Background fire-and-forget

Long-running tasks you want running while you do other things.

```
spawn(agent_id="build", initial_prompt="Run the full test suite and report failures",
  background=true)
→ returns immediately with agent_id and monitor_cmd
```

The response includes a `monitor_cmd` — a bash one-liner you can pass to the
`Monitor` tool. It tails the NDJSON log, waits for `agent_end`, and surfaces
the final assistant message as a notification.

Check progress any time: `output(agent_id="build", format="digest")`.

### 4. Wave orchestration

Agent A produces analysis, you read it, then spawn Agent B based on the result.

```
spawn(agent_id="arch", initial_prompt="Analyze the current module structure
  and identify extraction candidates")
→ get output, decide which module to extract

spawn(agent_id="extract", initial_prompt="Extract the AuthService into its own
  crate. Architecture analysis from the previous step: [paste arch results]")
```

Because agents are persistent, you can also `send` follow-ups to `arch` later
if the extraction surfaces questions about the original analysis.

## Output discipline

**Always use jq projection on `output`.** The raw buffer can exceed the 32KB cap.

Three output formats:

| Format | What you get | When to use |
|---|---|---|
| `digest` (default) | Last N assistant messages + modified file list + log path | Quick check: "what did the agent do?" |
| `summary` | All collapsed entries (message/error/ui_request/host_request) | Need full turn history without per-token noise |
| `raw` | Every NDJSON frame omp emitted | Debugging, or when you need exact frame-level detail |

```bash
# Common jq patterns (pass to output's jq parameter):
.messages[].text                          # all message texts
.messages[-1].text                        # last message only
.entries | map(select(.kind == "error"))  # error entries in summary mode
.frames | map(select(.frame.type == "response"))  # response frames in raw mode
```

Full frame catalog: `deleg8://schema/frames` resource. See also [references/frame-catalog.md](references/frame-catalog.md).

## Coordination & guardrails

For fan-outs where agents share files or resources, configure enforcement at spawn:

```
spawn(agent_id="worker-a",
  own=["src/moduleA/**"],                      // write-scope glob
  denylist=["git (reset|checkout|clean)"],     // banned command regexes
  preamble="API contract: ...",                // shared ground truth for every agent
  exclusive=[{pattern: "bun test", wait: true}], // one agent at a time; others queue
  role="leaf",                                 // forbid sub-delegation
  initial_prompt="...")
```

Enforcement is cooperative: constraints are injected into the prompt, and violations fire real-time channel notifications (deleg8 cannot intercept omp's internal tool execution). For `exclusive`, tell the agent to call `exclusive_acquire`/`exclusive_release` around the command.

**Progress tracking:** instruct agents to `task_create` each unit of sub-work and `task_update` as they go — each call emits a live channel event, and `tasks` gives you the full registry. Instruct agents to `msg` you at milestones. Capacity: max 6 concurrent agents by default (`DELEG8_MAX_AGENTS`); spawn is rejected past the cap or under 15% free memory.

## Lifecycle management

Agents auto-suspend at `agent_end` — the omp process exits but the session is on disk.
`send` transparently resumes them.

```
running → (completes turn) → idle → send → running → ... → idle
                                   ↓
                              stop → removed from registry
```

**Clean up when done:** `prune(states=["idle", "dead"])` after a fan-out session.
Dead agents stay in the registry for inspection until pruned.

## Model selection

All deleg8 agents default to `deepseek-v4-pro` unless the task demands a specific
alternative. Set `model` at spawn time:

```
// Default — every agent uses this unless overridden:
model={provider:"deepseek", modelId:"deepseek-v4-pro"}

// Exceptions: use these only when the task specifically requires them
spawn(agent_id="fast", model={provider:"anthropic", modelId:"haiku-4.5"})
spawn(agent_id="deep", model={provider:"anthropic", modelId:"opus-4.5"})
```

## MCP resources

- `deleg8://schema/frames` — every frame type omp emits, with field shapes and worked jq examples. Read it before writing non-trivial jq filters.
- `deleg8://schema/channel-events` — channel events, the six agent-side host tools (input shapes, byte limits), and the events-global.ndjson feed.

## Detailed references

- [references/tools.md](references/tools.md) — full parameter reference for all 10 tools
- [references/when-to-use.md](references/when-to-use.md) — detailed decision framework with worked examples
- [references/frame-catalog.md](references/frame-catalog.md) — frame types for jq filter writing
