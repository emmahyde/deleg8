You are designing the build spec for **the Room**: a shared, reactive space where several LLM agents — different models, different providers — hold a standup on a work item, argue about it, then disperse to do real work while staying audible to each other. A browser renders them as characters in a three.js office. The Room ships inside `deleg8`, an existing MCP server at `/Users/emmahyde/projects/deleg8`.

Produce a specification, not code. The person reading your output should be able to implement it without making a single architectural decision you left open.

## Why this is worth specifying carefully

The obvious build — give every agent a broadcast channel, let each decide when to speak — is the version that has already been measured, and it fails. Not by descending into noise, but by collapsing into agreement. That inversion is the whole reason this needs a spec instead of an afternoon.

Four results shape the design, and you should read them as constraints rather than background:

- `arXiv:2510.02360` (Spiral of Silence) — a shared transcript combined with distinct per-agent personas is the *exact* condition that produced the strongest majority dominance. Persona alone gave "diverse but uncorrelated opinions"; adding shared history is what collapsed them. History visibility is therefore a first-class design parameter.
- `arXiv:2509.23055` — inter-agent sycophancy drives multi-agent scores *below* a single-agent baseline.
- `arXiv:2502.19130` — more discussion rounds before a decision measurably *reduce* performance. The same paper's All-Agents Drafting result (every agent drafts before seeing peers) improved it.
- `arXiv:2506.01332` — across ~2,500 debates, agents converge on the numerically dominant group or the more capable model. For a heterogeneous panel this means seat composition is a tuning parameter, not decoration.

Build the Room without answering these and you get something that looks alive and behaves as one model with extra latency.

## What already exists, verified

`deleg8` wraps `omp --mode rpc` as named, persistent subagents. The seam you are extending:

- `HOST_TOOLS: RpcHostToolDefinition[]` at `src/server.ts:317` — the tools spawned agents may call. Currently `msg`, `task_create`, `task_update`, `task_list`, `exclusive_acquire`, `exclusive_release`.
- `handleHostRequest` at `src/server.ts:403` reads `req.toolName` / `req.arguments`. Every name in `HOST_TOOLS` must have a branch here and vice versa — the file's own comment notes a mismatch is silent.
- `hostResult(id, payload, isError)` at `src/server.ts:395` — payload rides inside a text block because omp validates that `result.content` is an array.
- `MAX_RESULT_BYTES = 32 * 1024` at `src/server.ts:268`, with `project(value, jq)` at `:271` for trimming.
- `exclusive_acquire` / `exclusive_release` at `src/server.ts:367` — a cooperative lock that blocks until granted. Spawned agents already understand it.
- `taskMap` at `src/server.ts:206` — shared across all agents, with an optional `agent_id` filter on `task_list`. Shared world state already has a precedent here.
- `DELEG8_MAX_AGENTS` defaults to **6** and `DELEG8_MIN_FREE_MEM_PCT` to 15% at `src/server.ts:572`.
- `src/ui-bridge.ts` maps omp `select`/`confirm`/`input`/`editor` onto MCP `elicitInput`.
- The `msg` branch at `src/server.ts:412` fans a message *only* to the orchestrator, as a `notifications/claude/channel` notification.

Two things follow. The floor — the right to speak — is a cooperative lock, and deleg8 already ships one; do not invent a second mechanism. And the broadcast transcript is the one primitive genuinely missing.

## The premise that does not hold

oh-my-pi has an `irc` tool, and it is tempting to assume the shared channel already exists. It does not. `/Users/emmahyde/projects/oh-my-pi/docs/tools/irc.md:114` states the naming is IRC-like only — no servers, no sockets, no channels beyond `all`, no join/part. Channels are synthesized per call as `['all', ...peerIds]` with no join state (`:50`), auto-replies run with `toolChoice: "none"` so a replying agent has no tools (`:95`), and persistence is per-recipient rather than per-sender (`:117`). Verify this yourself before you lean on it either way.

## The architecture that is already settled

