#!/usr/bin/env bun
// deleg8 — exposes oh-my-pi (`omp --mode rpc`) as a fleet of named,
// long-lived subagents addressable from Claude Code.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PiAgentError, type PiAgent, type RpcHostToolDefinition } from "./agent.ts";
import { loadDeleg8Config, type ModelSpec } from "./config.ts";
import type { Frame } from "./frames.ts";
import { jqFilter } from "./jq-filter.ts";
import { AgentRegistry } from "./registry.ts";
import { drainEvents, enqueueEvent } from "./persist.ts";
import { FRAME_SCHEMA } from "./schema.ts";
import { digest, extractTextContent, summarize } from "./summarize.ts";
import { makeElicitBridge } from "./ui-bridge.ts";

export interface PiAgentServerOptions {
  /** Pre-built registry. If omitted, one is created from env defaults. */
  registry?: AgentRegistry;
  /** Override the default omp binary path. Ignored if `registry` is set. */
  binary?: string;
  /** Override the log directory. Ignored if `registry` is set. */
  logDir?: string;
  /** Max concurrent agent subprocesses (0 = uncapped). Ignored if `registry` is set. */
  maxAgents?: number;
  /** Refuse spawns below this free-memory %. (0 = disabled). Ignored if `registry` is set. */
  minFreeMemPct?: number;
}

/** Non-negative integer from the environment, or undefined when unset/invalid. */
function envNonNegInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Identity of the code this process is actually running.
 *
 * deleg8 servers are long-lived and Bun does not hot-reload, so a server can be
 * many commits behind the checkout while looking healthy — on 2026-07-31 a
 * server from Jul 30 01:24 was still missing two same-day deliverability fixes
 * and nothing in its output said so. Resolved once, at module load.
 */
const BUILD_STAMP: { commit: string; source_mtime: string; started_at: string } = (() => {
  const srcDir = dirname(new URL(import.meta.url).pathname);
  let commit = "unknown";
  try {
    const head = readFileSync(join(srcDir, "..", ".git", "HEAD"), "utf8").trim();
    const ref = head.startsWith("ref: ") ? head.slice(5) : null;
    commit = ref
      ? readFileSync(join(srcDir, "..", ".git", ref), "utf8").trim().slice(0, 12)
      : head.slice(0, 12);
  } catch {
    // Not a git checkout (installed copy, or .git pruned) — the mtime still dates it.
  }
  let sourceMtime = "unknown";
  try {
    sourceMtime = statSync(join(srcDir, "server.ts")).mtime.toISOString();
  } catch {
    /* source read from a bundle */
  }
  return { commit, source_mtime: sourceMtime, started_at: new Date().toISOString() };
})();

export interface PiAgentServerHandle {
  server: McpServer;
  registry: AgentRegistry;
  wireAgent: (agent: PiAgent) => void;
}

export function createPiAgentServer(opts: PiAgentServerOptions = {}): PiAgentServerHandle {
  // Project .claude/deleg8.local.md takes precedence over ~/.claude/deleg8.local.md;
  // see config.ts. Loaded once at server startup, not per spawn — deleg8.local.md
  // configures deleg8 itself, not any individual agent's own working directory.
  const config = loadDeleg8Config();
  const server = new McpServer(
    { name: "deleg8", version: "0.1.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
      },
      instructions: [
        "Agent completion arrives as <channel source=\"deleg8\" agent_id=\"X\" event=\"agent_end\"> with the agent's final message — intermediate turn frames are suppressed.",
        "Agents can send mid-task IRC messages: <channel source=\"deleg8\" agent_id=\"X\" event=\"msg\">.",
        "Spawned agents get these deleg8-provided tools in their own tool list: msg{text}, task_create{label,note?}, task_update{task_id,status,note?}, task_list{agent_id?}, exclusive_acquire{pattern}, exclusive_release{pattern}. Tell the agent to call them by name in its prompt.",
        "task_create and task_update each emit a <channel event=\"task_create\"> or <channel event=\"task_update\"> notification in real time.",
        "Use the tasks tool to query the full task registry. Use the send tool to resume an idle agent.",
      ].join(" "),
    },
  );
  // Per-Claude-Code-session log directory. CLAUDE_SESSION_ID is preferred so
  // logs from the same session land together; otherwise a short generated id.
  const sessionId = process.env.CLAUDE_SESSION_ID ?? randomUUID().slice(0, 8);
  const defaultLogDir = join(homedir(), ".claude", "deleg8", sessionId);
  const sessionLogDir = opts.logDir ?? defaultLogDir;
  const registry =
    opts.registry ??
    new AgentRegistry({
      binary: opts.binary ?? process.env.OMP_BIN ?? config.ompBin ?? "omp",
      onUIRequest: makeElicitBridge(server),
      logDir: sessionLogDir,
      maxAgents: opts.maxAgents ?? envNonNegInt("DELEG8_MAX_AGENTS"),
      minFreeMemPct: opts.minFreeMemPct ?? envNonNegInt("DELEG8_MIN_FREE_MEM_PCT"),
    });
  const wireAgent = registerTools(server, registry, registry.getLogDir() ?? sessionLogDir, config.defaultModel);
  return { server, registry, wireAgent };
}

