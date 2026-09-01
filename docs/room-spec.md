# The Room — build specification

Status: implementable. Every architectural decision is closed; open risks are named as validation items, not TBDs. Sources: `docs/room-architecture.html` (settled intent), `.prompts/claude-fable-5--agent-room.md` (brief), seam verification against `src/server.ts` / `src/registry.ts` / `src/agent.ts` / `src/ui-bridge.ts` (2026-08-05), omp RPC types, and the two research corpora under `.claude/research/`. Working memory: `.prompts/room-spec-notes.md`.

Reading order for an implementer: §1 (what the code actually provides), §3 (vocabulary), §4 (state machine), §5 (ledger), §6 (visibility), §7 (floor), §8 (tool surface). §9–§15 can be read per-module.

---

## 1. Verified substrate

Facts the spec builds on, re-verified against source on 2026-08-05. Where the brief's reference drifted, the corrected location is given.

- `HOST_TOOLS: RpcHostToolDefinition[]` — `src/server.ts:317`. The doc comment at `src/server.ts:311-315` is the contract: every name in `HOST_TOOLS` must have a branch in `handleHostRequest` and vice versa; a mismatch is silent.
- `handleHostRequest` — `src/server.ts:403`; reads `req.toolName` / `req.arguments` with legacy `req.tool` / `req.args` fallback at `:408-409`.
- `hostResult(id, payload, isError)` — `src/server.ts:395`; wraps payload as `{ content: [{ type: "text", text: JSON.stringify(payload) }], details: {} }` because `AgentToolResult.content` is typed `(TextContent | ImageContent)[]` (`@oh-my-pi/pi-agent-core` `dist/types/types.d.ts:596` — not rpc-types.d.ts as the brief said).
- `RpcHostToolDefinition` — rpc-types.d.ts:666 (brief said :650): `{ name, label?, description, parameters: Record<string, unknown>, hidden?, loadMode? }`. `RpcHostToolCallRequest` — rpc-types.d.ts:676.
- `MAX_RESULT_BYTES = 32 * 1024` — `src/server.ts:268`; `project(value, jq)` — `:271`.
- **The exclusive lock does not block.** `registry.acquireExclusive` (`src/registry.ts:226-241`) is synchronous: returns `true` if unheld or reentrant; otherwise queues the caller (only when the pattern's config has `wait: true`) and returns `false` immediately. `releaseExclusive` (`:247-262`) grants to the next queued agent, who learns of it only via the channel notification (`src/server.ts:503-512`). The tool description's "blocks until granted" is aspirational. Backing state: `exclusiveLocks: Map<pattern, holder>`, `exclusiveQueue: Map<pattern, agentId[]>` (`src/registry.ts:107,109`). §7 is designed around this reality.
- `taskMap` — `src/server.ts:206`, shared per server instance; `TaskEntry.status` uses `"done"` (`src/server.ts:115-123`) while the host-tool schema at `:351` offers `"completed"` — pre-existing mismatch, not repeated here.
- `msg` branch — `src/server.ts:412-421`: orchestrator-only fan-out via `notify("notifications/claude/channel", ...)`. No peer-to-peer path exists.
- `sendNotification` — `src/server.ts:180-204` — is the single choke point every notification funnels through (global NDJSON log append, then MCP notification). The Room's ledger-mirror hooks here (§5.6), not at individual call sites.
- Agent caps: `DEFAULT_MAX_AGENTS = 6`, `DEFAULT_MIN_FREE_MEM_PCT = 15` — `src/registry.ts:14-15` (env-overridable; `src/server.ts:572` is prose restating them).
- Seat wiring points: `wireAgent` at `src/server.ts:713` (spawn) and the `adoptPersisted` loop at `:1297-1298` (recovery); `onChannelFrame` (`:532-546`) fires on `agent_end`.
- UI bridge: `makeElicitBridge(server)` (`src/ui-bridge.ts:137`) → `AgentRegistry.onUIRequest` → invoked at `src/agent.ts:797-803`.
- omp's `irc` tool is a false lead, confirmed against `oh-my-pi/docs/tools/irc.md`: IRC-like naming only (`:114`), no join state (`:50`, `:116`), auto-replies run with `toolChoice: "none"` (`:59`, `:96`), per-recipient persistence (`:117`). Nothing to reuse.

## 2. Research constraints (fixed, not background)

- `arXiv:2510.02360` (Spiral of Silence): shared transcript + distinct personas is the *strongest* majority-dominance condition. Consequence: history visibility is a first-class parameter → §6, invariant `INV-BLIND`.
- `arXiv:2509.23055`: inter-agent sycophancy drives multi-agent scores below single-agent baseline. Consequence: Gate 1 (§7.4) rejects agreement-without-new-content as a bid.
- `arXiv:2502.19130`: more discussion rounds reduce performance; All-Agents Drafting (draft before seeing peers) improves it. Consequence: the blind-draft phase is mandatory and the reactive round is budget-bounded (§4, `R`).
- `arXiv:2506.01332`: across ~2,500 debates, agents converge on the numerically dominant group or the more capable model. Consequence: seat composition rules (§14) and model-identity masking (`INV-MASK`, §6.4).
- `arXiv:2509.05396` (Talk Isn't Always Cheap): debate loses accuracy over time — even when stronger models outnumber weaker ones — because models "shift from correct to incorrect answers in response to peer reasoning, favoring agreement over challenging flawed reasoning." The measured precondition for harm is that agents are "neither incentivised nor adequately equipped to resist persuasive but incorrect reasoning." Consequence: this is the affirmative case for the whole gate/invariant apparatus — `INV-BLIND`, Gate 1, and `INV-MASK` are the incentive and the equipment. It also kills "just seat better models" as a mitigation (§14.2).
- `arXiv:2608.02758` (Pluralistic Ignorance): agents publicly conform at 64–94 % while privately opposing; conformity is "highly model-dependent, though uncorrelated with capability," and survives ablation of the framing prompts (52–92 % in the minimal condition). Two consequences: the public/private gap is the direct evidence for `INV-SEALED-BALLOTS` (§4.2), and conformity propensity — not capability tier — is the axis seat composition must be selected on (§14.2, §15.6).
- `arXiv:2606.29270` (Minority Sentinel): majority voting inherits the Condorcet Jury Theorem's independent-errors assumption, which shared pretraining corpora violate; in ~1 of 4 divergent cases the minority holds the correct answer. Consequence: consensus is the default decision protocol and vote is the narrow opt-in (§9.3, §10.2). Its secondary result — an LLM-as-Judge baseline scoring *negative* net gain — independently supports Gate 1 staying structural rather than judged (§7.4).

## 3. Vocabulary and domain model

Terms are the architecture doc's; the spec reuses them exactly.

- **Room** — one standup space: a cast of seats, one active item at a time, one ledger scope. One active room per deleg8 server (§3.2).
- **Seat** — `agent_id` + persona + model `{provider, modelId}`. A seat is a named, persistent deleg8 agent wearing a persona.
- **Persona** — `{role, expertise, character_asset}` — behavioral instructions plus a Stage avatar.
- **Item** — a work item under discussion; owns a lifecycle phase.
- **Ledger** — append-only event log, the only durable truth. Seat state, floor state, and the office scene are all derivable by replay.
- **Floor** — the right to speak. Exactly one holder or none.
- **Bid** — a seat's priced request for the floor: trigger + intensity + one-line reason + stance.
- **Stage** — the projection of the ledger to the browser (separate process, §12).
- **Visibility policy** — the per-seat projection of the ledger (§6). This is where the anti-conformity design lives.
- **Engine** — the in-deleg8 module that owns phase transitions, bid windows, floor grants, and seat turn-driving (§10).

### 3.1 Data model

SQLite via `bun:sqlite`, WAL mode, single file `${DELEG8_STATE_DIR:-~/.claude/deleg8}/rooms.db`. deleg8 is the only writer; the Stage opens it read-only (§12.1). Tables follow the architecture doc's data model:

```sql
CREATE TABLE room_events (          -- the Ledger; append-only, no UPDATE or DELETE ever
  seq        INTEGER PRIMARY KEY,   -- monotonic, assigned single-writer; total order
  room_id    TEXT NOT NULL,
  item_id    TEXT,                  -- NULL for room-scoped events (seat_joined, room_closed)
  actor_seat TEXT,                  -- NULL for engine-authored events (phase, reveal, lull)
  kind       TEXT NOT NULL,         -- closed enum, §5.1
  body       TEXT NOT NULL,         -- JSON, schema per kind, §5.2
  sealed     INTEGER NOT NULL DEFAULT 0,  -- 1 = body redacted by projection until unsealing event, §5.3
  reply_to_seq INTEGER,             -- nullable, single parent
  ts         INTEGER NOT NULL
);
CREATE TABLE room_items ( id TEXT PRIMARY KEY, room_id TEXT NOT NULL, title TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('reasoning','knowledge')),
  phase TEXT NOT NULL CHECK (phase IN ('drafting','revealing','reactive','deciding','closed')),
                                    -- 'idle' is room-level (no active item), never an item phase; item_closed writes 'closed'
  posted_seq INTEGER NOT NULL, closed_seq INTEGER );
CREATE TABLE room_seats ( agent_id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
  provider TEXT NOT NULL, model_id TEXT NOT NULL, desk_index INTEGER NOT NULL );
CREATE TABLE seat_personas ( agent_id TEXT PRIMARY KEY, role TEXT NOT NULL,
  expertise TEXT NOT NULL,          -- comma-separated free-text domain tags; matched lowercased for `domain` triggers
  character_asset TEXT NOT NULL );  -- path under stage/web/assets/, §12.5
CREATE TABLE floor_bids ( id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, item_id TEXT NOT NULL,
  window_seq INTEGER NOT NULL,      -- the bid_window event this bid answered
  trigger_seq INTEGER NOT NULL, trigger_kind TEXT NOT NULL,
  intensity REAL NOT NULL, effective_weight REAL NOT NULL, reason TEXT NOT NULL,
  stance TEXT NOT NULL,             -- JSON Stance (§5.2); §8.3's say-time recheck reads it back
  outcome TEXT NOT NULL DEFAULT 'pending' );  -- pending|granted|lost|rejected_gate1|expired
CREATE TABLE floor_grants ( id TEXT PRIMARY KEY, bid_id TEXT NOT NULL,
  granted_ts INTEGER NOT NULL, deadline_ts INTEGER NOT NULL, released_ts INTEGER,
  outcome TEXT );                   -- said|timeout|seat_dead (same vocabulary as floor_revoked.cause)
```

`stage_frames` from the architecture doc's data model is deliberately **not** a table: the doc's own first principle is that everything is derivable from `room_events` by replay, and persisting derived view frames would create a second truth. Frames live in a Stage-process ring buffer (§12.3). This is a recorded deviation from settled intent (§16). `floor_bids` and `floor_grants` sit in the same class deliberately: they are operational/tuning telemetry, not truth — authoritative floor history is the `floor_grant`/`floor_revoked`/`say` ledger events, and the `floor_grant` event body embeds the winning bid (§5.2), so a crash forfeits nothing but losing-bid telemetry (§10.4). K-window queries (§7.4) count only `kind='say'` ledger rows — never `floor_bids` rows and never `pass` events.

### 3.2 Concurrency limits

One active room per deleg8 server instance. The cast consumes the process budget (`DEFAULT_MAX_AGENTS = 6`, `src/registry.ts:14`); a second concurrent room would silently halve every cast or breach the cap. `room_create` while a room is `open` returns `room_exists`. Multi-room is a non-goal of v1; the `room_id` column keeps history from multiple sequential rooms.

## 4. Room state machine

Phases are per-item; the room itself is `open` or `closed`. `room_items.phase` holds the current item's phase; the `phase` ledger event is the transition record.

### 4.1 States and transitions

| # | State | Entered by (event) | Exit condition → next |
|---|-------|--------------------|------------------------|
| 1 | `idle` | `room_opened`, or `item_closed` | `item_posted` → `drafting` |
| 2 | `drafting` | `phase{to:drafting}` fired by `item_posted` | all seats' drafts in, or `T_draft` expired (one nudge to each missing seat at T_draft−60 s) → `revealing`; non-drafters are excluded from `reveal.order` and floor-barred for the item (§7.8) |
| 3 | `revealing` | `phase{to:revealing}` | engine finishes appending `reveal` + unsealed drafts (atomic batch) → `reactive` |
| 4 | `reactive` | `phase{to:reactive}` | budget `R` spent, or 2 consecutive `lull` events → `deciding` |
| 5 | `deciding` | `phase{to:deciding}` | `decision` event appended → `closed` (engine appends `item_closed` carrying the decision outcome as its resolution, unless the orchestrator supplies its own via `room_close_item`); escalation stalls here until orchestrator `room_decide` |

Terminal: `room_closed` from any state (orchestrator only). `idle` is a room-level condition (no active item), never an item's phase; `item_closed` writes the item's phase as `closed`, returning the room to `idle`.

**A decided item is a finished item.** The lifecycle ends at the decision; the Room does not execute the work it decides on (§11). There is no post-decision phase, so there is no re-entry loop and no reopen cycle: an item whose decision needs revisiting is re-posted as a new item, paying the full blind-draft price again. That is deliberate — `arXiv:2502.19130`'s rounds-hurt result applies over an item's lifetime, and a cheap reopen path is unbounded rounds with extra steps.

### 4.2 Invariants per state

Global (hold in every state):

- `INV-SINGLE-WRITER` — only the engine appends to `room_events`; `seq` is gapless and monotonic. Everything else (registry callbacks, host-tool branches) requests appends through the engine.
- `INV-FLOOR-UNIQUE` — at most one unexpired `floor_grant` exists; `room_say` is accepted only from its holder (§7.6).
- `INV-MASK` — no projection rendered to a seat ever contains another seat's `provider` or `model_id`; peers are persona `role` + seat name only. Defends against capability-deference convergence (`arXiv:2506.01332`). The orchestrator and Stage are exempt (the human may see everything).
- `INV-REPLAY` — engine state (phase, budget counters, floor state) is a pure fold over `room_events`; restart = replay (§10.4). `floor_bids`/`floor_grants` sit outside the fold by design: non-authoritative telemetry whose loss replay tolerates (§3.1).

Per-state:

- `drafting`: **`INV-BLIND`** — the projection of any seat contains zero content authored by other seats for this item: no draft bodies, no draft-arrival facts, no "3 of 6 submitted" progress, no bids, nothing. Sealed `draft` events exist in the ledger but are redacted (§5.3); arrival order is hidden by the randomized reveal. **This is the invariant that defends the `arXiv:2510.02360` result, and the one an implementer will be most tempted to relax** — streaming drafts to the browser early, or showing seats a submission counter, quietly recreates the shared-transcript condition that produced the strongest measured conformity collapse. The Stage may show *that* a seat is typing (pose animation) but never *what*, and seats themselves get no submission-progress signal at all.
- `reactive`: `INV-BUDGET` — the remaining-say budget decreases by exactly 1 per `say`; `pass` and `lull` do not consume it. `INV-NO-TALLY` — the projection never aggregates agreement ("N seats agree"); stances are per-event facts, never counted, until `deciding` (§6.4).
- `deciding`: `INV-SEALED-BALLOTS` — `ballot` events stay sealed until every seat has balloted or `T_vote` expires; the unsealing `decision` (or `escalated`) event flips them all at once. Rationale: a visible running tally is the Spiral-of-Silence condition applied to voting. `arXiv:2608.02758` is the sharpest evidence for this one: agents publicly conform at 64–94 % while privately dissenting, so a sealed ballot and an open one measure genuinely different quantities — the sealed one is the only channel that reads private belief.

### 4.3 Timing and budget constants

All configurable per room at `room_create`; defaults chosen in §7/§9 rationale. `S` = seat count.

| Constant | Default | Meaning |
|----------|---------|---------|
| `T_draft` | 300 s | blind-draft deadline |
| `W_bid` | 20 s | bid-window duration (≥ slowest seat's turnaround; latency-bias guard, §14.3) |
| `T_say` | 120 s | grant-to-say deadline before revocation |
| `T_vote` | 180 s | ballot deadline |
| `R` | `ceil(1.5 × S)` (9 at 6 seats) | reactive-round say budget per item |
| `K` | `S` | anti-domination lookback, counted in `say` events |
| `D` | 0.35 | anti-domination decay multiplier |
| `LULL_LIMIT` | 2 | consecutive zero-bid windows before phase advance |
| `MAX_DRAFT_BYTES` | 16384 | draft body cap |
| `MAX_SAY_BYTES` | 8192 | say body cap |

`R` errs small deliberately: `arXiv:2502.19130` shows rounds hurt after drafting. If transcripts show truncated-but-productive rounds, raise `R` before touching the gates.

## 5. The Ledger

### 5.1 Event kinds (closed enum)

Engine-authored (`actor_seat` NULL): `room_opened`, `seat_joined`, `seat_left`, `item_posted`, `phase`, `reveal`, `bid_window`, `floor_grant`, `floor_revoked`, `lull`, `decision`, `escalated`, `item_closed`, `room_closed`. Seat-authored: `draft` (sealed), `say`, `pass`, `ballot` (sealed).

Adding a kind is a schema change: it requires a projection rule (§6), a Stage mapping (§12.4), and a replay-fold case (§10.4) in the same change.

### 5.2 Payload schemas (the `body` JSON per kind)

```ts
type EventBody =
  | { kind: "room_opened";  room_id: string; config: RoomConfig }        // full constants table, for replay
  | { kind: "seat_joined";  seat: SeatPublic; desk_index: number }
  | { kind: "seat_left";    seat_id: string; reason: "dead" | "removed" }
  | { kind: "item_posted";  item_id: string; title: string; item_type: "reasoning" | "knowledge"; brief: string }
  | { kind: "phase";        item_id: string; from: Phase; to: Phase; cause: string; options?: BallotOption[] }  // cause: "all_drafts_in" | "t_draft_expired" | "budget_spent" | "lull_limit" | ...; options present iff to === "deciding" with vote protocol — the replay-authoritative ballot menu
  | { kind: "draft";        item_id: string; text: string }              // sealed until reveal
  | { kind: "reveal";       item_id: string; order: string[]; seed: string }  // seat ids in reveal order; seed = sha256(item_id + head_seq), recorded for reproducibility
  | { kind: "bid_window";   item_id: string; window_no: number; visible_through: number; closes_ts: number }
  | { kind: "say";          item_id: string; text: string; stance: Stance; grant_id: string }
  | { kind: "pass";         item_id: string; window_seq: number; reason?: string }
  | { kind: "floor_grant";  item_id: string; grant_id: string; seat_id: string; bid_id: string; deadline_ts: number; bid: { trigger_seq: number; trigger_kind: string; intensity: number; effective_weight: number; reason: string; stance: Stance } }  // winning bid embedded so floor history replays from the ledger alone
  | { kind: "floor_revoked";item_id: string; grant_id: string; cause: "timeout" | "seat_dead" }
  | { kind: "lull";         item_id: string; window_seq: number; consecutive: number }
  | { kind: "ballot";       item_id: string; choice: string; justification: string }  // sealed until decision/escalated
  | { kind: "decision";     item_id: string; protocol: "vote" | "consensus"; outcome: string; detail: DecisionDetail }
  | { kind: "escalated";    item_id: string; question: string; options: string[] }
  | { kind: "item_closed";  item_id: string; resolution: string }
  | { kind: "room_closed";  reason: string };

interface Stance {
  agrees_with:    number[];       // seqs of prior say/draft events
  disagrees_with: number[];
  adds: string;                   // one-line statement of the NEW claim/evidence/risk this say contributes
}

type Phase = "drafting" | "revealing" | "reactive" | "deciding" | "closed";  // item phases; room-level idle = no active item (§4.1)

interface BallotOption { id: string; text: string }  // deduped positions, seeded-random order, no support counts (§9.3)

interface RenderedEvent {         // the projection's output unit: room_view results, Stage transcript, SSE `ledger`
  seq: number; kind: string; seat_id?: string; role?: string; reply_to_seq?: number;
  summary: string;                // one-line rendering, always present
  text?: string;                  // full body when unsealed and unelided
  stance?: Stance;
  redacted?: true;
}

type DecisionDetail =
  | { protocol: "vote"; options: BallotOption[]; ballots: { seat_id: string; choice: string; justification: string }[];
      tally: Record<string, number>; winner: string }   // tally is legal here: the decision event IS the unsealing
  | { protocol: "consensus"; synthesis_seq: number; objections: { seat_id: string; justification: string }[]; adopted_round: 1 | 2 }
  | { protocol: "escalation"; question: string; chosen: string };
```

`SeatPublic` is `{ seat_id, role }` — the `INV-MASK`-safe subset. Provider/model live only in `room_seats`.

### 5.3 Sealing

`sealed = 1` rows are returned by every projection with `body` replaced by `{ kind, item_id, redacted: true }` — including to their *author's own Stage view* (the transcript panel shows "draft submitted"), though the author's seat projection includes its own text. Unsealing is not an UPDATE (the ledger is append-only): the `reveal` event (for drafts) or `decision`/`escalated` event (for ballots) instructs the projection to stop redacting rows whose `seq` it covers. A projection bug that ignores `sealed` is an `INV-BLIND` breach; the conformance test in §15 covers it.

### 5.4 Ordering guarantees

- Total order by `seq`; `seq` assigned under the engine's single write path (`INV-SINGLE-WRITER`), so no two events race.
- `reveal` and the draft-unsealing batch are appended in one SQLite transaction; no reader can observe a state where some drafts are revealed and others still sealed.
- `reply_to_seq` always references a lower `seq`; the engine rejects forward or dangling references (`invalid_reply_ref`).
- Mirror notifications (§5.6) are fire-and-forget and may lag; the ledger, never the notification stream, is authoritative.

### 5.5 Durability

Append = one INSERT inside a transaction, WAL mode, `synchronous=NORMAL`. A crash may lose the final uncommitted append but never reorders or corrupts; replay recovers engine state (§10.4). No compaction, no truncation; closed rooms keep their history.

### 5.6 Orchestrator mirror

Every append is mirrored to the orchestrator as a `notifications/claude/channel` notification `{ content: <one-line rendering>, meta: { room_id, seq, kind, seat_id? } }` through `sendNotification` (`src/server.ts:180-204`) — the same choke point `msg` uses, giving the human's session a live transcript for free. Sealed events mirror as their redacted form (the orchestrator sees "draft submitted by archie", not the text — the human can open the Stage for spectacle, but the *session transcript* respects the same blind phase so a pasted-back orchestrator context can't leak drafts to a seat).

## 6. The visibility projection

`view(seat_id, through_seq) → SeatView` renders one seat's legal knowledge of the room. Every path that shows a seat anything — turn prompts (§9), `room_view` results, grant messages — must go through it. It is a pure function of the ledger prefix, per `INV-REPLAY`.

### 6.1 Projection rules by phase

| Phase | What the seat's view contains |
|-------|-------------------------------|
| `idle` | item history summaries (closed items' `decision`/`item_closed` events only), own seat card |
| `drafting` | the `item_posted` event, own draft (if submitted), deadline. **Nothing else — `INV-BLIND`.** No other-seat facts of any kind dated after `item_posted`. |
| `revealing`/`reactive` | full unsealed item history: revealed drafts (in reveal order, uniformly formatted), all `say`/`pass`/`floor_*`/`lull` events, current budget remaining, open bid window if any |
| `deciding` | everything above + the `escalated` question if any; own ballot; **no other ballots** until unsealed |

### 6.2 Rendering contract

The projection renders events as structured text blocks (the seat is an LLM; the projection is prompt real estate):

```
[#41 say by rivet (skeptic)] re:#38
  Disagrees with #38. Adds: the SSE reconnect path drops events between Last-Event-ID and snapshot head.
  "…say text…"
[#42 pass by moss (infra)] — nothing new to add
```

- Attribution is seat name + role only (`INV-MASK`).
- Stances are shown per event, never summed (`INV-NO-TALLY`): the projection never emits "3 seats agree with #38", and revealed drafts are never grouped by position. Rationale: `arXiv:2506.01332`'s majority-convergence needs a majority *signal*; the projection's job is to withhold the tally even though a diligent seat could count for itself — the cheap cue is what drives the effect.
- Revealed drafts appear in the recorded random order with identical formatting — no "first mover" framing.

### 6.3 Size management

A view exceeding 24 KB (¾ of `MAX_RESULT_BYTES`) elides oldest-first: full text for the latest 2×`S` events, one-line summaries (seat, stance, `adds` line) for older ones, drafts always kept at full text. Elision is deterministic given `through_seq` so replays agree.

### 6.4 Where the anti-conformity design lives (summary)

- Blind drafting: `INV-BLIND` (§4.2) — the All-Agents-Drafting result, enforced.
- No agreement tallies: `INV-NO-TALLY` (§6.2).
- No capability cues: `INV-MASK` (§4.2, §6.2).
- Sealed ballots: `INV-SEALED-BALLOTS` (§4.2).
- Agreement is not a valid bid: Gate 1 (§7.4).
- Recency-domination decay: Gate 2 (§7.4).

## 7. Floor control

### 7.1 Reconciling the bid queue with `exclusive_acquire`

The architecture doc commits to two things that don't compose naively: a floor that *is* the existing cooperative lock, and a bid queue *ordered by weighted intensity*. The verified lock (§1) is FIFO, advisory, and non-blocking — it cannot express priority, and its "blocks until granted" description is false in code.

Resolution — **engine-mediated acquisition**: seats never call `exclusive_acquire`/`exclusive_release` for the floor. The engine selects a winner from the bid set (§7.5), then calls `registry.acquireExclusive("room:<room_id>:floor", winner_seat_id)` in-process on the winner's behalf, and `releaseExclusive` when the say lands or the grant is revoked. Because the engine only acquires when it has itself observed the floor free, the synchronous non-blocking semantics never bite, and `exclusiveQueue` stays empty for this pattern — priority lives entirely in bid scoring. The existing lock remains the enforcement and observability substrate (its state is inspectable and its transitions already emit channel notifications, `src/server.ts:503-512`); no second lock mechanism is invented, honoring the brief. The seats' interface to the floor is `room_bid`/`room_say`, full stop.

The existing agent-facing `exclusive_acquire`/`exclusive_release` host tools stay untouched for their original purpose (command patterns declared exclusive at spawn). The `room:` pattern prefix is reserved: the host-tool branch rejects agent-initiated `exclusive_acquire` on `room:*` with `reserved_pattern`.

### 7.2 The bid window cycle

The reactive round is a sequence of engine-driven windows, not a free-for-all:

1. Engine appends `bid_window {window_no, visible_through: head_seq, closes_ts: now + W_bid}`.
2. Engine turn-drives every seat (§9.1) with its projection delta and the window notice.
3. Each seat must respond with exactly one `room_bid` or `room_pass` before `closes_ts`. No response by the deadline → engine appends `pass {reason: "window_timeout"}` on the seat's behalf. Silence is an event, not an absence.
4. Window closes; engine scores (§7.4–7.5); zero valid bids → `lull` (§7.7); else grant (§7.6).
5. The granted say lands (or the grant is revoked); if budget remains, next window opens.

Batching bids into windows is what makes scoring a comparison rather than a race, and `W_bid = 20 s` is a latency-fairness floor: a first-come floor hands the room to whichever provider streams tokens fastest (§14.3).

### 7.3 Bid content

A bid names its trigger (`mention` | `contradiction` | `domain` | `direct_address` — the architecture doc's four), the event that fired it, an intensity in [0,1], a one-line reason, and the stance it intends to take (§8.3 for the full signature). Intensity anchors, stated in every seat's phase instructions: 0.2 marginal addition · 0.5 substantive disagreement or new evidence · 0.8 blocking objection · 1.0 correctness-critical ("the decision will be wrong").

### 7.4 The two suppression gates

Applied at window close, in order:

- **Gate 1 — anti-sycophancy** (`arXiv:2509.23055`): a bid whose stance has empty `disagrees_with` AND empty `adds` is rejected (`outcome: rejected_gate1`) and converted to a `pass {reason: "agreement_only"}`. Agreement-without-new-content is not a valid reason to hold the floor. Enforcement is structural in v1 — the fields must be present and non-empty; no semantic judge verifies that `adds` is genuinely novel. This is a committed simplification, not an oversight: a deterministic host cannot judge novelty, an LLM judge doubles latency and adds a co-model to every exchange. Named risk: seats learn to pad `adds` with restatements. The tell is in the transcript (§14.4) and the counter is persona instruction plus, if measured necessary later, a post-hoc judge that *audits* rather than gates.
- **Gate 2 — anti-domination decay**: if the bidding seat authored any of the last `K` `say` events for this item, and no later event `reply_to`'s or `direct_address`-mentions that seat, its `effective_weight = intensity × D` (D = 0.35); otherwise `effective_weight = intensity`. `pass` events do not count as "spoke" — a silent seat must never accumulate suppression, or the gate itself re-creates the spiral. Being addressed lifts the decay because a seat under direct challenge must be able to answer. `K` counts over the item's *entire* `say` history — domination is an item-level property, not a per-window one.

### 7.5 Selection and tie-breaking

Winner = highest `effective_weight`. Ties (within 1e-9): (1) fewest `say` events this item; (2) deterministic pseudo-random by `sha256(window_seq + seat_id)` — seeded so replay reproduces the grant. Losing bids get `outcome: lost`; they do not carry over — a seat that still cares re-bids next window with current context.

### 7.6 Grant, say, revocation

- Grant: engine acquires the lock, appends `floor_grant {grant_id, seat_id, bid_id, deadline_ts: now + T_say}`, and turn-drives the winner with the grant message (§9.2).
- `room_say` is accepted only when (a) an unexpired grant names the seat, and (b) the body's `stance` passes Gate 1's structural check again (a bid that promised disagreement can't cash in an empty say). On accept: append `say`, decrement budget, release the lock, mark the grant `said`.
- Revocation: `deadline_ts` passes without a say → append `floor_revoked {cause: "timeout"}`, release the lock, mark the bid `expired`, open the next window. Seat death (the registry surfaces `state: "dead"` — `AgentState` at `src/agent.ts:39`; the internal `stopped` flag at `src/agent.ts:243` is private, so deliberate stop and crash are indistinguishable at this surface, which is why `seat_left.reason` has no "stopped" value: `"dead"` is the liveness verdict, `"removed"` an orchestrator action the engine itself performed) → same path with `cause: "seat_dead"` plus a `seat_left` event; the seat's pending bids are voided. A revoked-timeout seat is not otherwise penalized: its next bid rides Gate 2 like anyone's.
- A `room_say` from a non-holder returns `not_floor_holder` (§8.3) and appends nothing.

### 7.7 Nobody bids

Zero valid bids at window close → `lull {consecutive: n}`. `LULL_LIMIT` (2) consecutive lulls → phase advance (`reactive → deciding`). One lull between active windows is normal breathing; the double-lull rule distinguishes "conversation finished" from single-window hesitation. A lull never blocks: the engine always either opens another window or advances phase — the room cannot deadlock waiting for enthusiasm.

### 7.8 Seats that never drafted

A seat that misses `T_draft` (after the one −60 s nudge) is excluded from `reveal.order` and barred from the floor for the item's whole lifetime — its `room_bid` returns `no_draft`. It still ballots in `deciding`: judging presented options doesn't require having taken an independent position, but speaking without one is exactly the contamination the blind phase exists to prevent (All-Agents Drafting, §2), so the bar falls on the floor, not the vote. Quorum arithmetic uses `S_effective` = live seats that drafted (consensus objection threshold `⌈S_effective/3⌉`), plus balloting non-drafters for vote majorities. Fewer than 2 drafts in → the item skips straight to `escalated`; there is no conversation to have.

## 8. Agent-facing tool surface

Six new entries in `HOST_TOOLS` (`src/server.ts:317`), each with a branch in `handleHostRequest` (`:403`), same seam as `msg`. Every result rides `hostResult` (payload JSON-stringified into a text block, ≤ `MAX_RESULT_BYTES`). Every error is `hostResult(id, { error: { code, message } }, true)`; codes are closed per tool below, plus the shared codes `not_seated` (caller isn't a seat in the open room), `no_active_item`, and `wrong_phase {expected, actual}`.

Definitions follow the verified `RpcHostToolDefinition` shape and house style (verbatim shape of the existing `exclusive_acquire` entry).

### 8.1 `room_draft`

```ts
{
  name: "room_draft",
  label: "Submit blind draft",
  description:
    "Submit your independent take on the active item during the blind-draft phase. " +
    "You cannot see other seats' drafts and they cannot see yours until the reveal. " +
    "One submission per item; there is no editing after submission.",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "Your full draft position: claim, reasoning, risks. Max 16 KB." } },
    required: ["text"],
  },
}
```

Result: `{ submitted: true, seq: number }`. Errors: `wrong_phase`, `duplicate_draft`, `body_too_large`. Branch: resolve seat from `agentId` (the host-request context already carries it — same mechanism the `msg` branch uses); check phase == `drafting`; check no prior `draft` by this seat for the item; cap at `MAX_DRAFT_BYTES`; append sealed `draft` event via engine; if this was the last outstanding seat, engine fires the `drafting → revealing` transition in the same tick.

### 8.2 `room_bid`

```ts
{
  name: "room_bid",
  label: "Bid for the floor",
  description:
    "Bid to speak during an open bid window. Name the event that triggered you, price your urgency " +
    "honestly (0.2 marginal / 0.5 substantive / 0.8 blocking / 1.0 correctness-critical), and declare " +
    "your stance. Agreement without new content is not a valid bid and will be converted to a pass.",
  parameters: {
    type: "object",
    properties: {
      trigger_seq:  { type: "number", description: "seq of the event you are responding to." },
      trigger_kind: { type: "string", enum: ["mention", "contradiction", "domain", "direct_address"] },
      intensity:    { type: "number", description: "0..1, see anchors." },
      reason:       { type: "string", description: "One line: why you, why now." },
      stance: {
        type: "object",
        properties: {
          agrees_with:    { type: "array", items: { type: "number" } },
          disagrees_with: { type: "array", items: { type: "number" } },
          adds:           { type: "string", description: "The new claim/evidence/risk you will contribute. Required unless disagreeing." },
        },
        required: ["agrees_with", "disagrees_with", "adds"],
      },
    },
    required: ["trigger_seq", "trigger_kind", "intensity", "reason", "stance"],
  },
}
```

Result: `{ accepted: true, bid_id: string, window_no: number, note: "Outcome arrives when the window closes." }` — acceptance ≠ grant. Gate-1 rejection is returned *immediately* as `{ accepted: false, converted_to: "pass", why: "agreement_only" }` (not an error — the seat should learn the rule, not retry). Errors: `wrong_phase`, `bid_window_closed`, `duplicate_bid` (one bid per seat per window), `invalid_intensity` (clamped values outside [0,1] are rejected, not clamped — mispricing is a signal), `invalid_trigger_ref` (trigger_seq not in this item or not visible to the seat), `no_draft` (§7.8). Branch: validate open window (`bid_window` event with `closes_ts` in the future and no later `bid_window`/`lull`); validate trigger visibility via `view(seat, window.visible_through)`; run Gate 1 structurally; insert into `floor_bids`; scoring happens at window close in the engine, not in the branch.

### 8.3 `room_say`

```ts
{
  name: "room_say",
  label: "Speak to the room",
  description:
    "Speak while holding the floor. Only the seat named by the current grant may call this; everyone " +
    "else gets not_floor_holder. Your say must carry the stance your bid promised — an empty stance " +
    "is rejected even while holding the floor.",
  parameters: {
    type: "object",
    properties: {
      text:         { type: "string", description: "What you say. Max 8 KB." },
      stance:       { /* same shape as room_bid.stance */ },
      reply_to_seq: { type: "number", description: "The event you are answering. Usually your bid's trigger_seq." },
    },
    required: ["text", "stance"],
  },
}
```

Result: `{ said: true, seq: number, budget_remaining: number }`. Errors: `not_floor_holder {holder_role, hint: "bid at the next window"}`, `grant_expired`, `stance_empty` (Gate-1 recheck failed), `body_too_large`, `invalid_reply_ref`. Branch: look up unexpired grant; compare seat; recheck stance; append `say` with `grant_id`; engine releases the lock, decrements budget, and (budget > 0) opens the next window — all downstream of the append, inside the engine, not the branch.

### 8.4 `room_pass`

```ts
{
  name: "room_pass",
  label: "Pass this window",
  description:
    "Explicitly decline to bid in the open window. Passing is recorded — silence is an event. " +
    "Passing never counts against you in floor scoring.",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", description: "Optional one-liner, e.g. 'nothing new to add'." } },
    required: [],
  },
}
```

Result: `{ passed: true, seq: number }`. Errors: `wrong_phase`, `bid_window_closed`, `already_responded`. Branch: validate open window and no prior response this window; append `pass`.

### 8.5 `room_ballot`

```ts
{
  name: "room_ballot",
  label: "Cast sealed ballot",
  description:
    "Cast your ballot during the decide phase. Ballots are sealed until every seat has voted or the " +
    "deadline passes, then all are revealed at once. You will not see any other ballot before then.",
  parameters: {
    type: "object",
    properties: {
      choice:        { type: "string", description: "One of the options named in the decide prompt." },
      justification: { type: "string", description: "One line. Revealed with the ballot." },
    },
    required: ["choice", "justification"],
  },
}
```

Result: `{ cast: true }` — deliberately no "n of m have voted" (`INV-SEALED-BALLOTS` denies the running tally even as metadata). Errors: `wrong_phase`, `duplicate_ballot`, `invalid_choice`. Branch: validate phase and option membership against the `phase{to:deciding}` event's `options` (ledger-recorded, §5.2 — the menu survives replay, not just engine memory); append sealed `ballot`; if last outstanding, engine tallies (§9.3).

### 8.6 `room_view`

```ts
{
  name: "room_view",
  label: "Refresh room view",
  description:
    "Pull your current view of the room: phase, unsealed history you are entitled to see, budget, and " +
    "any open window or grant. Use when you have been away from the room; during standup phases the room turns " +
    "you with fresh context automatically.",
  parameters: {
    type: "object",
    properties: { since_seq: { type: "number", description: "Return only events after this seq. Omit for the full windowed view." } },
    required: [],
  },
}
```

Result: `{ phase, budget_remaining, open_window: {...} | null, my_grant: {...} | null, events: RenderedEvent[], through_seq }` — always `view(seat, head)`-filtered, sealed rows redacted, ≤ 24 KB per §6.3. Errors: `not_seated` only. Branch: pure read through the projection; no append.

### 8.7 Existing tools, unchanged

`msg`, `task_create`, `task_update`, `task_list` stay as-is — seats keep the substrate tools they already have, and the Room adds no meaning to them. `exclusive_acquire`/`exclusive_release` stay for command patterns, with the `room:*` prefix rejection added (§7.1).

## 9. What a seat is told

The engine drives seats through the registry's send path (the same mechanism the orchestrator's send tool uses); seats are never expected to poll. All engine-authored prompts embed the projection (§6) — never raw ledger rows.

### 9.1 Without the floor (window turn)

```
[room] Bid window #4 is open for 20s. New since your last turn:
<projection delta>
Budget: 5 says remain this round.
Respond with exactly one tool call: room_bid (if a trigger fires and you have
something NEW — agreement alone converts to a pass) or room_pass.
```

### 9.2 Holding the floor

```
[room] You hold the floor (grant g-7f3a, 120s). Your bid: "SSE reconnect drops
events" re:#38 (contradiction, 0.8).
Speak with room_say. Your say must disagree with something or add something —
that is what you bid. One say; the floor releases when it lands.
```

The asymmetry is deliberate: a non-holder is offered a *choice* framed around triggers and novelty; a holder is reminded of the *specific commitment* its bid made. Both prompts restate the gate the seat is most likely to violate at that moment.

### 9.3 Phase prompts

- `drafting`: item brief + "draft blind; nobody sees this until the reveal; deadline T". No submission-progress signal ever (`INV-BLIND`).
- `deciding` (vote — the narrow opt-in, see §10.2): the engine composes options from the reactive round's terminal positions — every distinct `say`-stance cluster and each unaddressed draft position, worded from one author's words, plus always "none of the above — escalate". Presentation is normalized so the menu carries no majority signal (`INV-NO-TALLY` holds *through* balloting, not just until it): one option per distinct position no matter how many seats hold it, no support counts, no author attribution, seeded-random order. The menu is recorded in the `phase{to:deciding}` event body (`options`, §5.2) — what `room_ballot` validates against and what replay reconstructs. Seats ballot sealed; majority of cast ballots wins; ties or a "none" plurality append `escalated` and stall for orchestrator `room_decide` (§10.2). The tally becomes public only inside the `decision` event's `DecisionDetail`.

  **Minority Truth warning** (`arXiv:2606.29270`): majority voting is only sound when errors are independent, and shared pretraining corpora break that assumption — in roughly 1 of 4 divergent cases the minority is the one holding the correct answer. Nothing in this protocol detects that, which is why `reasoning`/vote is the opt-in and not the default (§10.2). Do not "fix" it with an LLM-as-Judge overturn step: the same paper measures that baseline at *negative* net gain. The mitigation available here is cheap and post-hoc — sealed ballots preserve every dissenting justification verbatim in the ledger, so a suppressed minority is legible in the transcript afterward (§14.4).
- `deciding` (consensus): engine nominates the synthesizer = seat with *fewest* `say` events this item (ties per §7.5) — the least-dominant voice writes the synthesis, a deliberate inversion of capability-convergence; synthesizer drafts via a granted say; every other seat gets one sealed approve/object ballot (`choice: "approve" | "object"`, objection requires the justification to name the sentence objected to); objections < ⌈S_effective/3⌉ → adopted (§7.8 defines S_effective); else one revision cycle (synthesizer sees objections unsealed), then re-ballot; second failure → `escalated`.

## 10. The engine

### 10.1 Placement

`src/room/` inside deleg8 — not a separate process. It must call `registry.acquireExclusive` in-process, append through the single writer, hook `wireAgent`, and answer host-tool branches synchronously; an out-of-process engine would need an RPC layer for all four with no compensating benefit. (The Stage, which only *reads*, is the piece that leaves the process — §12.)

### 10.2 Orchestrator-facing MCP tools (registered beside the existing `spawn`/`send`/`list`)

- `room_create({ config? })` → opens the room; errors `room_exists`.
- `room_cast({ seats: [{ agent_id, provider, model_id, role, expertise, character_asset }] })` → spawns/adopts each named agent through the existing spawn path (budget checks included), writes `room_seats`/`seat_personas`, appends `seat_joined` per seat. Rejects (`identity_leak`) any `agent_id` or `role` containing a provider or model-family substring — checked case-insensitively against the cast's own `provider`/`model_id` values plus the well-known family tokens (claude, gpt, gemini, deepseek, glm, llama, qwen, mistral, grok, opus, sonnet, haiku) — because the architecture doc's own example names (`archie`, `deep`, `glm`) would defeat `INV-MASK` from the casting call. Other composition warnings (§14.2) are returned, not enforced. Casting closes at the first `item_posted`: no mid-room recasting or seat replacement in v1 — a room that loses a seat runs down a seat, S-derived constants recompute from live seats at each use, and §14.2 warnings re-emit on every `seat_left`.
- `room_post_item({ title, brief, item_type })` → appends `item_posted`; fires `idle → drafting`. `item_type` selects the §9.3 decision protocol and **defaults to `knowledge`** (consensus) when omitted. `reasoning` (vote) is the deliberate opt-in, justified only when a verifiably-correct answer exists *and* the seats are unlikely to be wrong in the same direction. Two independent reasons for that default:
  - Majority voting suppresses a correct minority in ~1 of 4 divergent cases once errors correlate, which shared pretraining guarantees (`arXiv:2606.29270`, §9.3).
  - A wrong `reasoning` call converts genuine disagreement into routine escalations.

  Consensus is not free either — it routes through a synthesizer and can adopt a bland middle. But its failure mode is visible in the synthesis text, whereas a vote's failure mode is a clean-looking tally over a suppressed truth.
- `room_decide({ item_id, outcome })` → resolves an `escalated` stall; appends `decision {protocol: "escalation"}`.
- `room_close_item({ item_id, resolution })`, `room_close({ reason })`.
- `room_status({})` → phases, budget, floor state, seat liveness — orchestrator-eyes, unmasked.

### 10.3 Internal responsibilities

Timers (window close, grant deadline, draft/vote deadlines) via ordinary `setTimeout` re-armed from replay on boot; seat turn-driving; window scoring; the ledger single-writer queue; the registry death-watch (subscribing to the same liveness the `list` tool reads — a dead seat mid-grant triggers §7.6 revocation).

### 10.4 Crash and restart

On boot, recovery runs in a fixed order: (1) the existing `adoptPersisted` + `wireAgent` loop (`src/server.ts:1297-1298`) rebuilds agent shells from the registry exactly as today — it knows nothing of rooms, and adopted agents resume lazily on first send (`src/agent.ts:561`); (2) the engine replays `room_events` through the pure fold to reconstruct phase, budget, floor, and pending windows. The join key is `agent_id`: a `room_seats` row whose agent the registry did not recover is declared dead on first tick (`seat_left {reason: "dead"}`, revocation per §7.6); an adopted agent absent from `room_seats` is simply not a seat. Any grant whose `deadline_ts` passed during downtime is revoked on first tick; an open bid window that expired during downtime closes with whatever `floor_bids` still holds — in the worst case none, which is a lull, not corruption (`floor_bids` is loss-tolerated telemetry, §3.1). `INV-REPLAY` makes the rest mechanical: no authoritative room state lives outside the ledger except armed timers, and timers are derivable.

## 11. Execution after a decision (explicitly out of scope)

The Room deliberates and decides. It does not implement. An earlier draft of this spec carried a `working` phase in which seats ran real work turns in their own cwds, made audible to each other through throttled `tool_activity` summaries; that phase is cut from v1 and the reasoning is recorded here because "why doesn't the Room do the work?" is the first question a reader will have.

### 11.1 Why the work phase was cut

- **The evidence points the wrong way.** Cognition's multi-agent retrospective names the exact shape: "the decision-making ends up being too dispersed and context isn't able to be shared thoroughly enough between the agents," and "actions carry implicit decisions, and conflicting decisions carry bad results." Parallel seats editing separate trees is that configuration. A ≥ 30 s throttled one-line summary per seat is not a repair for it — it is a rumor channel.
- **The Room's own build plan already does execution correctly** (§17.1): one implementer per task, exclusive file ownership, no two agents in a wave touching the same file. That is the pattern that works, and it is not the one a `working` phase would have built.
- **Nothing in the anti-conformity design needs it.** Every invariant, gate, and research constraint in §2 is about deliberation. The work phase was the only part of the spec carrying build cost with no evidence behind it.

### 11.2 What replaces it

The `decision` event is the artifact. The orchestrator reads it and dispatches implementation through the ordinary deleg8 path — `spawn` a single-threaded implementer per task, with the decision text as its brief. Nothing new is required to make this work; it is what the orchestrator would do with a decision anyway.

### 11.3 What this deletes from the build

`R_work`, `W_work`, `REENTRY_LIMIT`, `REOPEN_LIMIT`, work-phase bid windows, the `tool_activity` event kind, `INV-AUDIBLE`, the work→reactive re-entry path, and the `onToolActivity` substrate hook. The last one matters most for sequencing: `src/agent.ts` needs no change at all now, so W0-SUBSTRATE shrinks to the `room:*` reserved-pattern guard (§17.2).

If a future version wants seats audible during execution, it needs a real answer to the dispersed-context problem, not a summary feed — and that answer belongs in its own spec.

## 12. The Stage

### 12.1 Process split

`stage/` is a separate Bun process (`bun run stage`), serving `127.0.0.1:${DELEG8_STAGE_PORT:-8321}`. It opens `rooms.db` read-only in WAL mode and polls for `seq > last_seen` on its tick — SQLite WAL guarantees consistent snapshot reads against the writer without coordination. Justification for the split: crash isolation both ways (a deleg8 restart drops no browser; a Stage crash costs one `bun run stage`), zero write authority (the browser stays disposable, per the ledger-replay principle), and no MCP/stdio entanglement with an HTTP listener. The Stage knows the ledger schema and nothing else: no registry, no omp, no models, no personas beyond `SeatPublic` + `character_asset` + `desk_index`. deleg8 knows nothing of the Stage — it cannot tell whether one is running. The only shared surface is the SQLite file and the event-kind enum (§5.1), pinned by a `stage/LEDGER_VERSION` check against a `room_opened.config.ledger_version` field; mismatch → the Stage refuses to serve rather than misrender.

Binding is localhost-only; there is no auth layer. Exposing the port beyond localhost is out of scope for v1 and must not be done by "just" changing the bind address — the transcript is the user's working data.

### 12.2 Tick and projector

Fixed tick at 200 ms (5 Hz). Each tick: read new events → advance the projector FSM → emit at most one frame (skipped when nothing changed). The projector maps room state to per-seat presentation:

| Room state | zone | pose |
|------------|------|------|
| `idle` | `desk[desk_index]` | `sit_work` |
| `drafting` | `desk[desk_index]` | `sit_type` (visibly writing, content never shown — `INV-BLIND` allows *that*, never *what*) |
| `revealing`–`deciding` | `standup_circle[slot]` | `stand_idle`; floor holder `stand_talk`; balloting seats `stand_think` |
| seat with open grant | circle center | `stand_talk` |
| `seat_left` | offstage | walk-out via nav path, then removed |

Zone and pose are closed unions on the wire: `type Zone = "desk:<n>" | "circle:<n>" | "circle_center" | "offstage"` (templates over desk/slot index) and `type Pose = "sit_work" | "sit_type" | "stand_idle" | "stand_talk" | "stand_think" | "walk"`. Zones are named anchor points authored into the office glTF; movement between zones is pathfound (§12.5) client-side from zone-change frames — the wire protocol carries *targets*, not trajectories.

### 12.3 Wire protocol

`GET /room/current/snapshot` → `{ room_id, ledger_version, phase, seats: [{ seat_id, role, desk_index, character_asset }], zones: {...}, transcript: RenderedEvent[<= 200, unsealed only>], stage: { tick, positions: [{seat_id, zone, pose}] }, through_seq }`. Cold load = snapshot, build scene, then subscribe.

`GET /room/current/events` (SSE), events by `id:` = ledger `seq` for transcript items and `t<tick>` for frames:

- `frame` — `{ tick, through_seq, seats: [{ seat_id, zone, pose }] }` (only-on-change)
- `ledger` — `{ events: RenderedEvent[] }` (unsealed renderings for the transcript panel; sealed events appear as redacted stubs)
- `phase` — `{ item_id, to }` (also present in `ledger`; duplicated as its own event so the client can gate scene-level transitions without parsing)
- `heartbeat` — every 15 s

Reconnect: the client sends `Last-Event-ID`; the Stage replays from its ring buffer (last 600 ticks ≈ 2 min + last 500 ledger renderings). Gap beyond the buffer → the Stage sends `resync` and the client re-runs the snapshot path. The ring buffer is the *only* Stage state; it is rebuildable from the ledger at any time.

### 12.4 Client state model

Four states: `loading` (snapshot fetch) → `live` (SSE flowing, interpolating) → `degraded` (no heartbeat for 30 s: banner, keep rendering last state, auto-retry with backoff) → `resync` (buffer overrun or `ledger_version` change: rerun snapshot, rebuild, return to `live`). Character motion renders 2 ticks (400 ms) behind the newest frame through an interpolation buffer: positions lerp, zone changes trigger pathfinding walks, pose changes crossfade. Frames arriving out of order or duplicated (SSE replay) are dropped by `tick` comparison — rendering is idempotent over frames.

**Validate-early flag (unchanged from both corpora and the architecture doc): no source directly evidences SSE-driven three.js reconciliation; the fixed-tick + interpolation-buffer pattern is reasoned by analogy from recast-navigation's crowd `interpolatedPosition`. Build the §15 transport spike before any office-art investment.**

### 12.5 Scene and characters (corpus-fixed choices)

- Raw three.js (r17x line), no r3f — no React shell exists to justify it.
- Office: kit-bashed glTF, hand-placed, baked lightmaps for the static shell, realtime lights on characters only (baked shadows pin geometry static — corpus STRONG).
- Per-seat `SkinnedMesh` + `AnimationMixer`, naive, no instancing/LOD: the measured CPU cliff is 200–300 animated characters on 2014 hardware; 6 seats is ~2–3 % of it (corpus STRONG; the "30–60" and "~100" numbers floating in the corpora are unsourced buffers — ignore them).
- Animation FSM hand-rolled over `AnimationMixer` (no maintained library exists — corpus checked); poses from §12.2 map to Mixamo clips shared across characters via the `mixamorig*` bone contract.
- Characters: VRM/VRoid, Microsoft RocketBox (MIT), MPFB (CC0) — each needs a hand-built bone-name remap to `mixamorig*` and rebuilt `AnimationClip` tracks; no retargeting library exists, this is per-asset work (§15). Ready Player Me is dead (public access closed 2026-01-31); any tutorial built on it is pre-shutdown contamination.
- Navigation: `navcat` (recast-navigation-js's own recommended successor; pure JS, ships crowd avoidance) for desk↔circle walks.
- `AnimationAction.crossFadeTo` has a reported T-pose-snap bug (single source); verify against the pinned three.js version before hand-rolling weight lerps (§15).

## 13. File layout and ownership

```
src/room/
  ledger.ts       # owns rooms.db writes, event schema/validation, seq assignment, replay fold.
                  #   Must not know: agents, registry, omp frames, HTTP, three.js.
  visibility.ts   # view(seat, through_seq): projection, sealing, INV-MASK/INV-NO-TALLY rendering, 24KB elision.
                  #   Pure over ledger rows. Must not know: registry, timers, host tools.
  floor.ts        # bid windows, gates, scoring, tie-break, grant/revoke bookkeeping.
                  #   Calls registry.acquireExclusive/releaseExclusive. Must not know: omp frames, prompts, HTTP.
  phases.ts       # state machine: legal transitions, per-phase invariant checks, budget/lull accounting.
                  #   Pure decisions; effects (appends, timers) requested via engine. Must not know: registry, HTTP.
  cast.ts         # seat spawning/adoption through registry, personas, INV-MASK boundary (SeatPublic).
  prompts.ts      # every engine-authored seat prompt (§9). Must not know: SQLite, HTTP.
  engine.ts       # composition root: timers, turn-driving, window lifecycle, death-watch, replay-on-boot,
                  #   orchestrator tool implementations (§10.2). The only module that touches everything above.
  host-tools.ts   # the six RpcHostToolDefinitions + branch handlers, exported for server.ts registration.
                  #   Must not know: SQLite directly (goes through engine/ledger APIs).
src/server.ts     # +3 seams: spread room HOST_TOOLS into the array at :317 with matching dispatch in
                  #   handleHostRequest at :403; register §10.2 tools beside spawn/send/list; reject room:*
                  #   patterns inside the existing exclusive_acquire branch (§7.1).
src/agent.ts      # untouched — the onToolActivity hook died with the work phase (§11.3).
stage/
  server.ts       # Bun.serve: snapshot + SSE, ring buffer, read-only rooms.db tailing, LEDGER_VERSION check.
  projector.ts    # ledger → zone/pose FSM (§12.2). Pure. Must not know: HTTP, three.js.
  web/            # static client: main.ts, scene.ts (office glTF + lights), characters.ts (SkinnedMesh FSM,
                  #   remap dictionaries per asset source), net.ts (§12.4 state machine + interpolation), transcript.ts.
  assets/         # office glTF, character models, shared mixamo clips.
```

The dependency arrows all point one way: `server.ts → host-tools → engine → {floor, phases, cast, prompts} → {ledger, visibility}`; `stage/* → rooms.db (read-only)`. No module in `src/room/` imports from `stage/` or vice versa — the SQLite file and §5.1's enum are the entire contract between them.

## 14. Seat composition and failure modes

### 14.1 What `arXiv:2506.01332` forces

Debates converge on the numerically dominant group or the most capable model. Both pressures are tunable at casting time; neither is decoration.

Two later results narrow what casting can actually buy you:

- `arXiv:2509.05396` measured accuracy decay **even when stronger models outnumbered weaker ones**. Seating better models is therefore not a mitigation — it is at best neutral. The protocol has to do this work.
- `arXiv:2608.02758` measured conformity as "highly model-dependent, though uncorrelated with capability." That breaks the assumption underneath a capability-tier casting rule: the axis that predicts whether a seat folds is not the axis that predicts whether it is smart.

### 14.2 Casting rules (`room_cast` warns on violation)

- Never seat 3+ agents of one model family in a 6-seat room (numerical dominance is the stronger measured pull). Warn at 2 when S ≤ 4.
- `INV-MASK` removes the *identity* cue for capability-deference, but style leaks; keep at least two seats within the same rough capability tier so no single seat is stylistically unmistakable as "the smart one."
- **Cast on measured conformity, not capability tier.** Once a room has run one item, each seat's fold rate is computable from the ledger (§14.5) — prefer low-fold seats, and never let high-fold seats form the numerical majority. Until that measurement exists for a given model, treat conformity as unknown rather than inferring it from benchmark strength; `arXiv:2608.02758` found the two uncorrelated.
- Capability asymmetry is not automatically an asset. For `reasoning` items it is tempting to read convergence-on-the-strongest-seat as the mechanism working, but `arXiv:2509.05396` measured decay even with stronger models in the majority — so treat that convergence as unproven benefit, not as a reason to skew the cast. Spend heterogeneity on `knowledge`/design items, where the convergence is unambiguously a bug.
- Vote-heavy rooms: cast an odd seat count (5) — S=6 makes `escalated` ties routine, which silently converts the decision protocol into "the orchestrator decides."
- Personas: assign disjoint `expertise` tags (they are the `domain` trigger surface — overlaps make every seat bid on everything); write roles as *stances toward risk* ("skeptic — hunts unstated assumptions"), not job titles, since role text is the main lever the sycophancy literature leaves us.

### 14.3 Latency fairness

Heterogeneous providers mean heterogeneous turnaround. Two guards exist; keep both honest: `W_bid` (20 s) must exceed the slowest seat's typical bid turnaround — check `floor_bids` for seats whose bids disproportionately arrive `bid_window_closed`; and window batching means bids compare on weight, never arrival order. If a seat still can't land bids, the fix is raising `W_bid`, not seating faster models — the fast-caucus failure below is worse than slow rounds.

### 14.4 Transcript failure signatures (gates tuned wrong)

| Mistuning | What the transcript shows |
|-----------|---------------------------|
| Gate 1 too loose (or `adds` padding unpunished) | "Strong point — additionally, <restatement of #34>" chains; stances all-`agrees_with`; decisions unanimous by round 2 — the sycophancy collapse the gate exists to stop |
| Gate 1 too tight | disagreement theater: manufactured objections withdrawn at ballot time; `disagrees_with` filled while `adds` is vacuous |
| K too small / D too weak | one seat authors >40 % of says; others' bids perpetually `lost` |
| K too large / D too strong | strict round-robin cadence; urgent rebuttals (0.8+) losing to stale 0.5 bids; floor-holders hoarding into monologues |
| R too large | late-round says converge to agreement-only attempts (visible as rising `rejected_gate1` + `lull` before budget exhausts) — attrition convergence, `arXiv:2502.19130`'s measured harm |
| R too small | `deciding` opens with live `disagrees_with` edges unanswered; escalations spike |
| `W_bid` too short | fast-provider caucus: the same 2–3 low-latency seats hold every floor; slow seats' bids at `bid_window_closed` |
| `LULL_LIMIT` = 1 | rooms stampede to `deciding` after any thinking pause |
| Minority Truth (vote items) | the losing ballot's justification reads as the better argument, or is later proved right in implementation — the majority was wrong together. Not a constant to tune: it is the signal to stop using `reasoning`/vote for this class of item (§10.2) |
| Conformity collapse between draft and ballot | seats' revealed drafts hold distinct positions, but ballots cluster on one — measured per seat as fold rate (§14.5). High room-wide fold means the reactive round is doing harm, not work |

These signatures are the tuning feedback loop: read the transcript, match the row, adjust the one named constant. Tuning order when several fire: Gate 1 first, then K/D, then R — sycophancy contaminates the evidence for every other diagnosis. The last two rows are not tuning targets; they indict the decision protocol and the cast respectively.

### 14.5 Fold rate: conformity measured from the ledger

The Room already records everything needed to measure conformity per seat, so no separate instrument is built:

- The sealed `draft` is the seat's position **before** any peer exposure (`INV-BLIND` guarantees this — it is the strongest property the ledger has).
- The sealed `ballot` is the same seat's position **after** the full reactive round.

`fold_rate(seat)` = the fraction of items where a seat's ballot abandons its own draft position for one it saw during the reactive round. That is exactly the public/private divergence `arXiv:2608.02758` measured at 64–94 %, computed over real items instead of a synthetic benchmark.

Two properties make this cheap enough to be worth trusting:

- **It is a query, not a mechanism.** Both event kinds already exist, already sealed, already unsealed together. No new tables, no new tool, no engine changes.
- **It is honest by construction.** A seat cannot game its own fold rate without knowing peer positions at draft time, which `INV-BLIND` denies it.

Caveats worth stating before anyone over-reads the number: changing your mind on evidence is *correct* behavior, so fold rate measures conformity only in aggregate and only against the justification text — a seat that folds with a reason that cites new evidence is doing its job. Read the rate to rank seats against each other, never as an absolute defect count. It also needs several items before it means anything; one item gives you a coin flip.

## 15. Early validation items (build these spikes first)

1. **Transport spike** — headless Stage emitting synthetic frames at 5 Hz over SSE into a 3-cube three.js page with the §12.4 interpolation buffer; kill/restore the server mid-run. Proves the analogy-only transport before any art or engine work. (Weakest-evidenced piece, both corpora + arch doc agree.)
2. **`INV-BLIND` conformance test** — engine test: during `drafting`, for every seat, `view(seat, head)` contains zero bytes derived from another seat's post-`item_posted` events; plus the Stage snapshot shows poses only. This test is the spec's most load-bearing guard; it should exist before the reactive round does.
3. **Replay determinism test** — fold the same ledger twice (including grant tie-breaks and reveal order, both seeded); byte-identical engine state.
4. **Bone-remap spike** — one VRM + one RocketBox + one MPFB model through the `mixamorig*` remap sharing one Mixamo clip set; confirms per-asset dictionaries and the `crossFadeTo` T-pose bug status on the pinned three.js version.
5. **Latency census** — one bid window against the real intended cast; confirm `W_bid=20s` covers the slowest provider's p90 or raise it before first real standup.
6. **Conformity census** — run in the same sitting as (5), since both need the real cast on a real item. Post one item with a knowably-correct answer where the majority of seats can be expected to start wrong, then compute per-seat fold rate (§14.5) from the resulting ledger. Output is a casting input, not a pass/fail: it ranks the cast for §14.2 and gives the first real reading on whether the reactive round improves or degrades positions. Needs no code beyond the §14.5 query.

## 16. Decisions register (including conflicts with the brief)

Decisions this spec made where its sources were silent or wrong; the running log with timestamps is `.prompts/room-spec-notes.md`.

- **Brief conflict — the lock does not block**: the brief and the tool's own description call `exclusive_acquire` a lock that "blocks until granted"; verified code is synchronous, advisory, FIFO, non-blocking (§1). Resolved by engine-mediated acquisition (§7.1) rather than either fixing the description in place or building a host-side blocking wait; the brief's "do not invent a second mechanism" is honored — the existing lock enforces, bids prioritize.
- **Arch-doc internal conflict — `stage_frames`**: the doc both declares the ledger the only durable truth and lists a persisted derived-frames table. Resolved for the principle: frames are ephemeral (§3.1, §12.3).
- **Reference drift**: rpc-types line numbers (:666/:676 not :650/:660); `AgentToolResult` lives in `pi-agent-core`; agent-cap defaults live in `registry.ts:14-15`. Recorded in §1; nothing structural.
- **Silences filled by decision** (arch doc named the concept, no value): K=S over the item's whole say history (§7.4), D=0.35, R=ceil(1.5·S), `W_bid`=20 s, `T_say`=120 s, `LULL_LIMIT`=2, intensity ∈ [0,1] with anchors, tie-breaks (§7.5), floor-death handling (§7.6), decision mechanics with ledger-recorded ballot menus (§9.3, §5.2), trigger/novelty enforcement structural-only in v1 (§7.4, risk named), `PASS` exempt from K (§7.4), required-drafts-with-deadline plus the non-drafter floor bar (§4.1, §7.8), sealed-events model (§5.3), one-room cap (§3.2), no mid-room recasting (§10.2), Stage tick 200 ms / buffer 2 ticks / SSE + snapshot (§12), localhost-only Stage (§12.1), desk assignment = cast order (`desk_index` at `room_cast`).
- **Same class as `stage_frames`, caught in review**: `floor_bids`/`floor_grants` are operational telemetry, not truth — the winning bid rides inside the `floor_grant` ledger event so floor history replays from the ledger alone (§3.1, §5.2, §10.4).
- **Substrate changes this feature requires** (named, not assumed): the `room:*` reserved-pattern guard inside the existing `exclusive_acquire` branch (§7.1, §13) — and nothing else. The `onToolActivity` hook was the other one; it died with the work phase (§11.3), leaving `src/agent.ts` untouched. The registry cannot distinguish deliberate stop from crash (`AgentState` has no "stopped"; the flag is private), so `seat_left.reason` is `"dead" | "removed"` (§5.2, §7.6).
- **Critique-wave closures (2026-08-05)**: seat-name identity-leak rejection at `room_cast` (§10.2); ballot menus normalized against majority signal and recorded in `phase{to:deciding}` (§9.3); the non-drafter bar and `S_effective` quorum (§7.8); `item_type` semantics at `room_post_item` (§10.2); zone/pose closed unions (§12.2); `Phase`/`BallotOption`/`RenderedEvent`/`DecisionDetail` defined (§5.2); recovery-order join rule (§10.4). Accepted/rejected register per finding: `.prompts/room-spec-notes.md`.
- **Research-wave revisions (2026-08-05, post-`/direction-memo`)**: three changes driven by evidence that postdates the original §2 corpus. All four original §2 citations were re-verified against their abstracts and hold as stated; these are additions, not corrections.
  - **Work phase cut** (§11, §4.1). `working`, work-phase bid windows, `tool_activity`, `INV-AUDIBLE`, `R_work`, `W_work`, `REENTRY_LIMIT`, `REOPEN_LIMIT`, and the `onToolActivity` substrate hook are all removed. Driver: Cognition's dispersed-context result describes the work phase's exact configuration, and §17.1's own wave protocol already demonstrates the correct execution pattern. This is the largest deletion in the spec's history and the only one that shrinks a wave (W0-SUBSTRATE). §11's *number* is retained, now documenting the cut, so §12–§17 references stay valid.
  - **Consensus by default** (§10.2, §9.3). `item_type` defaults to `knowledge`; `reasoning`/vote becomes the deliberate opt-in. Driver: `arXiv:2606.29270` — correlated LLM errors void majority voting's independence assumption, minority-correct in ~1 of 4 divergent cases. Explicitly *not* adopted: the paper's Minority Sentinel classifier, and any LLM-as-Judge overturn step (the same paper scores that at negative net gain, agreeing with §7.4's existing reasoning).
  - **Fold rate replaces capability tier as the casting axis** (§14.2, §14.5, §15.6). Driver: `arXiv:2608.02758` — conformity is model-dependent and uncorrelated with capability, and survives prompt-framing ablation, so persona text is a weak lever. The metric is derived from `draft` vs `ballot` divergence in the existing ledger; no new mechanism was added to obtain it.
- **Known substrate bug left alone**: `task_update`'s `"completed"` vs `TaskEntry`'s `"done"` (§1) — pre-existing, out of scope, noted so no one "fixes" it into the Room's enums.

## 17. Implementation plan (wave-structured, deleg8-orchestrated)

The build runs as sequential waves of parallel tasks, orchestrated through deleg8 itself (`mcp__deleg8__spawn`/`send`/`tasks`). Tasks inside a wave are independent by file ownership; waves are dependency edges. This spec is the single authority — an implementer that finds the spec wrong reports the conflict via `msg` and stops on that point rather than silently deviating.

### 17.1 Orchestration protocol

- **One implementer agent per task**, spawned in a single batch per wave. Never two agents in one wave touching the same file — ownership is listed per task and is exclusive.
- **File-based delegation**: each spawn prompt names the task ID, its owned files, its spec sections, and its acceptance command — never inlined requirements. The spec sections *are* the instruction file.
- **Progress discipline**: on start, the agent calls `task_create {label: "<task-id>"}`; on milestones and completion, `task_update`; on any blocker or spec conflict, `msg` — then waits rather than improvising around it.
- **Completion contract**: the agent's final message is a ≤5-sentence summary plus `Verified: <command> -> <result line>` for its acceptance check. No unrun code ships as "done".
- **Shared-file safety**: `src/server.ts` and `src/agent.ts` are owned by exactly one task (W0-SUBSTRATE, then W3-ENGINE for the registration seams). If a later task must touch them anyway, it takes `exclusive_acquire {pattern: "file:src/server.ts"}` first and releases after.
- **Wave gate**: a wave closes only when every agent's `agent_end` has arrived, every acceptance command has been re-run by the orchestrator, and one cross-review pass has run — `send` each implementer one peer's diff for a findings-only review. Then and only then the next wave spawns.
- **Model choice**: implementer waves run on the default subagent model; W3-ENGINE (the consistency-critical composition) warrants the strongest available model.

### 17.2 Wave plan

Dependency spine: `W0 ∥ → W1 → W2 ∥ → W3 → W4 ∥ → W5`.

**Wave 0 — de-risk (parallel; disposable code, nothing under `src/room/`)**

| Task | Owns | Spec | Acceptance |
|------|------|------|------------|
| `W0-TRANSPORT` | `spikes/transport/` | §12.3–12.4, §15.1 | synthetic 5 Hz SSE frames drive a 3-cube page through the interpolation buffer; kill/restore the server mid-run → client walks `live → degraded → resync → live` |
| `W0-BONES` | `spikes/bones/` | §12.5, §15.4 | one VRM + one RocketBox + one MPFB model share one Mixamo clip set via `mixamorig*` remaps; `crossFadeTo` T-pose status recorded against the pinned three.js version |
| `W0-SUBSTRATE` | `src/server.ts` | §7.1, §13 | `exclusive_acquire {pattern: "room:x"}` from an agent returns `reserved_pattern` |

**Wave 1 — schema and truth (single agent; everything downstream imports it)**

| Task | Owns | Spec | Acceptance |
|------|------|------|------------|
| `W1-LEDGER` | `src/room/types.ts`, `src/room/ledger.ts`, `rooms.db` DDL | §3.1, §5 entire, §15.3 | replay-determinism test: fold the same ledger twice (seeded tie-breaks and reveal order included) → byte-identical engine state |

**Wave 2 — pure modules over the ledger (parallel; import W1 only, per §13's "must not know" lists)**

| Task | Owns | Spec | Acceptance |
|------|------|------|------------|
| `W2-VISIBILITY` | `src/room/visibility.ts` | §5.3, §6 | §15.2 `INV-BLIND` conformance test: during `drafting`, every seat's `view` contains zero bytes derived from another seat's post-`item_posted` events |
| `W2-FLOOR` | `src/room/floor.ts` | §7 entire | unit tests: Gate-1 rejection, Gate-2 decay with K over item lifetime, tie-break determinism, non-drafter `no_draft` (§7.8) |
| `W2-PHASES` | `src/room/phases.ts` | §4 entire | table-driven transition tests incl. the `<2 drafts → escalated` path and rejection of every transition out of `closed` |
| `W2-PROMPTS` | `src/room/prompts.ts` | §9 entire | snapshot tests: every engine-authored prompt renders; no prompt contains `provider`/`model_id` (`INV-MASK`) |
| `W2-CAST` | `src/room/cast.ts` | §10.2 cast rules, §14.2 | `identity_leak` rejection on the arch doc's own example names; composition warnings emitted, not enforced |
| `W2-PROJECTOR` | `stage/projector.ts` | §12.2 | ledger fixture → zone/pose frame sequence matches the §12.2 table; closed unions enforced |

**Wave 3 — composition (single agent; the seam where cross-module consistency lives)**

| Task | Owns | Spec | Acceptance |
|------|------|------|------------|
| `W3-ENGINE` | `src/room/engine.ts`, `src/room/host-tools.ts`, registration edits in `src/server.ts` | §8, §10 | scripted end-to-end standup with fake seats driven through the real host-tool branches: idle→draft→reveal→reactive→decide→close, then §15.3 replay passes on the produced ledger; crash-restart mid-window recovers per §10.4 |

**Wave 4 — the Stage (parallel; read-only over `rooms.db`)**

| Task | Owns | Spec | Acceptance |
|------|------|------|------------|
| `W4-STAGE-SERVER` | `stage/server.ts` | §12.1, §12.3 | snapshot + SSE + `Last-Event-ID` replay + `resync` on gap; `LEDGER_VERSION` mismatch refuses to serve |
| `W4-WEB` | `stage/web/`, `stage/assets/` | §12.4–12.5 + W0 spike findings | cold load into a mid-item room renders correctly; reconnect mid-item resyncs without duplicate transcript rows |

**Wave 5 — live validation (orchestrator-led, not delegated)**

| Task | Owns | Spec | Acceptance |
|------|------|------|------------|
| `W5-STANDUP` | tuning constants only | §14.3–14.4, §15.5 | latency census confirms `W_bid` ≥ slowest provider p90; one real standup on cheap models; transcript checked against every §14.4 failure signature before any constant is touched |

### 17.3 Spawn prompt template

```
You are implementer <task-id> for the Room build in /Users/emmahyde/projects/deleg8.
Authority: docs/room-spec.md — read §<sections> in full before writing anything.
You own ONLY: <files>. Do not create or edit any other file.
Call task_create {label: "<task-id>"} now; task_update on milestones; msg immediately
on any blocker or spec conflict, then stop on that point.
Acceptance: <command>. Your final message: ≤5 sentences + "Verified: <command> -> <result>".
```
