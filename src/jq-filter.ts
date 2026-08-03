// Shells out to `jq -c <expr>` over stdin/stdout. The agent passes a filter,
// we pipe the structured tool result through jq, and surface either the parsed
// JSON or an error with jq's own diagnostic message.

import { PiAgentError } from "./agent.ts";

export async function jqFilter(input: unknown, expr: string): Promise<unknown> {
  let proc;
  try {
    proc = Bun.spawn(["jq", "-c", expr], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    throw new PiAgentError(`failed to spawn jq (is it installed?): ${(e as Error).message}`);
  }

  const sink = proc.stdin as Bun.FileSink;
  sink.write(JSON.stringify(input));
  await sink.end();

  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new PiAgentError(`jq filter failed (exit ${proc.exitCode}): ${err.trim() || "no diagnostic"}`);
  }

  // jq -c emits one JSON value per line. A scalar/object filter → one line.
  // A streaming filter (`.[]`) → many lines; gather into an array.
  const lines = out.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  if (lines.length === 1) return JSON.parse(lines[0]!);
  return lines.map((l) => JSON.parse(l));
}
