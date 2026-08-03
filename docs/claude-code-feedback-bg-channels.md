# Feedback: background jobs cannot receive experimental channel notifications

**Product**: Claude Code v2.1.220 · **Feature**: research-preview channels (`--dangerously-load-development-channels`)

## Summary

MCP servers declaring `capabilities.experimental["claude/channel"]` can push `notifications/claude/channel` frames, but sessions only surface them when launched with `--dangerously-load-development-channels server:<name>`. Background jobs can never satisfy this: they run in pre-spawned generic `bg-spare` processes whose argv is hardcoded and flag-free. The flag is parsed once at process startup; the claim protocol transfers environment only and never re-execs. There is no daemon config, per-job field in `BgDispatchSchema`, or spare-pool opt-out that could carry the flag.

## Why this hurts

Multi-agent orchestration is exactly the workload users push to background jobs, and channel notifications are the mechanism designed to surface subagent completion. The two features are mutually exclusive today.

Worse, the failure is silent at the wrong layer: the client **accepts** the notification and then discards it ("Channel notifications skipped: server X not in --channels list for this session"). The MCP server sees a successful send, so any server-side fallback keyed on delivery failure (e.g. an event queue) never triggers. Servers cannot even detect they're talking to a deaf session.

## Suggested fixes (either suffices)

1. **Re-exec spares with session flags on claim** — when a bg job claims a spare, re-exec with the launching session's channel flags (or re-parse them post-claim).
2. **Let flagged sessions bypass the spare pool** — if a session was launched with channel flags, spawn its bg jobs fresh with the same argv instead of claiming a generic spare.

A lesser but useful third option: reject (JSON-RPC error) instead of silently discarding channel notifications from non-allowlisted servers, so servers can fall back.

## Reproduction

1. `.mcp.json` stdio server declaring `capabilities.experimental["claude/channel"]`, emitting `notifications/claude/channel` on some event.
2. Launch Claude Code with `--dangerously-load-development-channels server:<name>` — notifications surface in-session. ✓
3. From that session, start a background job that triggers the same server event — nothing surfaces; client logs show the "skipped: not in --channels list" line. ✗

Verified against the v2.1.220 binary: `Bun.spawn([bin, "--bg-pty-host", ...])` spare argv, claim-protocol env-only transfer.