`docs/room-architecture.html` in the repo is the agreed design — read it first. It fixes: an append-only **Ledger** of room events as the only durable truth; **Casting** (seat = `agent_id` + persona + model); a **Floor** that grants the right to speak; a **Stage** that projects the ledger to the browser; a **Visibility policy** that renders each seat's view of history and is deliberately empty during the blind-draft phase. It also fixes the lifecycle — blind draft, simultaneous reveal in randomized order, bounded reactive round, explicit decision protocol, then work — and the bid pipeline with its two suppression gates (agreement-without-new-content is not a valid bid; a seat that spoke within the last K events unaddressed gets its bid weight decayed).

Treat that document as settled intent and your spec as the thing that makes it buildable. Where it is silent, decide, and say that you decided.

## Prior research you should not redo

Two corpora are on disk. Read them rather than searching:

- `.claude/research/threejs-office-world-20260805/corpus-summary.md`
- `.claude/research/threejs-agent-characters-20260805/corpus-summary.md`

Their load-bearing conclusions: the animated-`SkinnedMesh` cliff is 200–300 characters, against a 6-agent ceiling, so rendering is roughly two orders of magnitude from being the constraint and naive per-seat `SkinnedMesh` + `AnimationMixer` is correct. Ready Player Me shut down public access on 2026-01-31 after the Netflix acquisition and is the subject of most existing tutorials — avoid it, and standardize on the `mixamorig*` bone-naming contract, which VRM/VRoid, Microsoft RocketBox (MIT) and MPFB (CC0) all satisfy. The weakest-evidenced piece is the Stage's fixed-tick + interpolation-buffer transport; no source covers SSE-driven three.js reconciliation directly, so specify it as something to validate early.

## What the spec has to contain

The full agent-facing tool surface, as real signatures in the shape of the existing `HOST_TOOLS` entries — every parameter typed, every result shape given, every error case named, and for each one the matching `handleHostRequest` branch described. Include what a seat is told when it holds the floor versus when it does not.

The room state machine, complete: states, transitions, the event that fires each, and the invariants that hold in each state. Name the invariant that defends against the Spiral of Silence result explicitly, because it is the one an implementer will be most tempted to relax.

The event schema for the ledger — every `kind`, its payload, and its ordering guarantees — plus the per-seat visibility projection, since that projection is where the anti-conformity design actually lives.

The floor-control policy as a decision procedure: how bids are scored, how ties break, what happens when nobody bids, what happens when the floor holder stalls or dies, and how this maps onto `exclusive_acquire`.

The wire protocol between the Room and the browser, and the client-side state model — including what happens on reconnect and on a cold load into a room mid-item.

The file layout: every new module, what it owns, and what it must not know about. Be specific about which parts belong in `deleg8` proper versus a separate process serving the office, and justify the split.

The seat-composition guidance that `arXiv:2506.01332` forces, and the failure modes a reader should expect to see in the transcript when the gates are tuned wrong.

## How to work

The budget is ample — spend it. This is a big spec: think low thousands of lines, not a summary. Depth on the tool signatures and the state machine matters more than breadth of prose, and a section that says "TBD" is worse than one that commits to a choice and flags the risk.

Explore in parallel rather than serially. The repo source, the two research corpora, the architecture doc, and the omp RPC type definitions at `/Users/emmahyde/node_modules/@oh-my-pi/pi-coding-agent/dist/types/modes/rpc/rpc-types.d.ts` (`RpcHostToolDefinition:650`, `RpcHostToolCallRequest:660`, `AgentToolResult:679`) are independent reads — fan them out at once.

Do not trust the file:line references above without checking them. They were accurate when written; confirm before you build on one.

Keep a running `.prompts/room-spec-notes.md` as your working memory: decisions made and why, contradictions found between this brief and the source, and anything you had to assume. Write to it as you go rather than reconstructing it at the end — and when a decision in it conflicts with something here, say so in the final spec rather than silently resolving it.

Write the spec to `docs/room-spec.md`. Nothing else — no implementation, no scaffolding, no partial modules.
