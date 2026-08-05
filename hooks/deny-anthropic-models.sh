#!/usr/bin/env bash
# PreToolUse guard for canonical and legacy deleg8 MCP spawn names.
# deleg8 is pinned to non-Anthropic models (operator rule). Deny any call
# whose model/provider argument looks Anthropic: matches /anthropic/i
# anywhere, or starts with "claude". Only those two fields are checked —
# prompt text mentioning "anthropic" must never trip the guard.
set -euo pipefail

input="$(cat)"

match="$(printf '%s' "$input" | jq -r '(.tool_input // {}) | [.model // "", .provider // ""] | .[]' 2>/dev/null \
  | grep -iE '(anthropic|^claude)' || true)"

if [ -n "$match" ]; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"deleg8 is pinned to non-Anthropic models; use the native Agent tool for Claude models"}}'
fi

exit 0
