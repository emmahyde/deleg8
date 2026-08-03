# Phase 2: Security & Performance

Produced: 2026-07-25 inline review.
Builds on Phase 1 findings (A2, Q3, Q5, A4, A7).

---

## Security Findings

### Critical — None

No authentication, data-at-rest encryption, or authorization vulnerabilities apply: this is a stdio MCP server invoked by a trusted Claude Code session. The threat model assumes the caller is benevolent.

### High

**S1. jq filter expression is unsandboxed user input to a subprocess (jq-filter.ts:10)**

The `jq` parameter on `output`, `list`, `status`, and `tasks` tools passes user-controlled strings directly to `Bun.spawn(["jq", "-c", expr])`. While Bun.spawn doesn't use a shell (preventing shell injection), `jq -c` evaluates the expression as jq code, and jq's expression language includes file-read primitives:

```bash
# A malicious jq expression could read files:
jq -c 'include "/etc/passwd"'
jq -c '$ARGS.positional[0]' --argfile secrets /etc/passwd  # --argfile read via argv contamination
```

The second form (`--argfile`) works because jq treats `--argfile` as an option even after a positional filter expression when invoked as `jq -c <expr> --argfile <path> <var>`. A crafted expression like `x` followed by `--argfile /etc/passwd data` in the same string would be parsed as two arguments by the shell-split, but since `Bun.spawn` receives a clean array `["jq", "-c", expr]`, the entire string is one argv element and jq interprets it as a filter expression that happens to contain option-like text — which jq rejects. So this specific vector is guarded by the array-based spawn.

However: `jq -c '<expr>'` evaluates `expr` as arbitrary jq code. The expr could reference files via `include`, or if jq supports `$ENV`, read environment variables. This is still constrained by Bun's spawn model but represents an unnecessary risk — the orchestrator shouldn't be able to make the server read arbitrary files through a projection tool.