// ── task registry ───────────────────────────────────────────────────────────

interface TaskEntry {
  id: string;
  agent_id: string;
  label: string;
  status: "pending" | "in_progress" | "done" | "failed";
  note?: string;
  created_at: number;
  updated_at: number;
}

/** Maximum tasks per agent before task_create is rejected. */
const MAX_TASKS_PER_AGENT = 100;
/** Maximum label length for a task. */
const MAX_TASK_LABEL_BYTES = 200;
/** Maximum note length for a task. */
const MAX_TASK_NOTE_BYTES = 1000;

/** Maximum length of an agent's mid-task `msg`. Longer belongs in the final report. */
const MAX_MSG_BYTES = 2000;

/**
 * Remove all tasks belonging to the given agent_id from the task map.
 * Called when an agent finishes (agent_end), is stopped, or pruned.
 */
function cleanupAgentTasks(taskMap: Map<string, TaskEntry>, agentId: string): void {
  for (const [id, entry] of taskMap) {
    if (entry.agent_id === agentId) taskMap.delete(id);
  }
}

/**
 * Cross-session NDJSON feed of every channel notification. Channel frames are
 * silently discarded by Claude Code sessions launched without
 * --dangerously-load-development-channels (all background jobs) — the send
 * "succeeds", so the enqueue-on-failure path never fires. This file is the
 * delivery path that cannot be filtered: any session can tail or grep it.
 */
const GLOBAL_EVENTS_PATH = join(homedir(), ".claude", "deleg8", "events-global.ndjson");

function appendGlobalEvent(sessionLogDir: string | undefined, method: string, params: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(GLOBAL_EVENTS_PATH), { recursive: true });
    const session = sessionLogDir === undefined ? null : sessionLogDir.split("/").pop() ?? null;
    appendFileSync(GLOBAL_EVENTS_PATH, JSON.stringify({ ts: Date.now(), session, method, params }) + "\n", "utf8");
  } catch (error) {
    console.error("[deleg8] global event append failed:", error);
  }
}

/** macOS banner for agent_end — reaches the user even when no session can. */
function emitDesktopNotification(title: string, body: string): void {
  if (process.platform !== "darwin" || process.env.DELEG8_NO_DESKTOP_NOTIFY) return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    const child = spawn(
      "osascript",
      ["-e", `display notification "${esc(body.slice(0, 160))}" with title "${esc(title)}" sound name "Ping"`],
      { stdio: "ignore", detached: true },
    );
    child.unref();
  } catch (error) {
    console.error("[deleg8] desktop notification failed:", error);
  }
}

