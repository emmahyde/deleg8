# Room spec — working notes

Running memory for the docs/room-spec.md build spec. Decisions, contradictions, assumptions — appended as they happen, per the brief.

## Decisions

- ORCH-SHAPE (2026-08-05): parallel research wave (seam verification, arch-doc digest, corpus digest) → single-author draft in the orchestrating session → parallel adversarial critique wave → revision. Spec authorship deliberately NOT parallelized: cross-section consistency (tool signatures ↔ state machine ↔ ledger schema) is the failure-prone part, so one author owns it.
- DELEG8-MCP-ABSENT (2026-08-05): the deleg8 MCP server is not connected in the authoring session; research/critique agents run as native subagents. No effect on spec content — the spec targets deleg8 source, not the live server.

## Contradictions found (brief vs source)

- LOCK-NOT-BLOCKING: the brief (and the tool's own description string) say `exclusive_acquire` "blocks until granted". The code does not block: `registry.acquireExclusive` (registry.ts:226-241) is synchronous — returns `true` if unheld/reentrant, else queues the caller (only when the pattern config has `wait: true`) and returns `false` immediately. Release grants to the next queued agent (registry.ts:247-262); the new holder learns of it only via the `notifications/claude/channel` broadcast (server.ts:503-512). Floor control must be specified as an advisory queue with caller-side polling, or extended host-side — a real design decision, not a description fix.
- REF-DRIFT (minor): `RpcHostToolDefinition` is at rpc-types.d.ts:666 (not :650), `RpcHostToolCallRequest` at :676 (not :660). `AgentToolResult` is not defined in rpc-types.d.ts at all — it is imported from `@oh-my-pi/pi-agent-core` (dist/types/types.d.ts:596). Its `content: (TextContent | ImageContent)[]` typing still justifies the text-block wrapping claim.
- REF-DRIFT (minor): `DELEG8_MAX_AGENTS`/`DELEG8_MIN_FREE_MEM_PCT` defaults (6 / 15) are constants in registry.ts:14-15; server.ts:572 is prose in the spawn tool description restating them.

## Verified facts the spec builds on (seam report, 2026-08-05)

- HOST_TOOLS at server.ts:317; handleHostRequest at :403 reads `toolName`/`arguments` (legacy `tool`/`args` fallback at :408-409); mismatch warning is the doc comment at server.ts:311-315.
- hostResult at server.ts:395 wraps payload as `{ content: [{ type: "text", text: JSON.stringify(payload) }], details: {} }`.
- MAX_RESULT_BYTES = 32*1024 at server.ts:268; project(value, jq) at :271.
- taskMap at server.ts:206, shared per server instance; TaskEntry shape at server.ts:115-123 (`status: "pending" | "in_progress" | "done" | "failed"`).
- NOTED (not done, pre-existing): host-tool `task_update` schema (server.ts:351) offers enum value `"completed"` but TaskEntry uses `"done"`.
- msg branch at server.ts:412-421: orchestrator-only fan via `notify("notifications/claude/channel", ...)`; MAX_MSG_BYTES cap.
- sendNotification at server.ts:180-204 is the single choke point for every notification path (appends to global NDJSON log first) — the natural interception point for a Room broadcast, rather than per-call-site changes.
- ui-bridge: single export `makeElicitBridge(server)` (ui-bridge.ts:137); wired via server.ts:104 → registry.ts:118 → agent.ts:326 → invoked at agent.ts:797-803 on `extension_ui_request`.
- wireAgent at server.ts:713 (spawn) and the adoptPersisted loop at server.ts:1297-1298 are where per-agent hooks attach; onChannelFrame (server.ts:532-546) fires on agent_end.
- irc.md claims all confirmed verbatim (:114, :50/:116, :59/:96, :117) — no reusable channel primitive exists in omp.

## Draft decisions (register mirrored + justified in docs/room-spec.md §Decisions)

- FLOOR-ENGINE-MEDIATED: seats never call `exclusive_acquire` for the floor. The Room engine selects the bid winner and acquires `room:<id>:floor` on the winner's behalf via the in-process registry API (synchronous call while the lock is free — the non-blocking semantics never bite). Reconciles priority-ordered bids with the FIFO/advisory lock without inventing a second mechanism.
- TURN-DRIVEN-SEATS: seats don't poll; the engine turn-drives them (registry send) at bid windows with their projection delta. Each turned seat MUST answer with `room_bid` or `room_pass` — silence becomes an explicit `pass` event, matching "silence is an event."
- SEALED-EVENTS: blind drafts and ballots are appended to the ledger at submission time with sealed bodies; the projection redacts them until the reveal/decision event. Preserves single-durable-truth without leaking during blind phases.
- INV-BLIND is the named anti-Spiral-of-Silence invariant; INV-NO-TALLY (projection never aggregates agreement counts) and INV-MASK (model/provider identity never visible to peer seats — targets 2506.01332 capability-deference) are companions.
- GATE1-STRUCTURAL-V1: agreement-without-new-content is enforced structurally (required stance fields; empty adds+disagrees rejected), not by a semantic judge. Risk (padding) flagged in spec; judge pass deferred deliberately.
- K = S say-events (one lap); decay ×0.35; PASS does not count as "spoke" for K.
- R = ceil(1.5×S) say-events per item, reset per item; two consecutive zero-bid lulls end the round early.
- STAGE-SEPARATE-PROCESS: stage/ is its own process reading the rooms SQLite (WAL, read-only) at a 200ms fixed tick, serving SSE + snapshot on 127.0.0.1. deleg8 restart doesn't kill the view; browser stays disposable.
- STAGE-FRAMES-NOT-PERSISTED: arch doc lists a `stage_frames` table, but also declares everything replay-derivable; persisting derived frames contradicts single-truth. Frames live in an in-memory ring buffer. Deliberate deviation from settled intent, surfaced in spec.
- TASK-STATUS-ENUM: spec reuses "done" (TaskEntry reality), not "completed" (schema bug noted).

## Critique wave — findings register (2026-08-05)

Two parallel critics: critic-decisions (design completeness vs brief + arch digest) and critic-grounding (every substrate claim vs deleg8/omp source). Every finding accepted; none rejected. Resolutions, by finding:

- ACCEPTED B-WORK-REENTRY (grounding, blocker): work→reactive was unreachable — no bid window ever opened during `working`, so `room_bid` always failed. Added §7.8 work-phase windows: a `tool_activity` append opens `bid_window {work:true}` (W_work=120s, delta-queue-announced, no turn-driving); winning bid fires reactive re-entry.
- ACCEPTED B-BID-STANCE-LOST (grounding, blocker): bid stances were never persisted and floor_bids sat outside replay. Added `floor_bids.stance` column; reclassified floor_bids/floor_grants as loss-tolerated telemetry (same class as stage_frames) and embedded the winning bid snapshot in the `floor_grant` ledger event so floor history replays from the ledger alone.
- ACCEPTED B-PHASE-ENUM (both, blocker/major): `room_items.phase` enum contradicted §4.1's state list. Resolved: item phases are the six incl. `closed` (now a SQL CHECK); `idle` is room-level only; `item_closed` writes `closed`.
- ACCEPTED B-VOTE-OPTIONS-UNRECORDED (grounding, blocker): ballot menus lived only in engine memory. Options now ride the `phase{to:deciding}` event body; `room_ballot` validates against the ledger-recorded menu; `DecisionDetail` defined in §5.2.
- ACCEPTED M-SEAT-NAME-LEAK (decisions): `room_cast` now rejects (`identity_leak`) seat ids/roles containing provider/model-family substrings — the arch doc's own example names would defeat INV-MASK.
- ACCEPTED M-OPTION-CLUSTER-LEAK (decisions): vote menus normalized — one option per distinct position regardless of cluster size, no counts, no attribution, seeded-random order; INV-NO-TALLY explicitly holds through balloting.
- ACCEPTED M-UNBOUNDED-REOPEN (decisions): added REENTRY_LIMIT=3 and REOPEN_LIMIT=1 lifetime caps (2502.19130's rounds-hurt applies item-lifetime).
- ACCEPTED M-NO-DRAFT-UNDEFINED (decisions): "mandatory drafts" relabeled required-with-deadline; §7.9 defines the non-drafter bar (excluded from reveal.order, floor-barred, still ballots) and S_effective quorum; <2 drafts → escalated.
- ACCEPTED M-TOOL-ACTIVITY-SOURCE (grounding): onChannelFrame is agent_end-only, unusable per tool call. §11.2/§13 now name a new substrate hook `onToolActivity` off `tool_execution_start` (agent.ts:677), mirroring onViolation wiring.
- ACCEPTED M-SEAT-LEFT-REASON (grounding): "stopped"|"dead" not derivable (AgentState has no stopped; flag private). Collapsed to "dead" | "removed".
- ACCEPTED M-THIRD-SEAM (grounding): §13 now lists the room:* rejection in the exclusive_acquire branch as a third server.ts seam, plus the agent.ts hook.
- ACCEPTED M-REQUEUED-DEAD (grounding): dropped `requeued` from floor_bids.outcome (bids never requeue per §7.5).
- ACCEPTED minors (both): K counts item-lifetime say history (no re-entry reset, §7.4); no mid-room recasting in v1, S-derived constants recompute live, warnings re-emit on seat_left (§10.2); zone/pose closed unions (§12.2); item_type defined at room_post_item (§10.2); seat-death citation pinned to agent.ts:39/:243 (§7.6); floor_grants.outcome vocabulary aligned to floor_revoked.cause; Phase/BallotOption/RenderedEvent/DecisionDetail defined (§5.2); recovery order adoptPersisted-then-replay with agent_id join rule (§10.4); K-counting-filters-say note at schema level (§3.1).
- Grounding critic also CONFIRMED the three riskiest claims: handleHostRequest's `agentId` parameter is real and usable in branches; engine-mediated in-process `acquireExclusive` works as specified; the registry send path has no orchestrator gate and is reusable for turn-driving.

## Assumptions

- "orchestrate a polished version of this concept" = produce the spec per the brief, via multi-agent orchestration; the brief fixes deliverable and acceptance (docs/room-spec.md, spec only).
