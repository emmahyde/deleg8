// End-to-end smoke test for the parent-death cleanup path in server.ts main().
// Spawns the real MCP server as a subprocess (with OMP_BIN pointing at the
// mock-omp script), uses the MCP client to spawn a grandchild agent, then
// SIGTERMs the server and asserts the grandchild dies.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER_PATH = new URL("../src/server.ts", import.meta.url).pathname;
const MOCK_PATH = new URL("./fixtures/mock-omp.ts", import.meta.url).pathname;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

describe("parent-death cleanup", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  test(
    "SIGTERM on the server kills spawned omp grandchildren",
    async () => {
      const logDir = mkdtempSync(join(tmpdir(), "deleg8-death-test-"));
      tempDirs.push(logDir);

      // mock-omp.ts has `#!/usr/bin/env bun` + chmod +x, so OMP_BIN can point
      // directly at it. The server will spawn it with `--mode rpc-ui --session-dir X`;
      // mock-omp ignores the flags it doesn't know.
      const transport = new StdioClientTransport({
        command: "bun",
        args: ["run", SERVER_PATH],
        env: {
          ...(process.env as Record<string, string>),
          OMP_BIN: MOCK_PATH,
          CLAUDE_SESSION_ID: "death-smoke",
          DELEG8_LOG_DIR: logDir,
        },
      });
      const client = new Client({ name: "death-test", version: "0.0.1" });
      await client.connect(transport);

      // Spawn an agent. autoSuspend on turn_end would race the test — but we
      // never send a prompt, so no turn_end happens, and the proc stays alive.
      const spawnRes = await client.callTool({
        name: "pi_spawn",
        arguments: { agent_id: "victim" },
      });
      const spawnText = (spawnRes as any).content?.[0]?.text ?? JSON.stringify((spawnRes as any).structuredContent);
      const spawnData = JSON.parse(spawnText);
      const childPid = spawnData.status.pid;
      expect(typeof childPid).toBe("number");
      expect(isAlive(childPid)).toBe(true);

      // Server PID lives inside the StdioClientTransport — reach in to grab it.
      // (The transport spawns a child via node:child_process and exposes `pid`.)
      const serverPid = (transport as unknown as { pid?: number; _process?: { pid: number } }).pid
        ?? (transport as any)._process?.pid;
      expect(typeof serverPid).toBe("number");

      // Kill the server. Cleanup path should fan SIGKILL to grandchildren.
      process.kill(serverPid as number, "SIGTERM");

      // Server should reap and exit, taking the mock with it.
      await waitFor(() => !isAlive(childPid), 5000);
      expect(isAlive(childPid)).toBe(false);

      // Best-effort: close the client so bun:test doesn't hang on the orphan
      // transport. The server is already gone, so close() may throw.
      try { await client.close(); } catch { /* expected */ }
    },
    15_000,
  );
});