async function sendNotification(
  server: McpServer,
  sessionLogDir: string | undefined,
  method: string,
  params: Record<string, unknown>,
  label: string,
): Promise<void> {
  appendGlobalEvent(sessionLogDir, method, params);
  const meta = params.meta as Record<string, unknown> | undefined;
  if (meta?.event === "agent_end") {
    const content = typeof params.content === "string" ? params.content : "agent finished";
    emitDesktopNotification(`deleg8: ${String(meta.agent_id ?? "agent")} done`, content);
  }
  try {
    await server.server.notification({ method, params });
  } catch (error) {
    console.error(`[deleg8] ${label} notification failed:`, error);
    if (sessionLogDir === undefined) return;
    try {
      enqueueEvent(sessionLogDir, { method, params });
    } catch (queueError) {
      console.error(`[deleg8] could not queue ${label} notification:`, queueError);
    }
  }
}
function registerTools(
  server: McpServer,
  registry: AgentRegistry,
  sessionLogDir?: string,
  defaultModel?: ModelSpec,
): (agent: PiAgent) => void {
  const taskMap = new Map<string, TaskEntry>();
  let taskSeq = 0;

// ── helpers ─────────────────────────────────────────────────────────────


function buildMonitorCmd(agentId: string, logPath: string): string {
  // Generates a bash command for Claude Code's Monitor tool. It:
  //   1. tail -f the NDJSON log
  //   2. waits for an agent_end OR error frame
  //   3. extracts the last assistant message_end text from the full log
  //   4. prints a one-line summary and exits
  // Each stdout line becomes a Monitor notification.
  const lp = logPath.replace(/'/g, "'\\''");
  // tail -f the log; on agent_end/error, read the file backwards to find the
  // last assistant message_end, extract text blocks via jq, print, and exit.
  // tac + grep -m1 avoids racing with tail's open file handle.
  return [
    `tail -n +1 -f '${lp}'`,
    `| while IFS= read -r line; do`,
    `  if printf '%s' "$line" | grep -qE '"type":"agent_end"|"type":"error"'; then`,
    `    last_text=$(tail -r '${lp}'`,
    `      | grep -m1 '"role":"assistant".*"type":"message_end"\\|"type":"message_end".*"role":"assistant"'`,
    `      | jq -r '[.message.content[]? | select(.type=="text") | .text] | join("")' 2>/dev/null);`,
    `    echo "[deleg8 ${agentId}] done: $last_text";`,
    `    exit 0;`,
    `  fi;`,
    `done`,
  ].join(" ");
}

// Prepended to initial_prompt when spawn's `role: "leaf"` is set.
const LEAF_ROLE_PREAMBLE =
  "You are a leaf worker: do NOT spawn subagents, do NOT delegate work, do not use any " +
  "agent/task-spawning tools. Do the work yourself and report results in your final message.\n\n";

/** Build a prompt-constraint block from denylist, own, and preamble config. */
function buildConstraintBlock(denylist: string[] | undefined, own: string[] | undefined, preamble: string | undefined): string {
  const parts: string[] = [];
  if (preamble) parts.push(preamble);
  if (denylist && denylist.length > 0) {
    parts.push(
      "## HARD BLOCKED COMMANDS — DO NOT IGNORE\n" +
      "The following command patterns are DENIED at the tool-execution layer. " +
      "Before running ANY tool (especially Bash), check the command string against these patterns. " +
      "If it matches, you MUST NOT execute the command. Return a tool error result explaining it was blocked.\n" +
      denylist.map((p) => `- Pattern: /${p}/i`).join("\n"),
    );
  }
  if (own && own.length > 0) {
    const listing = own.map((g) => `  - ${g}`).join("\n");
    parts.push(
      "## WRITE SCOPE\n" +
      "You may only write to files matching these patterns:\n" +
      listing +
      "\nFiles outside these patterns are BLOCKED. Check every Bash/write/edit path before executing. " +
      "If the target is out of scope, return a tool error — do NOT write.",
    );
  }
  return parts.length > 0 ? parts.join("\n\n") + "\n\n" : "";
}

const MAX_RESULT_BYTES = 32 * 1024;


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
function ok(value: unknown, text?: string) {
  const json = text ?? JSON.stringify(value);
  return { content: [{ type: "text" as const, text: json }] };
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
  const notify = (
    method: string,
    params: Record<string, unknown>,
    label: string,
  ): Promise<void> => sendNotification(server, sessionLogDir, method, params, label);

  /**
   * Tools deleg8 implements on the agent's behalf, advertised to omp at start().
   * Every name here must have a branch in handleHostRequest below, and vice
   * versa — a mismatch is silent: omp offers a tool whose call falls through to
   * "not registered", or deleg8 handles a tool the model never sees.
   */
  const HOST_TOOLS: RpcHostToolDefinition[] = [
    {
      name: "msg",
      label: "Message orchestrator",
      description:
        "Send a short progress message to the orchestrator mid-task, without ending your turn. " +
        "Use for findings worth surfacing before your final report.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "The message. One or two sentences." } },
        required: ["text"],
      },
    },
    {
      name: "task_create",
      label: "Create task",
      description: "Register a unit of sub-work so the orchestrator can see it. Returns the task_id to pass to task_update.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "Short imperative description of the work." },
          note: { type: "string", description: "Optional detail, e.g. acceptance check." },
        },
        required: ["label"],
      },
    },
    {
      name: "task_update",
      label: "Update task",
      description: "Move a task you created to a new status.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "id returned by task_create." },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "failed"] },
          note: { type: "string", description: "Optional detail, e.g. the finding." },
        },
        required: ["task_id", "status"],
      },
    },
    {
      name: "task_list",
      label: "List tasks",
      description: "List tracked tasks, optionally filtered to one agent.",
      parameters: {
        type: "object",
        properties: { agent_id: { type: "string", description: "Filter to this agent. Omit for all." } },
      },
    },
    {
      name: "exclusive_acquire",
      label: "Acquire exclusive lock",
      description:
        "Acquire the cooperative lock for a command pattern before running it. Blocks until granted. " +
        "Required only for patterns the orchestrator declared exclusive at spawn.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string", description: "The declared exclusive pattern." } },
        required: ["pattern"],
      },
    },
    {
      name: "exclusive_release",
      label: "Release exclusive lock",
      description: "Release a lock acquired with exclusive_acquire. Always release, even on failure.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string", description: "The pattern to release." } },
        required: ["pattern"],
      },
    },
  ];

  /**
   * Build a `host_tool_result` frame. omp validates `result.content` is an array
   * (rpc-types.d.ts:679, AgentToolResult) — a bare payload object is rejected,
   * so the JSON payload rides in a text block and stays machine-readable.
   */
  const hostResult = (id: string, payload: unknown, isError = false): Frame =>
    ({
      type: "host_tool_result",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(payload) }], details: {} },
      ...(isError ? { isError: true } : {}),
    }) as unknown as Frame;

  const handleHostRequest = async (agentId: string, request: Frame): Promise<Frame | null> => {
    const req = request as Record<string, unknown>;
    // omp sends `toolName`/`arguments` (RpcHostToolCallRequest, rpc-types.d.ts:660).
    // `tool`/`args` are deleg8's own pre-2026-07-31 names, kept as a fallback so
    // an older omp — or the mock — still resolves.
    const tool = typeof req.toolName === "string" ? req.toolName : typeof req.tool === "string" ? req.tool : "";
    const args = (req.arguments ?? req.args ?? {}) as Record<string, unknown>;
    const id = typeof req.id === "string" ? req.id : "";

    if (tool === "msg") {
      const text = String(args.text ?? "").slice(0, MAX_MSG_BYTES);
      if (!text) return hostResult(id, { error: "msg requires a `text` argument" }, true);
      void notify(
        "notifications/claude/channel",
        { content: text, meta: { agent_id: agentId, event: "msg" } },
        "channel msg",
      );
      return hostResult(id, { delivered: true });
    }

    if (tool === "task_create") {
      const agentTaskCount = [...taskMap.values()].filter((t) => t.agent_id === agentId).length;
      if (agentTaskCount >= MAX_TASKS_PER_AGENT) {
        return hostResult(id, { error: `task limit reached (${MAX_TASKS_PER_AGENT} per agent)` }, true);
      }
      taskSeq += 1;
      const taskId = `task-${taskSeq}`;
      const entry: TaskEntry = {
        id: taskId,
        agent_id: agentId,
        label: String(args.label ?? "unnamed").slice(0, MAX_TASK_LABEL_BYTES),
        status: "pending",
        note: args.note !== undefined ? String(args.note).slice(0, MAX_TASK_NOTE_BYTES) : undefined,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      taskMap.set(taskId, entry);
      const createNote = entry.note ? ` — ${entry.note}` : "";
      void notify(
        "notifications/claude/channel",
        {
          content: `[${taskId}] created [${entry.status}] ${entry.label}${createNote}`,
          meta: { agent_id: agentId, event: "task_create", task_id: taskId, task: entry },
        },
        "channel task_create",
      );
      return hostResult(id, entry);
    }
    if (tool === "task_update") {
      const taskId = String(args.task_id ?? "");
      const entry = taskMap.get(taskId);
      if (!entry) {
        return hostResult(id, { error: `task ${taskId} not found` }, true);
      }
      if (args.status !== undefined) entry.status = args.status as TaskEntry["status"];
      if (args.note !== undefined) entry.note = String(args.note);
      entry.updated_at = Date.now();
      const updateNote = entry.note ? ` — ${entry.note}` : "";
      void notify(
        "notifications/claude/channel",
        {
          content: `[${taskId}] [${entry.status}] ${entry.label}${updateNote}`,
          meta: { agent_id: agentId, event: "task_update", task_id: taskId, task: entry },
        },
        "channel task_update",
      );
      return hostResult(id, entry);
    }

    if (tool === "task_list") {
      const filterAgent = typeof args.agent_id === "string" ? args.agent_id : undefined;
      const tasks = [...taskMap.values()].filter((t) => !filterAgent || t.agent_id === filterAgent);
      return hostResult(id, { count: tasks.length, tasks });
    }

    if (tool === "exclusive_acquire") {
      const pattern = String(args.pattern ?? "");
      if (!pattern) {
        return hostResult(id, { error: "exclusive_acquire requires a `pattern` argument" }, true);
      }
      const acquired = registry.acquireExclusive(pattern, agentId);
      void notify(
        "notifications/claude/channel",
        {
          content: acquired
            ? `[deleg8 LOCK] ${agentId} acquired exclusive lock on /${pattern}/i`
            : `[deleg8 LOCK WAIT] ${agentId} queued for exclusive lock on /${pattern}/i`,
          meta: { agent_id: agentId, event: "exclusive_acquire", pattern, acquired },
        },
        "exclusive_acquire",
      );
      return hostResult(id, { acquired });
    }

    if (tool === "exclusive_release") {
      const pattern = String(args.pattern ?? "");
      if (!pattern) {
        return hostResult(id, { error: "exclusive_release requires a `pattern` argument" }, true);
      }
      const nextHolder = registry.releaseExclusive(pattern, agentId);
      void notify(
        "notifications/claude/channel",
        {
          content: nextHolder
            ? `[deleg8 LOCK] ${agentId} released exclusive lock on /${pattern}/i → transferred to ${nextHolder}`
            : `[deleg8 LOCK] ${agentId} released exclusive lock on /${pattern}/i (no waiters)`,
          meta: { agent_id: agentId, event: "exclusive_release", pattern, next_holder: nextHolder },
        },
        "exclusive_release",
      );
      return hostResult(id, { released: true, next_holder: nextHolder });
    }

    return null;
  };

  const wireAgent = (agent: PiAgent): void => {
    agent.onViolation = (agentId, type, detail) => {
      void notify(
        "notifications/claude/channel",
        {
          content: type === "denied"
            ? `[deleg8 BLOCKED] ${agentId}: tool "${detail.toolName}" matched denylist pattern /${detail.pattern}/`
            : `[deleg8 SCOPE] ${agentId}: wrote "${detail.path}" outside scope (tool: ${detail.toolName})`,
          meta: { agent_id: agentId, event: type === "denied" ? "denied_command" : "scope_violation", ...detail },
        },
        "onViolation",
      );
    };
    agent.onChannelFrame = (agentId, _frame, ftype) => {
      if (ftype !== "agent_end") return;
      const buf = agent.output({ maxFrames: 1000 });
      const d = digest(buf, { lastMessages: 1 });
      const lastMsg = d.messages[d.messages.length - 1];
      const lastText = (typeof lastMsg?.data?.text === "string" ? lastMsg.data.text : "").trim().slice(0, 2000);
      void notify(
        "notifications/claude/channel",
        {
          content: lastText || `agent ${agentId} finished`,
          meta: { agent_id: agentId, event: "agent_end" },
        },
        "channel agent_end",
      );
    };
    agent.onHostRequest = handleHostRequest;
    // Read by start(), so every later respawn (resume, fallback model) re-registers.
    // The initial start() already happened inside registry.spawn(), which is why the
    // spawn handler registers once explicitly right after this call.
    agent.hostTools = HOST_TOOLS;
  };

// ── spawn ────────────────────────────────────────────────────────────

server.registerTool(
  "spawn",
  {
    title: "Spawn pi subagent",
    description:
      "Launch a new `omp --mode rpc` subprocess and register it under `agent_id`. " +
      "Mirrors the native Agent tool: optionally send `initial_prompt` and wait for the response. " +
      "Set `background: true` to return the agent_id immediately and stream output via output later.\n\n" +
      "New enforcement parameters:\n" +
      "- `denylist`: regex patterns over tool commands. Prompt-level constraints + " +
      "violation monitoring. omp runs tools internally — deleg8 cannot intercept before execution.\n" +
      "- `own`: glob patterns limiting write scope. Same injection + monitoring pattern.\n" +
      "- `preamble`: shared context block every spawned agent receives before its prompt.\n" +
      "- `fallback_model`: if the primary model fails to apply, try this one.\n" +
      "- `exclusive`: cooperative agent protocol — agents acquire/release locks via host tools.\n" +
      "- `idle_ttl` / `dead_ttl`: auto-reap agents after inactivity (default 1h each).\n\n" +
      "Capacity: spawn (and resume of an idle agent) is rejected when the concurrent-agent cap " +
      "(DELEG8_MAX_AGENTS, default 6) is reached or system free memory is below the floor " +
      "(DELEG8_MIN_FREE_MEM_PCT, default 15%). On rejection, wait for agents to finish or stop one.",
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
        .describe(
          "Optional `set_model` frame sent before initial_prompt. Falls back to " +
            "deleg8.local.md's default_model when omitted.",
        ),
      fallback_model: z
        .object({
          provider: z.string().describe("e.g. 'openai'"),
          modelId: z.string().describe("e.g. 'gpt-5'"),
        })
        .optional()
        .describe("If the primary model fails (e.g. budget exceeded), try this one."),
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
      role: z
        .enum(["leaf"])
        .optional()
        .describe(
          "Set to 'leaf' to prepend a preamble instructing the worker not to spawn sub-agents or " +
            "delegate — it must do the work itself. Omitting this leaves today's behavior unchanged.",
        ),
      // ── Enforcement config ──────────────────────────────────────────
      denylist: z
        .array(z.string())
        .optional()
        .describe(
          "Regex patterns over toolName + command string (e.g. `[\"git (stash|checkout|reset|clean)\", " +
            "\"dotnet (build|test|publish)\"]`). Agents receive these as prompt-level constraints " +
            "(injected into initial_prompt before the task instructions); matching tool_execution_start " +
            "frames fire real-time channel notifications.\n\n" +
            "Architectural note: omp runs its Bash/Read/Edit tools internally. deleg8 receives " +
            "tool_execution_start frames AFTER execution begins — it cannot intercept before the tool " +
            "runs. Enforcement combines (a) prompt-level agent instruction (primary) with (b) real-time " +
            "violation monitoring (visibility into bypass). This is the best available given omp's " +
            "internal tool execution model.",
        ),
      own: z
        .array(z.string())
        .optional()
        .describe(
          "Glob patterns constraining write scope (e.g. `[\"src/**\", \"docs/*\"]`). " +
            "Agents receive prompt-level blocking instructions; writes outside scope " +
            "fire channel notifications.\n\n" +
            "Same architectural constraint as denylist: omp runs tool execution internally, " +
            "so the primary enforcement is the agent's prompt instruction. Violation monitoring " +
            "provides real-time visibility into any bypass.",
        ),
      preamble: z
        .string()
        .optional()
        .describe(
          "Shared context block every spawned agent receives before its prompt. " +
            "Use for fan-out-level ground truth (library idioms, API contracts).",
        ),
      idle_ttl: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Auto-reap idle agents after N ms of inactivity (registry-level, default 1h, 0 = off)."),
      dead_ttl: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Auto-reap dead agents after N ms (registry-level, default 1h, 0 = off)."),
      exclusive: z
        .array(
          z.object({
            pattern: z.string().describe("Case-insensitive regex over the command string."),
            wait: z.boolean().default(true).describe("True = queue caller, False = reject immediately."),
          }),
        )
        .optional()
        .describe(
          "Declare command patterns as exclusive across agents. Agents acquire/release locks " +
            "via host_tool_call tools `exclusive_acquire`/`exclusive_release`. Only one agent " +
            "holds each lock at a time; queued waiters acquire on release.\n\n" +
            "This is a cooperative agent protocol: agents must call `exclusive_acquire` before " +
            "running the command and `exclusive_release` after. A rogue agent ignoring the " +
            "protocol can bypass the lock (omp runs tools internally — deleg8 cannot intercept). " +
            "Lock state is tracked in the registry and released on agent stop/remove/prune.\n" +
            "The `send` MCP tool also performs a best-effort check against the prompt text.",
      ),
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
      // ── Set registry-level TTL ──────────────────────────────────────
      // Only explicit args override the registry default (1h); an explicit 0
      // disables that reap.
      if (args.idle_ttl !== undefined || args.dead_ttl !== undefined) {
        registry.setTTL(args.idle_ttl, args.dead_ttl);
      }
      if (args.exclusive !== undefined && args.exclusive.length > 0) {
        registry.setExclusive(args.exclusive);
      }
      // ── Spawn agent and wire options ────────────────────────────────
      const agent = await registry.spawn({
        agentId: args.agent_id,
        extraArgs: args.extra_args,
        cwd: args.cwd,
        rpcMode: args.rpc_mode,
      });

      // Wire denylist, own, preamble, fallbackModel, violation callback
      if (args.denylist) agent.denylistRe.splice(0, agent.denylistRe.length, ...args.denylist.map((p: string) => new RegExp(p, "i")));
      if (args.own) agent.own.splice(0, agent.own.length, ...args.own);
      agent.preamble = args.preamble ?? null;
      agent.fallbackModel = args.fallback_model ?? null;
      wireAgent(agent);
      await agent.registerHostTools();

      // Configure model
      async function applyModel(model: { provider: string; modelId: string }): Promise<boolean> {
        try {
          await agent.setModel(model.provider, model.modelId);
          return true;
        } catch (e) {
          const msg = (e as Error).message;
          console.error(`[deleg8] model set failed for ${agent.agentId}: ${msg}`);
          return false;
        }
      }

      // Explicit `model` wins; otherwise fall back to deleg8.local.md's default_model
      // (config.ts / loadDeleg8Config) so callers don't have to repeat it on every spawn.
      const requestedModel = args.model ?? defaultModel;
      if (requestedModel) {
        const ok = await applyModel(requestedModel);
        if (!ok && args.fallback_model) {
          console.error(`[deleg8] ${agent.agentId}: primary model failed, trying fallback`);
          await applyModel(args.fallback_model);
        }
      }

      // Clean up tasks for finished agents
      cleanupAgentTasks(taskMap, agent.agentId);


      let response: unknown = null;
      if (args.initial_prompt) {
        const constraintBlock = buildConstraintBlock(args.denylist, args.own, args.preamble);
        let prompt = constraintBlock + args.initial_prompt;
        if (args.role === "leaf") prompt = LEAF_ROLE_PREAMBLE + prompt;
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

// ── send ─────────────────────────────────────────────────────────────

server.registerTool(
  "send",
  {
    title: "Send message to existing pi agent",
    description:
      "Equivalent of SendMessage({to: agent_id, prompt: message}). If the agent is idle " +
      "(auto-suspended at last turn_end), send transparently respawns omp with " +
      "--resume <session_id> so conversation context is preserved across pauses. " +
      "Targets the existing agent_id — does NOT create a new agent.",
    inputSchema: {
      agent_id: z.string().describe("Target agent_id (from spawn or list)."),
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

      // Best-effort exclusive lock check: if the message text matches an exclusive
      // pattern and the target agent doesn't hold the lock, warn via channel event.
      for (const entry of registry.exclusive) {
        const re = new RegExp(entry.pattern, "i");
        if (re.test(args.message)) {
          const holder = registry.exclusiveLocks.get(entry.pattern);
          if (holder && holder !== args.agent_id) {
            void notify(
              "notifications/claude/channel",
              {
                content: `[deleg8 SEND] ${args.agent_id} sent a message matching exclusive pattern /${entry.pattern}/i but lock is held by ${holder}`,
                meta: { agent_id: args.agent_id, event: "exclusive_contention", pattern: entry.pattern, holder },
              },
              "exclusive contention",
            );
          }
          break; // only warn on first match
        }
      }

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

// ── list ─────────────────────────────────────────────────────────────

server.registerTool(
  "list",
  {
    title: "List pi subagents",
    description:
      "Snapshot of every registered pi agent. Each entry has `state` (running | idle | dead), " +
      "`session_id`, and `total_cost_usd` (summed across the agent's buffered frames). " +
      "`idle` means the subprocess has exited at end-of-turn but the omp " +
      "session is on disk and resumable via send. `dead` means the agent crashed or was " +
      "stopped — registry entry persists for inspection until prune. Mirrors TaskList. " +
      "`server` carries the running process's commit/source mtime/boot time: compare it against " +
      "the checkout to tell whether this server predates a fix you expect it to have. " +
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
      const agents = registry.list().map((a) => ({ ...a.status(), total_cost_usd: a.costUsd() }));
      const result = await project({ count: agents.length, agents, server: BUILD_STAMP }, args.jq);
      return ok(result);
    }),
);

// ── status ───────────────────────────────────────────────────────────

server.registerTool(
  "status",
  {
    title: "Get status of one pi subagent",
    description:
      "Detailed status for a single agent — `state` (running | idle | dead), `pid`, " +
      "`session_id`, `session_file`, `last_activity`, `message_count`, `log_path`, " +
      "`total_cost_usd` (summed across the agent's buffered frames). " +
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
      const status = { ...agent.status(), total_cost_usd: agent.costUsd() };
      const result = await project({ agent_id: args.agent_id, status }, args.jq);
      return ok(result);
    }),
);

// ── output ───────────────────────────────────────────────────────────

server.registerTool(
  "output",
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
        // The digest only sees the last 1000 buffered frames (itself capped at
        // BUFFER_CAP=1024 total), so long sessions evict early tool calls
        // before a digest is ever requested. agent.modifiedFiles is populated
        // durably at frame-intake time and survives that eviction — union it
        // in so modified_files reflects the whole session, not just the tail.
        const modified_files = Array.from(new Set([...d.modified_files, ...agent.modifiedFiles])).sort();
        payload = {
          agent_id: args.agent_id,
          format: "digest",
          full_output_path: agent.getLogPath(),
          modified_files,
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

// ── stop ─────────────────────────────────────────────────────────────

server.registerTool(
  "stop",
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

// ── prune ────────────────────────────────────────────────────────────

server.registerTool(
  "prune",
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

// ── tasks ────────────────────────────────────────────────────────────────

server.registerTool(
  "tasks",
  {
    title: "Query agent task registry",
    description:
      "List or get tasks created by agents via host_tool_call task_create/task_update. " +
      "Agents use this to surface sub-work tracking back to the orchestrator.",
    inputSchema: {
      agent_id: z.string().optional().describe("Filter by agent_id. Omit for all tasks."),
      task_id: z.string().optional().describe("Get a specific task by ID."),
      jq: z.string().optional().describe("Optional jq -c filter applied to the result."),
    },
    annotations: {
      title: "Query agent tasks",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (args) =>
    guard(async () => {
      if (args.task_id) {
        const entry = taskMap.get(args.task_id);
        if (!entry) return fail(`task ${args.task_id} not found`);
        const result = await project({ task: entry }, args.jq);
        return ok(result);
      }
      const tasks = args.agent_id
        ? [...taskMap.values()].filter((t) => t.agent_id === args.agent_id)
        : [...taskMap.values()];
      const result = await project({ count: tasks.length, tasks }, args.jq);
      return ok(result);
    }),
);

  // ── task_create ──────────────────────────────────────────────────────────

  server.registerTool(
    "task_create",
    {
      title: "Create a task in the registry",
      description: "Create a task to track subagent progress. Exposed to the orchestrator.",
      inputSchema: {
        agent_id: z.string().describe("Agent ID this task belongs to."),
        label: z.string().describe("Task label (5-10 words)."),
        note: z.string().optional().describe("Optional note detailing the task."),
      },
      annotations: {
        title: "Create task",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
    guard(async () => {
      // Enforce per-agent task cap
      const agentTaskCount = [...taskMap.values()].filter((t) => t.agent_id === args.agent_id).length;
      if (agentTaskCount >= MAX_TASKS_PER_AGENT) {
        return fail(`task limit reached (${MAX_TASKS_PER_AGENT} per agent)`);
      }
      taskSeq += 1;
      const taskId = `task-${taskSeq}`;
      const entry: TaskEntry = {
        id: taskId,
        agent_id: args.agent_id,
        label: String(args.label).slice(0, MAX_TASK_LABEL_BYTES),
        status: "pending",
        note: args.note ? String(args.note).slice(0, MAX_TASK_NOTE_BYTES) : undefined,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      taskMap.set(taskId, entry);

      // Fire notification so Claude Code UI updates/logs it
      void notify(
        "notifications/claude/channel",
        {
          content: `[${taskId}] created [pending] ${entry.label}${entry.note ? ` — ${entry.note}` : ""}`,
          meta: { agent_id: args.agent_id, event: "task_create", task_id: taskId, task: entry },
        },
        "host task_create",
      );

      return ok(entry);
    }),
  );

  // ── task_update ──────────────────────────────────────────────────────────

  server.registerTool(
    "task_update",
    {
      title: "Update a task status in the registry",
      description: "Update the status or note of a task. Exposed to the orchestrator.",
      inputSchema: {
        task_id: z.string().describe("Task ID to update."),
        status: z.enum(["pending", "in_progress", "done", "failed"]).optional().describe("New status."),
        note: z.string().optional().describe("Updated note."),
      },
      annotations: {
        title: "Update task",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      guard(async () => {
        const entry = taskMap.get(args.task_id);
        if (!entry) return fail(`task ${args.task_id} not found`);
        if (args.status !== undefined) entry.status = args.status;
        if (args.note !== undefined) entry.note = args.note;
        entry.updated_at = Date.now();

        // Fire notification
        void notify(
          "notifications/claude/channel",
          {
            content: `[${args.task_id}] [${entry.status}] ${entry.label}${entry.note ? ` — ${entry.note}` : ""}`,
            meta: { agent_id: entry.agent_id, event: "task_update", task_id: args.task_id, task: entry },
          },
          "host task_update",
        );

        return ok(entry);
      }),
  );

// ── resource: schema/frames ─────────────────────────────────────────────

server.registerResource(
  "schema-frames",
  "deleg8://schema/frames",
  {
    title: "omp NDJSON frame catalog",
    description:
      "Frame types output may return, plus message-block shapes and worked jq examples. " +
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

  return wireAgent;
} // end registerTools

// ── boot ────────────────────────────────────────────────────────────────

/**
 * Delete session log dirs under `root` whose newest top-level entry is older
 * than `maxAgeMs`. Age is judged from the dir's own mtime plus its immediate
 * children only — agent activity always appends to a top-level `<id>.log`,
 * so a live session can never look stale. The `keep` dir (current session)
 * is never removed. Returns the names of removed dirs.
 */
export function reapOldSessionDirs(root: string, keep: string, maxAgeMs: number): string[] {
  const removed: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return removed;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keep) continue;
    const dir = join(root, entry.name);
    try {
      let newest = statSync(dir).mtimeMs;
      for (const child of readdirSync(dir)) {
        const m = statSync(join(dir, child)).mtimeMs;
        if (m > newest) newest = m;
      }
      if (newest < cutoff) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(entry.name);
      }
    } catch {
      // Unreadable or vanished mid-scan — leave it for the next boot.
    }
  }
  return removed;
}

async function main(): Promise<void> {
  const sessionId = process.env.CLAUDE_SESSION_ID ?? randomUUID().slice(0, 8);
  // DELEG8_LOG_DIR overrides the default ~/.claude/deleg8/<session>/ path —
  // tests use it to keep state inside a tempdir.
  const sessionLogDir =
    process.env.DELEG8_LOG_DIR ?? join(homedir(), ".claude", "deleg8", sessionId);
  const deleg8Root = dirname(sessionLogDir);
  const { server, registry, wireAgent } = createPiAgentServer({
    binary: process.env.OMP_BIN ?? "omp",
    logDir: sessionLogDir,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // NOTE: never write to stdout from here — it corrupts the JSON-RPC stream.
  console.error(
    `deleg8 ready (commit=${BUILD_STAMP.commit}, binary=${process.env.OMP_BIN ?? "omp"}, session=${sessionId}, logs=${sessionLogDir})`,
  );

  // Log rotation: reap stale sibling session dirs (4.1G accumulated in two
  // days before this existed). Only under the default root — a DELEG8_LOG_DIR
  // override (tests) points at a dir whose siblings aren't ours to delete.
  if (process.env.DELEG8_LOG_DIR === undefined) {
    const maxAgeDays = envNonNegInt("DELEG8_LOG_MAX_AGE_DAYS") ?? 3;
    if (maxAgeDays > 0) {
      const removed = reapOldSessionDirs(
        join(homedir(), ".claude", "deleg8"),
        sessionId,
        maxAgeDays * 86_400_000,
      );
      if (removed.length > 0) {
        console.error(`deleg8: reaped ${removed.length} stale session log dir(s): ${removed.join(", ")}`);
      }
    }
  }

  const adopted = registry.adoptPersisted(deleg8Root);
  for (const agent of adopted) wireAgent(agent);
  await drainEvents(deleg8Root, (event) =>
    server.server.notification({ method: event.method, params: event.params }),
  );

  // Last-resort cleanup: suspend resumable agents and force-stop agents without
  // an omp session. Three independent triggers can invoke this idempotent path:
  // SIGINT/SIGTERM, transport close/stdin EOF, or parent reparenting.
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`deleg8 shutting down (${reason}), suspending resumable agents…`);
    const suspended: PiAgent[] = [];
    await Promise.allSettled(
      registry.list().map(async (agent) => {
        const status = agent.status();
        if (status.state !== "running") return;
        if (status.session_id !== null) {
          await agent.suspend();
          suspended.push(agent);
        } else {
          await agent.stop({ force: true });
        }
      }),
    );
    registry.persist();
    for (const agent of suspended) {
      try {
        enqueueEvent(sessionLogDir, {
          method: "notifications/claude/channel",
          params: {
            content: `agent ${agent.agentId} suspended at session end — resumable via send next session`,
            meta: { agent_id: agent.agentId, event: "agent_suspended" },
          },
        });
      } catch (error) {
        console.error(`[deleg8] could not queue shutdown notification for ${agent.agentId}:`, error);
      }
    }
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
