#!/usr/bin/env bun
// Mock `omp --mode rpc-ui` for agent.test.ts.
//
// Protocol mirrors the subset of omp's rpc-ui surface the wrapper uses:
//   ready (emitted on boot, no id)
//   prompt          -> response with data, then turn_end
//   set_model       -> silently acknowledged
//   abort           -> process.exit(0)
//   get_state       -> response with {sessionId, sessionFile}
//   extension_ui_response -> pairs back to the originating prompt
//
// Session support (mirrors omp's --session-dir / --resume):
//   --session-dir <path>   write session.jsonl in this dir (one line per turn)
//   --resume <sessionId>   read session.jsonl on boot to recover prior turns
//
// Special prompt prefixes used by tests:
//   "ASK:select:a,b,c"   emit a select UI request, then respond with {user_picked}
//   "ASK:confirm"        emit a confirm UI request, then respond with {user_confirmed}
//   "ASK:input"          emit an input UI request, then respond with {user_input}
//   "NOTIFY ..."         emit a passive notify frame, then respond with {echo}
//   "COUNT"              respond with {turn_count} reflecting persisted history
//   anything else        respond with {echo: message}

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Frame = Record<string, unknown>;

function write(frame: Frame): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, nl);
        buf = buf.slice(nl + 1);
      }
    }
    buf += decoder.decode();
    if (buf) yield buf;
  } finally {
    reader.releaseLock();
  }
}

// ── CLI / session setup ─────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}
const sessionDir = flag("--session-dir");
const resumeId = flag("--resume");
const sessionId = resumeId ?? `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const sessionFile = sessionDir ? join(sessionDir, `${sessionId}.jsonl`) : null;

let turnCount = 0;
if (sessionFile && resumeId && existsSync(sessionFile)) {
  // Replay just for counting — real omp does much more, but the test only
  // needs to observe that history is preserved across resume.
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (line.trim()) turnCount += 1;
  }
}
if (sessionDir) {
  try { mkdirSync(sessionDir, { recursive: true }); } catch { /* exists */ }
}

function persistTurn(entry: Frame): void {
  if (!sessionFile) return;
  try { appendFileSync(sessionFile, JSON.stringify(entry) + "\n"); } catch { /* best-effort */ }
}

// ── boot ────────────────────────────────────────────────────────────────
write({ type: "ready" });

const pendingUI = new Map<string, { promptId: string; key: string; userMessage: string }>();
let uiCounter = 0;

function startUi(promptId: string, method: string, key: string, userMessage: string, extra: Frame): string {
  const uiId = `ui-${++uiCounter}`;
  pendingUI.set(uiId, { promptId, key, userMessage });
  write({ type: "extension_ui_request", id: uiId, method, ...extra });
  return uiId;
}

function finishTurn(promptId: string, userMessage: string, data: Frame): void {
  turnCount += 1;
  persistTurn({ turn: turnCount, message: userMessage, data });
  write({ type: "response", id: promptId, command: "prompt", success: true, data });
  write({ type: "turn_end" });
}

for await (const line of readLines(Bun.stdin.stream())) {
  const s = line.trim();
  if (!s) continue;
  let frame: Frame;
  try {
    frame = JSON.parse(s) as Frame;
  } catch {
    continue;
  }

  const ftype = frame.type;
  const id = typeof frame.id === "string" ? frame.id : "";

  if (ftype === "get_state") {
    write({
      type: "response",
      id,
      command: "get_state",
      success: true,
      data: { sessionId, sessionFile },
    });
  } else if (ftype === "prompt") {
    const message = typeof frame.message === "string" ? frame.message : "";

    if (message.startsWith("ASK:select:")) {
      const options = message.slice("ASK:select:".length).split(",");
      startUi(id, "select", "user_picked", message, { title: "pick one", options });
    } else if (message.startsWith("ASK:confirm")) {
      startUi(id, "confirm", "user_confirmed", message, { title: "confirm?", message: "ok?" });
    } else if (message.startsWith("ASK:input")) {
      startUi(id, "input", "user_input", message, { title: "say something", placeholder: "your answer" });
    } else if (message.startsWith("NOTIFY")) {
      write({ type: "extension_ui_request", id: `ui-${++uiCounter}`, method: "notify", message: "fyi" });
      finishTurn(id, message, { echo: message });
    } else if (message === "COUNT") {
      finishTurn(id, message, { turn_count: turnCount + 1 });
    } else {
      finishTurn(id, message, { echo: message });
    }
  } else if (ftype === "extension_ui_response") {
    const uiId = id;
    const pending = pendingUI.get(uiId);
    if (!pending) continue;
    pendingUI.delete(uiId);
    let value: unknown;
    if (frame.cancelled) {
      value = { cancelled: true };
    } else if (pending.key === "user_confirmed") {
      value = Boolean(frame.confirmed);
    } else {
      value = typeof frame.value === "string" ? frame.value : "";
    }
    finishTurn(pending.promptId, pending.userMessage, { [pending.key]: value });
  } else if (ftype === "set_model") {
    // No-op acknowledgement — wrapper sends these fire-and-forget.
  } else if (ftype === "abort") {
    process.exit(0);
  }
}