*Impact:* Low in practice (Bun's array spawn prevents option injection; jq include is limited to library paths). But it's a design smell: a data-filtering tool should not shell out to a general-purpose binary.

*Fix:* Replace with an in-process JSON query library (JMESPath, JSONPath) that has no file-system access.

**S2. Synchronous file writes to unencrypted NDJSON logs (agent.ts:514-517)**

Every frame received is written to a plaintext NDJSON log file, including the full content of prompts, responses, tool calls, and file paths. The log file contains the complete conversation history and all file modifications made by the subagent. No encryption, no access controls, no user-facing notice about log contents.

The `full_output_path` is exposed through `output` and `status` responses. Any tool that can call `output(agent_id="foo")` gets the path to the raw conversation log.

*Impact:* If the log directory is in a shared location (default: per-agent dir under `logDir`), other processes could read the full conversation history. The README doesn't mention log contents or privacy.

*Fix:* Add a README note about log verbosity. Optionally support a `noLog` / `noPersist` spawn option. The log is already the debug substrate — just document it.

### Medium

**S3. Frame data is written to log before validation (agent.ts:491-493 → 514-517)**

In `readLoop()`, each line is decoded via `decode(line)` and then `onFrame(frame)` is called synchronously. If decode accepts a malformed frame (extreme edge case — `JSON.parse` would fail first), the frame is still logged and buffered.

Not exploitable in practice because `decode()` at `frames.ts:9-18` requires valid JSON and an object type — but the sequence is decode-first, process-second, with no validation layer between I/O and internal state.

*Impact:* Negligible. Only exploitable via the stdio pipe, which is trusted.

**S4. Spawn `extra_args` and `cwd` bubble through to Bun.spawn (server.ts:225, agent.ts:248-254)**

The `spawn` tool accepts `extra_args` (string array) and `cwd`. These are forwarded to `Bun.spawn(args, { cwd })` without validation or allowlist. A malicious orchestrator could:
- Set `cwd` to a sensitive directory
- Pass `extra_args` that conflict with omp's operation (e.g., `--session-dir` override)
- Exfiltrate data by crafting `extra_args` that make omp write output to controlled locations

*Impact:* Confined to the trust boundary — the orchestrator already has access to the file system. But if deleg8 is exposed through an MCP gateway with a broader security boundary, these become real vectors.

*Fix:* Validate `cwd` against an allowed-directory list (or default to cwd/repo-root). Reject `extra_args` that shadow internal flags.

**S5. PreToolUse bash guard has a silent-fail path (hooks/hooks.json:14-18, deny-anthropic-models.sh)**

The bash hook at `hooks/deny-anthropic-models.sh` exits 0 on both allow and deny paths. The deny path writes `permissionDecision: "deny"` to stdout; the allow path writes nothing. If the jq parsing fails (e.g., malformed `tool_input`), stdout is empty and the hook effectively allows everything. No mechanism alerts the operator that the guard silently failed.

*Fix:* Add an explicit allow-print to the allowed path so a broken jq call is distinguishable from "everything is fine." Or validate the input schema before grep.

### Low

- Two npm dependencies (`zod ^3.23.8`, `@modelcontextprotocol/sdk ^1.18.0`) — well-maintained, small surface area.
- No dependency vulnerability scanning in CI (no `npm audit`, `snyk`, or Dependabot config in the repo).
- No secrets in source code (no hardcoded keys, tokens, or passwords).
- The `modifiedFiles` set tracks file paths from tool_execution_start frames — could expose internal repo paths to anyone with access to the output/digest.

---

## Performance Findings

### High

**P1. jq subprocess per filter operation (jq-filter.ts:7-39)**

Every `output`, `list`, `status`, and `tasks` call with a `jq` parameter spawns a new `jq` OS process. Process fork overhead on macOS is ~10-50ms per call even for trivial filters like `.agents | map({id})`.

*Impact:* Cumulative — a fan-out of 15 agents, each polled for output with jq projection, adds ~225-750ms in pure process-spawn overhead.

*Fix options:*
1. (Best) Replace with in-process JSONPath/JMESPath library for the common projection patterns this server uses.
2. (Cheaper) Maintain a single long-lived jq instance and pipe filters through it over stdin.
3. (Simplest) Cache the last N unique filters in a Map<string, (data) => unknown> to avoid re-spawning for repeated expressions.

**P2. Synchronous file I/O on every frame (agent.ts:517 `appendFileSync`)**

Every NDJSON frame from the child process triggers a synchronous `appendFileSync` to the debug log. This blocks the event loop for the duration of the write. At ~5-15 frames/second (a busy agent producing tool calls and streaming responses), this is ~5-15 synchronous disk writes per second.

Additionally, `rotateLogIfNeeded()` at agent.ts:84-97 checks file size on every frame by calling `statSync`. This means every frame incurs at least one `statSync` call.

*Impact:* Event-loop blocking on disk I/O. Under load, this delays frame processing (including response resolution for pending promises).

*Fix:* 
1. Use `appendFile` (async) or a write-on-interval batching approach.
2. Cache the file size in memory and only stat every N writes or every K bytes.
3. Only log every Nth frame when the agent is streaming many rapid frames (e.g., throttle to 10 logs/sec).

**P3. writeChain serialization limits throughput (agent.ts:460, 643)**

All writes to the omp child process serialize through `this.writeChain = this.writeChain.then(async () => { ... })`. A slow or blocked write stalls every subsequent dispatch — including `set_model`, `abort`, `prompt`, and `extension_ui_response` frames. This also affects `safeWrite` (agent.ts:639-653), which uses the same writeChain.

*Impact:* If one dispatch hangs (e.g., the child process stdin buffer is full), all communication with that agent stalls. This is particularly dangerous for `abort` frames — an abort that can't be written because the writeChain is blocked on a prior write is a stuck process.

*Fix:* Use a bounded write queue with timeout per entry. Abort frames should bypass the queue and write directly.

**P4. totalCostUsd scans the full ring buffer (server.ts:185-199)**

Called on every `list` and `status` call. Iterates up to 1024 frames each call. For a 20-agent fleet on `list`, that's ~20K iterations per call.

*Fix:* Maintain a running cost accumulator on PiAgent, updated on each `message_end` frame. This is O(1) per frame rather than O(buffer) per query.

**P5. collectClaudeMd reads 3 files synchronously at spawn time (server.ts:84-102)**

At every `spawn`, up to 3 files are checked with `existsSync` and read with `readFileSync`. If the global CLAUDE.md is 10KB+, this blocks the event loop for the duration of each read (typically negligible for Bun, but multiplies across concurrent spawns).

*Impact:* Amplified during a fan-out where 5-15 agents are spawned concurrently. Each spawn blocks on up to 3 synchronous reads before returning.

*Fix:* Cache file contents keyed by (path, mtime). Invalidate on change. Or read asynchronously before returning.

### Medium

**P6. Modified file set tracked twice (agent.ts:506-511 + server.ts:553)**

The `modifiedFiles` set in `agent.ts:178` is populated at frame-intake time in `onFrame()`, then unioned with the digest's extracted paths at `server.ts:553`. This is correct but redundant — the intake-time tracking already covers the full session (it survives buffer eviction), and the digest path could stand alone.

*Impact:* ~5 lines of code + a tiny CPU cost on every digest call. Minor.

**P7. No request deduplication for concurrent monitors**

If the orchestrator calls `output(agent_id="foo")` twice concurrently (e.g., two parallel tasks both polling), both calls will independently spin through the buffer, run the jq filter, and compress the result. No request coalescing.

*Impact:* At current scale (1-20 agents, infrequent polling), negligible. At high concurrency, the jq subprocess and buffer scan multiply.

**P8. Log file grows quadratically with conversation length**

The code comment at agent.ts:59-64 documents this: omp response frames embed the full accumulated conversation, so logging verbatim produces multi-GB files after long sessions. The per-line size cap (4KB) and log rotation (50MB) mitigate this, but even the rotated logs incur synchronous `statSync` + `renameSync` I/O during rotation.

*Impact:* On long-lived agents (10+ turns), each log rotation triggers a `renameSync` of a potentially large file. Two concurrent rotations (two agents hitting the cap simultaneously) block the event loop twice.

### Low

- PiAgent has no connection pooling or resource limiting — each agent spawns a full omp process. At 20 agents, that's 20 omp processes, each potentially loading a model. Resource limits are delegated to the OS.
- The ring buffer (BUFFER_CAP=1024) is constant-memory, which is good. Early frames from long sessions are silently evicted.
- No pre-allocation or object pooling for frame processing — each frame creates new objects through JSON.parse and type coercion. Acceptable at this scale.
- The `onChannelFrame` notification path (server.ts:268-281) fires fire-and-forget `catch(err => console.error)` — no retry, no backpressure. If the MCP client isn't listening, notifications silently drop.

---

## Recommendations Summary

| # | Severity | Area | Issue | Fix |
|---|---|---|---|---|
| S1 | High | Security | jq runs user-controlled expressions | Replace with in-process JSON query library |
| S2 | Medium | Security | Plaintext full-conversation logs with no notice | Document log contents; add noLog option |
| S3 | Low | Security | Frame processed before validation | Already minimal risk on trusted transport |
| S4 | Medium | Security | extra_args + cwd are unvalidated | Validate against allowlist |
| S5 | Low | Security | Bash hook silent-fail path | Add explicit allow output |
| P1 | High | Performance | jq subprocess per call | In-process JSON query |
| P2 | High | Performance | Sync file I/O on every frame | Async append + size cache |
| P3 | High | Performance | Serialized writeChain blocks all dispatches | Bounded queue with abort bypass |
| P4 | High | Performance | Full buffer scan per list/status | Running accumulator |
| P5 | High | Performance | Sync file reads at spawn time | Cache + async reads |
| P6 | Low | Performance | Redundant modified-file tracking | Can consolidate |
| P7 | Low | Performance | No request coalescing | Add at high user count |
| P8 | Medium | Performance | Log rotation blocks event loop | Async rotation |
