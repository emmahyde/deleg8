import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface AgentSnapshot {
  agent_id: string;
  session_id: string | null;
  session_dir: string | null;
  session_file: string | null;
  log_path: string | null;
  cwd: string | null;
  extra_args: string[];
  rpc_mode: "rpc" | "rpc-ui";
  model: string | null;
  started_at: number;
  last_activity: number;
  message_count: number;
}

export interface QueuedEvent {
  pid: number;
  ts: number;
  method: string;
  params: Record<string, unknown>;
}

export interface QueuedEventInput {
  method: string;
  params: Record<string, unknown>;
  pid?: number;
  ts?: number;
}

export interface SaveRegistryOptions {
  session: string;
  agents: AgentSnapshot[];
  server_pid?: number;
  saved_at?: number;
}

interface RegistryFile {
  version: 1;
  server_pid: number;
  session: string;
  saved_at: number;
  agents: unknown[];
}

const QUEUED_CONTENT_PREFIX = "[deleg8 queued from previous session] ";

export function saveRegistry(statePath: string, opts: SaveRegistryOptions): void {
  const payload: RegistryFile = {
    version: 1,
    server_pid: opts.server_pid ?? process.pid,
    session: opts.session,
    saved_at: opts.saved_at ?? Date.now(),
    agents: opts.agents,
  };
  mkdirSync(dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(payload) + "\n", "utf8");
    renameSync(tmpPath, statePath);
  } catch (error) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function pidIsAlive(pid: unknown, currentPid: number): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid === currentPid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function asNullableString(value: unknown): string | null {
  return value === null ? null : typeof value === "string" ? value : null;
}

function parseSnapshot(value: unknown): AgentSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const agentId = raw.agent_id;
  const sessionId = raw.session_id;
  const sessionDir = raw.session_dir;
  const extraArgs = raw.extra_args;
  const rpcMode = raw.rpc_mode;
  const startedAt = raw.started_at;
  const lastActivity = raw.last_activity;
  const messageCount = raw.message_count;
  if (
    typeof agentId !== "string" ||
    typeof sessionId !== "string" ||
    typeof sessionDir !== "string" ||
    !isDirectory(sessionDir) ||
    !Array.isArray(extraArgs) ||
    !extraArgs.every((arg) => typeof arg === "string") ||
    (rpcMode !== "rpc" && rpcMode !== "rpc-ui") ||
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    typeof lastActivity !== "number" ||
    !Number.isFinite(lastActivity) ||
    typeof messageCount !== "number" ||
    !Number.isInteger(messageCount) ||
    messageCount < 0
  ) {
    return null;
  }
  return {
    agent_id: agentId,
    session_id: sessionId,
    session_dir: sessionDir,
    session_file: asNullableString(raw.session_file),
    log_path: asNullableString(raw.log_path),
    cwd: asNullableString(raw.cwd),
    extra_args: [...extraArgs] as string[],
    rpc_mode: rpcMode,
    model: asNullableString(raw.model),
    started_at: startedAt,
    last_activity: lastActivity,
    message_count: messageCount,
  };
}

/** Load the newest resumable snapshot for each agent from sibling session dirs. */
export function loadRegistrySnapshots(root: string, currentPid = process.pid): AgentSnapshot[] {
  const newest = new Map<string, { savedAt: number; snapshot: AgentSnapshot }>();
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = join(root, entry.name, "registry.json");
    let parsed: RegistryFile;
    try {
      parsed = JSON.parse(readFileSync(statePath, "utf8")) as RegistryFile;
    } catch {
      continue;
    }
    if (
      parsed.version !== 1 ||
      typeof parsed.server_pid !== "number" ||
      pidIsAlive(parsed.server_pid, currentPid) ||
      !Array.isArray(parsed.agents)
    ) {
      continue;
    }
    const savedAt = typeof parsed.saved_at === "number" && Number.isFinite(parsed.saved_at) ? parsed.saved_at : 0;
    for (const rawSnapshot of parsed.agents) {
      const snapshot = parseSnapshot(rawSnapshot);
      if (!snapshot) continue;
      const previous = newest.get(snapshot.agent_id);
      if (!previous || savedAt > previous.savedAt) {
        newest.set(snapshot.agent_id, { savedAt, snapshot });
      }
    }
  }
  return Array.from(newest.values(), ({ snapshot }) => snapshot);
}

export function enqueueEvent(sessionLogDir: string, event: QueuedEventInput): void {
  mkdirSync(sessionLogDir, { recursive: true });
  const queued: QueuedEvent = {
    pid: event.pid ?? process.pid,
    ts: event.ts ?? Date.now(),
    method: event.method,
    params: event.params,
  };
  appendFileSync(join(sessionLogDir, "events.ndjson"), JSON.stringify(queued) + "\n", "utf8");
}

function parseQueuedEvent(value: unknown): QueuedEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if (
    typeof event.pid !== "number" ||
    !Number.isInteger(event.pid) ||
    typeof event.ts !== "number" ||
    !Number.isFinite(event.ts) ||
    typeof event.method !== "string" ||
    !event.params ||
    typeof event.params !== "object" ||
    Array.isArray(event.params)
  ) {
    return null;
  }
  return {
    pid: event.pid,
    ts: event.ts,
    method: event.method,
    params: event.params as Record<string, unknown>,
  };
}

function queuedForDelivery(event: QueuedEvent): QueuedEvent {
  const originalContent = typeof event.params.content === "string"
    ? event.params.content
    : JSON.stringify(event.params);
  return {
    ...event,
    params: {
      ...event.params,
      content: `${QUEUED_CONTENT_PREFIX}${originalContent}`,
    },
  };
}

/** Deliver stale queued notifications and remove only successfully drained lines. */
export async function drainEvents(
  root: string,
  deliver: (event: QueuedEvent) => void | Promise<void>,
  currentPid = process.pid,
): Promise<number> {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let delivered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const eventPath = join(root, entry.name, "events.ndjson");
    if (!existsSync(eventPath)) continue;
    const drainingPath = `${eventPath}.draining-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      renameSync(eventPath, drainingPath);
    } catch {
      continue;
    }

    let lines: string[];
    try {
      lines = readFileSync(drainingPath, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
    } catch {
      try { renameSync(drainingPath, eventPath); } catch { /* leave unreadable file for a later boot */ }
      continue;
    }

    const retained: string[] = [];
    for (const line of lines) {
      let event: QueuedEvent | null;
      try {
        event = parseQueuedEvent(JSON.parse(line));
      } catch {
        event = null;
      }
      if (!event || pidIsAlive(event.pid, currentPid)) {
        retained.push(line);
        continue;
      }
      try {
        await deliver(queuedForDelivery(event));
        delivered += 1;
      } catch (error) {
        console.error("[deleg8] queued notification delivery failed:", error);
        retained.push(line);
      }
    }

    try {
      unlinkSync(drainingPath);
    } catch {
      continue;
    }
    if (retained.length > 0) {
      try {
        appendFileSync(eventPath, retained.join("\n") + "\n", "utf8");
      } catch (error) {
        console.error("[deleg8] could not preserve undelivered queued notifications:", error);
      }
    }
  }
  return delivered;
}
