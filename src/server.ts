#!/usr/bin/env bun
// deleg8 — exposes oh-my-pi (`omp --mode rpc`) as a fleet of named,
// long-lived subagents addressable from Claude Code.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { PiAgentError } from "./agent.ts";
import { jqFilter } from "./jq-filter.ts";
import { AgentRegistry } from "./registry.ts";
import { FRAME_SCHEMA } from "./schema.ts";
import { digest, summarize } from "./summarize.ts";
import { makeElicitBridge } from "./ui-bridge.ts";

export interface PiAgentServerOptions {
  /** Pre-built registry. If omitted, one is created from env defaults. */
  registry?: AgentRegistry;
  /** Override the default omp binary path. Ignored if `registry` is set. */
  binary?: string;
  /** Override the log directory. Ignored if `registry` is set. */
  logDir?: string;
}

export interface PiAgentServerHandle {
  server: McpServer;
  registry: AgentRegistry;
}

export function createPiAgentServer(opts: PiAgentServerOptions = {}): PiAgentServerHandle {
  const server = new McpServer({ name: "deleg8", version: "0.1.0" });
  // Per-Claude-Code-session log directory. CLAUDE_SESSION_ID is preferred so
  // logs from the same session land together; otherwise a short generated id.
  const sessionId = process.env.CLAUDE_SESSION_ID ?? randomUUID().slice(0, 8);
  const defaultLogDir = join(homedir(), ".claude", "deleg8", sessionId);
  const registry =
    opts.registry ??
    new AgentRegistry({
      binary: opts.binary ?? process.env.OMP_BIN ?? "omp",
      onUIRequest: makeElicitBridge(server),
      logDir: opts.logDir ?? defaultLogDir,
    });
  registerTools(server, registry);
  return { server, registry };
}

function registerTools(server: McpServer, registry: AgentRegistry): void {

// ── helpers ─────────────────────────────────────────────────────────────

function collectClaudeMd(cwd?: string): string {
  const paths = [join(homedir(), ".claude", "CLAUDE.md")];
  if (cwd) {
    paths.push(join(cwd, "CLAUDE.md"));
    paths.push(join(cwd, ".claude", "CLAUDE.md"));
  }
  const blocks: string[] = [];
  for (const p of paths) {
    try {
      if (existsSync(p)) {
        const content = readFileSync(p, "utf8").trim();
        if (content) blocks.push(`<claude-md source="${p}">\n${content}\n</claude-md>`);
      }
    } catch { /* skip unreadable */ }
  }
  return blocks.length > 0
    ? blocks.join("\n\n") + "\n\n---\n\n"
    : "";
}

function buildMonitorCmd(agentId: string, logPath: string): string {
  // Generates a bash command for Claude Code's Monitor tool. It:
  //   1. tail -f the NDJSON log
  //   2. waits for an agent_end frame
  //   3. extracts the last assistant message_end text from the full log
  //   4. prints a one-line summary and exits
  // Each stdout line becomes a Monitor notification.
  const lp = logPath.replace(/'/g, "'\\''");
  // tail -f the log; on agent_end, read the file backwards to find the last
  // assistant message_end, extract text blocks via jq, print, and exit.
  // tac + grep -m1 avoids racing with tail's open file handle.
  return [
    `tail -n +1 -f '${lp}'`,
    `| while IFS= read -r line; do`,
    `  if printf '%s' "$line" | grep -q '"type":"agent_end"'; then`,
    `    last_text=$(tail -r '${lp}'`,
    `      | grep -m1 '"role":"assistant".*"type":"message_end"\\|"type":"message_end".*"role":"assistant"'`,
    `      | jq -r '[.message.content[]? | select(.type=="text") | .text] | join("")' 2>/dev/null);`,
    `    echo "[deleg8 ${agentId}] done: $last_text";`,
    `    exit 0;`,
    `  fi;`,
    `done`,
  ].join(" ");
}

const MAX_RESULT_BYTES = 32 * 1024;

function ok(value: unknown, text?: string) {
  const json = text ?? JSON.stringify(value, null, 2);
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  return {
    content: [{ type: "text" as const, text: json }],
    structuredContent: isObject ? (value as Record<string, unknown>) : { result: value },
  };
}

function fail(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `error: ${message}` }],
  };
}

async function guard<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof fail>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PiAgentError) return fail(e.message);
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`unexpected: ${msg}`);
  }
}

