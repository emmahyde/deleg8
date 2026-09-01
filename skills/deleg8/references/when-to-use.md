# When to Use deleg8 — Decision Framework

## The fundamental rule

**All subagent work goes through deleg8. Native `task` is reserved for read-only
exploration only.** Every subagent that writes code, runs commands, or performs
multi-step work MUST be a deleg8 spawn with a descriptive `agent_id`.

## Decision matrix

| Criterion | deleg8 | native `task` |
|---|---|---|
| **Writes code** | Yes | No |
| **Runs commands** | Yes | No |
| **Turn count** | Any: 1+ turns | Read-only exploration |
| **Context pressure** | Separate process | Shares orchestrator context |
| **Model** | deepseek-v4-pro (default) | Inherits session model |
| **Background** | Fire-and-forget + Monitor | No |
| **Output access** | Incremental with jq projection | One-shot response |
| **Session persistence** | Survives across turns (disk) | Gone after response |

## Concrete examples

### deleg8 (the default for all subagent work)

**Multi-turn refinement.**
> "Implement the payment processor, then I'll review and ask for changes."
```
spawn(agent_id="payment", initial_prompt="Implement PaymentProcessor with Stripe integration")
→ review output
send(agent_id="payment", message="Add idempotency key handling and webhook verification")
```

**Background compilation.**
> "Run the full test suite while I work on the next feature."
```
spawn(agent_id="tests", initial_prompt="Run cargo test --all-features and report failures",
  background=true)
→ keep working; check output later
```

**Model-specific work.**
> "Audit this for security with Opus."
```
spawn(agent_id="audit", model={provider:"anthropic", modelId:"opus-4.5"},
  initial_prompt="Security audit of auth module")
```

**Context isolation for large tasks.**
> "Analyze all 200 source files and produce a dependency graph."
```
spawn(agent_id="analyze", initial_prompt="Analyze the full codebase...")
→ agent's thinking doesn't consume your context window
```

**Waves with inter-agent handoff.**
```
spawn(agent_id="scout", initial_prompt="Map the module structure and find extraction targets")
→ read output, pick targets
spawn(agent_id="extract-auth", initial_prompt="Extract auth module. Scout found: [results]")
spawn(agent_id="extract-db", initial_prompt="Extract DB module. Scout found: [results]")
```

### native `task` (read-only exploration ONLY)

The ONLY valid use of native `task` is read-only investigation where no code is
written and no commands are run:

* **`explore` subagent:** codebase scouting, mapping structure, finding files
* **Simple lookup:** "What does `validateSession` return?"
* **Documentation research:** look up APIs, read external docs

Every other task — editing files, running tests, building, refactoring, generating
code — uses deleg8.

## Hybrid patterns

### Scatter with deleg8, gather with `output`

Fan out all work to deleg8 agents, collect results with targeted `output`:

```
spawn(agent_id="module-a", initial_prompt="Refactor module A...")
spawn(agent_id="module-b", initial_prompt="Refactor module B...")
spawn(agent_id="module-c", initial_prompt="Refactor module C...")

output(agent_id="module-a", format="digest", jq=".messages[-1].text")
output(agent_id="module-b", format="digest", jq=".messages[-1].text")
output(agent_id="module-c", format="digest", jq=".messages[-1].text")
```

### Exploration → action (all deleg8)

Plan with one agent, implement with others — all deleg8:

```
spawn(agent_id="plan", initial_prompt="Design the migration plan for v2 schema")
→ read the plan
spawn(agent_id="migrate-users", initial_prompt="Migrate users table per plan: [details]")
spawn(agent_id="migrate-orders", initial_prompt="Migrate orders table per plan: [details]")
```

### Coordinated fan-out (overlapping resources)

Agents share a repo or a serialized resource (test runner, port, migration):

```
spawn(agent_id="mod-a", own=["src/a/**"], exclusive=[{pattern:"bun test", wait:true}],
  preamble="Shared contract: [API notes]", initial_prompt="... Call exclusive_acquire
  before running tests and exclusive_release after. task_create each sub-step.")
spawn(agent_id="mod-b", own=["src/b/**"], ...same exclusive/preamble...)

tasks()   → live progress across both agents
```

## Anti-patterns (all BANNED)

* Spawning a bare `task("do X")` — always use deleg8 with agent_id
* Using native `task` for anything that writes code or runs commands
* Spawning a generic, role-less native subagent
* Never calling `prune` — registry accumulates dead agents
* Using raw format without jq — context bloat; always project
* Forgetting `background: true` for long-running work — blocks your turn
* Spawning with the wrong cwd — pass `cwd` explicitly
* Overlapping-write fan-out without `own` globs — agents clobber each other's files
* Sharing a serialized resource (test runner, port) without `exclusive` — races
* Long fan-outs with no `task_create` instruction — you fly blind until `agent_end`
