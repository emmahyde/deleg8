// Reduces omp's NDJSON stream to load-bearing frames: completed messages,
// failed responses, and active (user-facing) UI requests. Drops the per-token
// streaming chatter (message_update, thinking_delta) and lifecycle noise
// (ready, agent_start, turn_start, etc.) that dominates the raw buffer.

import type { BufferedFrame } from "./agent.ts";
import type { Frame } from "./frames.ts";

export interface SummaryEntry {
  seq: number;
  ts: number;
  kind: "message" | "error" | "ui_request" | "host_request" | "tool_call";
  data: Record<string, unknown>;
}

const ACTIVE_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** Extract concatenated text from an array of content blocks (MCP message format). */
export function extractTextContent(content: unknown[]): string {
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text as string)
    .join("");
}

function extractMessage(frame: Frame): Record<string, unknown> | null {
  const msg = frame.message;
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const content = Array.isArray(m.content) ? m.content : [];

  const text = extractTextContent(content);

  const blocks = content.map((b: any) => {
    if (b?.type === "text") return { type: "text", text: b.text };
    if (b?.type === "thinking") return { type: "thinking", text: b.thinking };
    if (b?.type === "tool_use") return { type: "tool_use", name: b.name, input: b.input, id: b.id };
    if (b?.type === "tool_result") return { type: "tool_result", tool_use_id: b.tool_use_id, content: b.content, isError: b.isError };
    return { type: b?.type ?? "unknown" };
  });

  const out: Record<string, unknown> = { role, text };
  // Surface structured blocks only when the message isn't pure text — keeps the
  // common case (assistant says one paragraph) compact.
  if (blocks.length !== 1 || blocks[0]?.type !== "text") out.blocks = blocks;
  if (m.model) out.model = m.model;
  if (m.usage) out.usage = m.usage;
  if (m.stopReason) out.stopReason = m.stopReason;
  return out;
}

// Tool names that, when called by omp, mean a file got written/edited/created.
// Permissive on purpose — omp can be swapped for different harnesses, and the
// cost of a false positive (an extra path in the list) is low compared to
// missing a real edit.
const FILE_MODIFYING_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "create_file",
  "write_file",
  "edit_file",
  "patch_file",
  "delete_file",
  "move_file",
  "rename_file",
]);

const PATH_FIELDS = ["path", "file_path", "filename", "target_file", "target"];

// Real omp NDJSON never emits "tool_use" content blocks (that's the Anthropic
// Messages format the FILE_MODIFYING_TOOLS/PATH_FIELDS pair above was written
// against). omp emits lowercase `tool_execution_start` frames with a `toolName`
// and an `args` object instead. "write" carries a clean args.path; "edit" has
// no path field at all — the path lives in a patch-header line embedded in
// args.input, e.g. `[docs/STATE.md#1D48]` (possibly several, one per edited
// section) — strip the `#...` suffix and pull every header in the string.
const FILE_MODIFYING_TOOL_NAMES = new Set(["write", "edit", "multiedit"]);
const PATCH_HEADER_RE = /^\[([^\]#]+)/gm;

function extractPatchHeaderPaths(input: string): string[] {
  const paths: string[] = [];
  for (const m of input.matchAll(PATCH_HEADER_RE)) {
    const p = m[1]?.trim();
    if (p) paths.push(p);
  }
  return paths;
}

/** Path(s) touched by a lowercase omp tool call's args, or [] if none found. */
function extractToolCallPaths(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  for (const k of PATH_FIELDS) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return [v];
  }
  if (typeof args.input === "string") return extractPatchHeaderPaths(args.input);
  return [];
}

function extractModifiedPaths(entries: SummaryEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "tool_call") {
      const path = (entry.data as { path?: unknown }).path;
      if (typeof path === "string" && path.length > 0) seen.add(path);
      continue;
    }
    if (entry.kind !== "message") continue;
    const blocks = Array.isArray(entry.data.blocks) ? (entry.data.blocks as any[]) : [];
    for (const b of blocks) {
      if (b?.type !== "tool_use") continue;
      if (typeof b.name !== "string" || !FILE_MODIFYING_TOOLS.has(b.name)) continue;
      const input = b.input as Record<string, unknown> | undefined;
      if (!input) continue;
      for (const k of PATH_FIELDS) {
        const v = input[k];
        if (typeof v === "string" && v.length > 0) {
          seen.add(v);
          break;
        }
      }
    }
  }
  return Array.from(seen);
}

export interface Digest {
  messages: SummaryEntry[];
  modified_files: string[];
  total_assistant_messages: number;
  total_entries: number;
}

export function digest(buffered: BufferedFrame[], opts: { lastMessages?: number } = {}): Digest {
  const lastN = opts.lastMessages ?? 5;
  const entries = summarize(buffered);
  const assistantMessages = entries.filter(
    (e) => e.kind === "message" && (e.data as { role?: string }).role === "assistant",
  );
  // Tool-heavy turns produce assistant messages with no extracted text (pure
  // tool_use blocks) — skip them from the recent-messages window so callers
  // don't have to filter empty entries themselves.
  const nonEmptyAssistantMessages = assistantMessages.filter(
    (e) => ((e.data as { text?: string }).text ?? "").trim().length > 0,
  );
  return {
    messages: nonEmptyAssistantMessages.slice(-lastN),
    modified_files: extractModifiedPaths(entries),
    total_assistant_messages: assistantMessages.length,
    total_entries: entries.length,
  };
}

export function summarize(buffered: BufferedFrame[]): SummaryEntry[] {
  const out: SummaryEntry[] = [];
  for (const { seq, ts, frame } of buffered) {
    switch (frame.type) {
      case "message_end": {
        const data = extractMessage(frame);
        if (data) out.push({ seq, ts, kind: "message", data });
        break;
      }
      case "response": {
        // Successful prompt acks carry no information beyond receipt — drop them.
        if (frame.success === false) {
          out.push({ seq, ts, kind: "error", data: { ...(frame as Record<string, unknown>) } });
        }
        break;
      }
      case "extension_ui_request": {
        const method = typeof frame.method === "string" ? frame.method : "";
        if (ACTIVE_UI_METHODS.has(method)) {
          out.push({
            seq,
            ts,
            kind: "ui_request",
            data: {
              id: frame.id,
              method,
              title: frame.title,
              message: frame.message,
              options: frame.options,
            },
          });
        }
        break;
      }
      case "host_tool_call":
      case "host_uri_request":
        out.push({ seq, ts, kind: "host_request", data: { ...(frame as Record<string, unknown>) } });
        break;
      case "tool_execution_start": {
        const toolName = typeof frame.toolName === "string" ? frame.toolName.toLowerCase() : "";
        if (!FILE_MODIFYING_TOOL_NAMES.has(toolName)) break;
        const args = frame.args as Record<string, unknown> | undefined;
        const paths = extractToolCallPaths(args);
        if (paths.length === 0) {
          out.push({ seq, ts, kind: "tool_call", data: { toolName } });
        } else {
          // One entry per path so a multi-section edit (several patch headers
          // in one args.input) surfaces every file it touched.
          for (const path of paths) out.push({ seq, ts, kind: "tool_call", data: { toolName, path } });
        }
        break;
      }
      // Dropped: ready, agent_start, agent_end, turn_start, turn_end, message_start,
      // message_update, thinking_delta, and passive extension_ui_request methods
      // (notify/setStatus/setWidget/setTitle/open_url/cancel/set_editor_text).
    }
  }
  return out;
}