// Project tool results through an optional jq filter, then enforce a size cap
// so a too-broad filter (or no filter at all on a huge raw buffer) can't flood
// the calling agent's context. On overflow, returns an envelope with a hint.
async function project(value: unknown, jq: string | undefined): Promise<unknown> {
  const filtered = jq ? await jqFilter(value, jq) : value;
  const size = JSON.stringify(filtered).length;
  if (size <= MAX_RESULT_BYTES) return filtered;
  return {
    truncated: true,
    bytes: size,
    cap: MAX_RESULT_BYTES,
    hint:
      "Result exceeds the size cap. Pass (or tighten) a `jq` filter to project " +
      "only the fields you need. See resource `deleg8://schema/frames` for the catalog.",
  };
}

// ── pi_spawn ────────────────────────────────────────────────────────────

server.registerTool(
  "pi_spawn",
  {
    title: "Spawn pi subagent",
    description:
      "Launch a new `omp --mode rpc` subprocess and register it under `agent_id`. " +
      "Mirrors the native Agent tool: optionally send `initial_prompt` and wait for the response. " +
      "Set `background: true` to return the agent_id immediately and stream output via pi_output later.",
    inputSchema: {
      agent_id: z
        .string()
        .regex(/^[a-zA-Z0-9_.\-]{1,64}$/)
        .optional()
        .describe("Stable identifier for the agent. Auto-generated if omitted (e.g. 'pi-001')."),
      initial_prompt: z.string().optional().describe("First prompt to send after spawn."),
      model: z
        .object({
          provider: z.string().describe("e.g. 'anthropic', 'openai'"),
          modelId: z.string().describe("e.g. 'sonnet-4.5', 'gpt-5'"),
        })
        .optional()
        .describe("Optional `set_model` frame sent before initial_prompt."),
      extra_args: z.array(z.string()).optional().describe("Extra CLI args appended to the omp spawn command."),
      cwd: z.string().optional().describe("Working directory for the omp subprocess."),
      rpc_mode: z
        .enum(["rpc", "rpc-ui"])
        .default("rpc-ui")
        .describe(
          "rpc-ui (default) routes omp's ask/select/confirm/input/editor dialogs to MCP elicitation, " +
            "so the agent can ask the user clarifying questions mid-turn. Use 'rpc' to disable.",
        ),
      background: z
        .boolean()
        .default(false)
        .describe("If true, return immediately without waiting for initial_prompt's response."),
      timeout_ms: z.number().int().positive().default(300_000).describe("Wait timeout for initial_prompt."),
    },
    annotations: {
      title: "Spawn pi subagent",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args) =>
    guard(async () => {
      const agent = await registry.spawn({
        agentId: args.agent_id,
        extraArgs: args.extra_args,
        cwd: args.cwd,
        rpcMode: args.rpc_mode,
      });
      if (args.model) await agent.setModel(args.model.provider, args.model.modelId);
      const claudeMdPrefix = collectClaudeMd(args.cwd);
      let response: unknown = null;
      if (args.initial_prompt) {
        const prompt = claudeMdPrefix + args.initial_prompt;
        if (args.background) {
          await agent.sendPrompt(prompt, { wait: false });
        } else {
          response = await agent.sendPrompt(prompt, {
            wait: true,
            timeoutMs: args.timeout_ms,
          });
        }
      }
      const result: Record<string, unknown> = {
        agent_id: agent.agentId,
        status: agent.status(),
        response,
      };
      if (args.background && agent.getLogPath()) {
        result.monitor_cmd = buildMonitorCmd(agent.agentId, agent.getLogPath()!);
      }
      return ok(result);
    }),
);

// ── pi_send ─────────────────────────────────────────────────────────────

server.registerTool(
  "pi_send",
  {
    title: "Send message to existing pi agent",
    description:
      "Equivalent of SendMessage({to: agent_id, prompt: message}). If the agent is idle " +
      "(auto-suspended at last turn_end), pi_send transparently respawns omp with " +
      "--resume <session_id> so conversation context is preserved across pauses. " +
      "Targets the existing agent_id — does NOT create a new agent.",
    inputSchema: {
      agent_id: z.string().describe("Target agent_id (from pi_spawn or pi_list)."),
      message: z.string().min(1).describe("Prompt to send."),
      background: z
        .boolean()
        .default(false)
        .describe("If true, return immediately without waiting for the response frame."),
      timeout_ms: z.number().int().positive().default(300_000),
    },
    annotations: {
      title: "Send to pi subagent",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (args) =>
    guard(async () => {
      const agent = registry.get(args.agent_id);
      if (args.background) {
        await agent.sendPrompt(args.message, { wait: false });
        const result: Record<string, unknown> = {
          agent_id: args.agent_id,
          dispatched: true,
          status: agent.status(),
        };
        if (agent.getLogPath()) {
          result.monitor_cmd = buildMonitorCmd(args.agent_id, agent.getLogPath()!);
        }
        return ok(result);
      }
      const response = await agent.sendPrompt(args.message, {
        wait: true,
        timeoutMs: args.timeout_ms,
      });
      return ok({ agent_id: args.agent_id, response, status: agent.status() });
    }),
);

// ── pi_list ─────────────────────────────────────────────────────────────

server.registerTool(
  "pi_list",
  {
    title: "List pi subagents",
    description:
      "Snapshot of every registered pi agent. Each entry has `state` (running | idle | dead) " +
      "and `session_id`. `idle` means the subprocess has exited at end-of-turn but the omp " +
      "session is on disk and resumable via pi_send. `dead` means the agent crashed or was " +
      "stopped — registry entry persists for inspection until pi_prune. Mirrors TaskList. " +
      "Pass `jq` to project (e.g. `.agents | map({id: .agent_id, state})`).",
    inputSchema: {
      jq: z.string().optional().describe("Optional jq -c filter applied to the structured result."),
    },
    annotations: {
      title: "List pi subagents",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) =>
    guard(async () => {
      const agents = registry.list().map((a) => a.status());
      const result = await project({ count: agents.length, agents }, args.jq);
      return ok(result);
    }),
);

// ── pi_status ───────────────────────────────────────────────────────────

server.registerTool(
  "pi_status",
  {
    title: "Get status of one pi subagent",
    description:
      "Detailed status for a single agent — `state` (running | idle | dead), `pid`, " +
      "`session_id`, `session_file`, `last_activity`, `message_count`, `log_path`. " +
      "Mirrors TaskGet. Pass `jq` to project (e.g. `.status | {state, session_id, log_path}`).",
    inputSchema: {
      agent_id: z.string(),
      jq: z.string().optional().describe("Optional jq -c filter applied to the structured result."),
    },
    annotations: {
      title: "Pi subagent status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) =>
    guard(async () => {
      const agent = registry.get(args.agent_id);
      const result = await project({ agent_id: args.agent_id, status: agent.status() }, args.jq);
      return ok(result);
    }),
);

// ── pi_output ───────────────────────────────────────────────────────────

server.registerTool(
  "pi_output",
  {
    title: "Read buffered frames from a pi subagent",
    description:
      "Return what an omp subagent has produced. Mirrors TaskOutput.\n" +
      "Default `format: \"digest\"` returns: the last N assistant messages " +
      "(N=`last_messages`, default 5), a deduped list of files the agent modified, " +
      "and `full_output_path` pointing at the on-disk NDJSON log for the full record.\n" +
      "`format: \"summary\"` returns every collapsed entry (message/error/ui_request/host_request). " +
      "`format: \"raw\"` returns every NDJSON frame omp emitted, unchanged.\n" +
      "Pass `jq` to project further. Common frame types: `message_end`, `response`, " +
      "`extension_ui_request`. Full catalog + worked jq examples at resource " +
      "`deleg8://schema/frames`.",
    inputSchema: {
      agent_id: z.string(),
      format: z
        .enum(["digest", "summary", "raw"])
        .default("digest")
        .describe("digest (default): last N msgs + modified files + log path. summary: all entries. raw: all frames."),
      last_messages: z
        .number()
        .int()
        .positive()
        .max(50)
        .default(5)
        .describe("Trailing assistant messages to include in digest mode."),
      since_seq: z
        .number()
        .int()
        .nonnegative()
        .default(0)
        .describe("Only consider frames with seq > this. Applies to summary/raw."),
      max_frames: z.number().int().positive().max(1000).default(200),
      jq: z.string().optional().describe("Optional jq -c filter applied to the structured result."),
    },
    annotations: {
      title: "Pi subagent output",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (args) =>
    guard(async () => {
      const agent = registry.get(args.agent_id);
      const raw = agent.output({ sinceSeq: args.since_seq, maxFrames: args.max_frames });
      const last_seq = raw.length > 0 ? raw[raw.length - 1]!.seq : args.since_seq;

      let payload: Record<string, unknown>;
      if (args.format === "digest") {
        const d = digest(agent.output({ maxFrames: 1000 }), { lastMessages: args.last_messages });
        payload = {
          agent_id: args.agent_id,
          format: "digest",
          full_output_path: agent.getLogPath(),
          modified_files: d.modified_files,
          messages: d.messages,
          total_assistant_messages: d.total_assistant_messages,
          total_entries: d.total_entries,
          last_seq,
        };
      } else if (args.format === "summary") {
        const entries = summarize(raw);
        payload = {
          agent_id: args.agent_id,
          format: "summary",
          full_output_path: agent.getLogPath(),
          count: entries.length,
          last_seq,
          entries,
        };
      } else {
        payload = {
          agent_id: args.agent_id,
          format: "raw",
          full_output_path: agent.getLogPath(),
          count: raw.length,
          last_seq,
          frames: raw,
        };
      }
      const result = await project(payload, args.jq);
      return ok(result);
    }),
);

// ── pi_stop ─────────────────────────────────────────────────────────────

server.registerTool(
  "pi_stop",
  {
    title: "Stop a pi subagent",
    description:
      "Send an `abort` frame, terminate the subprocess, AND drop the registry entry by default. " +
      "Use `remove: false` to keep the entry around (e.g. for log inspection). " +
      "Set `force: true` to SIGKILL immediately. Mirrors TaskStop. Note: this discards the omp " +
      "session — for end-of-turn auto-suspend (resumable), do nothing; the agent suspends itself.",
    inputSchema: {
      agent_id: z.string(),
      force: z.boolean().default(false),
      remove: z.boolean().default(true),
    },
    annotations: {
      title: "Stop pi subagent",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (args) =>
    guard(async () => {
      const exit_code = await registry.stop(args.agent_id, { force: args.force });
      if (args.remove) registry.remove(args.agent_id);
      return ok({ agent_id: args.agent_id, exit_code, removed: args.remove });
    }),
);

// ── pi_prune ────────────────────────────────────────────────────────────

server.registerTool(
  "pi_prune",
  {
    title: "Drop terminal pi subagents from the registry",
    description:
      "Remove agents whose state matches `states` (default `['dead']`) from the registry. " +
      "Useful for cleaning up after long sessions. Pass `['idle','dead']` to also discard " +
      "resumable agents. Returns the list of removed agent_ids. Mirrors no Claude Code tool " +
      "directly — closest analog is manually clearing TaskList of completed entries.",
    inputSchema: {
      states: z
        .array(z.enum(["idle", "dead"]))
        .default(["dead"])
        .describe("Which lifecycle states to evict. Default ['dead'] keeps resumable agents."),
    },
    annotations: {
      title: "Prune pi subagents",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) =>
    guard(async () => {
      const removed = registry.prune(args.states);
      return ok({ removed, count: removed.length });
    }),
);

// ── resource: schema/frames ─────────────────────────────────────────────

server.registerResource(
  "schema-frames",
  "deleg8://schema/frames",
  {
    title: "omp NDJSON frame catalog",
    description:
      "Frame types pi_output may return, plus message-block shapes and worked jq examples. " +
      "Read this before writing a non-trivial jq filter against `format: \"raw\"`.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(FRAME_SCHEMA, null, 2),
      },
    ],
  }),
);

} // end registerTools

// ── boot ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const sessionId = process.env.CLAUDE_SESSION_ID ?? randomUUID().slice(0, 8);
  // DELEG8_LOG_DIR overrides the default ~/.claude/deleg8/<session>/ path —
  // tests use it to keep state inside a tempdir.
  const sessionLogDir =
    process.env.DELEG8_LOG_DIR ?? join(homedir(), ".claude", "deleg8", sessionId);
  const { server, registry } = createPiAgentServer({
    binary: process.env.OMP_BIN ?? "omp",
    logDir: sessionLogDir,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // NOTE: never write to stdout from here — it corrupts the JSON-RPC stream.
  console.error(
    `deleg8 ready (binary=${process.env.OMP_BIN ?? "omp"}, session=${sessionId}, logs=${sessionLogDir})`,
  );

  // Last-resort cleanup: when Claude Code dies (graceful or otherwise), kill every
  // omp subprocess we spawned. Three independent triggers, any one of which fires:
  //   1. SIGINT/SIGTERM from the OS (normal shutdown path)
  //   2. MCP transport `close` / stdin EOF (parent closed our pipe)
  //   3. ppid poller (parent reaped without closing stdin — rare, but possible
  //      if a wrapper holds the pipe open across the parent's exit)
  // The shutdown function is idempotent so racing triggers don't double-kill.
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`deleg8 shutting down (${reason}), stopping all agents…`);
    await registry.stopAll({ force: true });
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  transport.onclose = () => void shutdown("transport closed");
  process.stdin.on("end", () => void shutdown("stdin EOF"));
  process.stdin.on("close", () => void shutdown("stdin closed"));

  const originalPpid = process.ppid;
  setInterval(() => {
    if (process.ppid !== originalPpid) {
      // Parent died and we were reparented (usually to init/pid 1). Bail out.
      void shutdown(`reparented (ppid ${originalPpid} -> ${process.ppid})`);
    }
  }, 5000).unref();
}

// Only auto-boot when run as the entrypoint (not when imported by tests).
if (import.meta.main) {
  main().catch((e) => {
    console.error("deleg8 fatal:", e);
    process.exit(1);
  });
}
