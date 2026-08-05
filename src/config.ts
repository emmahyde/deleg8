// deleg8 — loads `.claude/deleg8.local.md` (project) or `~/.claude/deleg8.local.md`
// (global), documented in README.md's Configuration section but never previously
// wired up: nothing in server.ts read this file before now.
//
// Deliberately NOT a general YAML parser — the documented shape is fixed and
// shallow (one optional string, one optional two-field object), so a small
// hand-rolled line parser avoids pulling in a dependency for two keys.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelSpec {
  provider: string;
  modelId: string;
}

export interface Deleg8Config {
  ompBin?: string;
  defaultModel?: ModelSpec;
}

/** Project config (relative to `cwd`) takes precedence over the global one. */
function configPath(cwd: string): string | null {
  const project = join(cwd, ".claude", "deleg8.local.md");
  if (existsSync(project)) return project;
  const global = join(homedir(), ".claude", "deleg8.local.md");
  if (existsSync(global)) return global;
  return null;
}

/** Extracts the `---`-delimited frontmatter block; null if the file has none. */
function extractFrontmatter(source: string): string | null {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return match ? match[1] : null;
}

/**
 * Parses the two documented top-level keys out of frontmatter YAML:
 *
 *   omp_bin: /opt/homebrew/bin/omp
 *   default_model:
 *     provider: deepseek
 *     modelId: deepseek-v4-pro
 *
 * Unknown keys are ignored. Malformed `default_model` (missing either field)
 * is dropped rather than partially applied — a spawn call with a half-formed
 * model spec would fail confusingly deep inside `setModel`.
 */
export function parseDeleg8Frontmatter(source: string): Deleg8Config {
  const fm = extractFrontmatter(source);
  if (!fm) return {};

  const lines = fm.split(/\r?\n/);
  const config: Deleg8Config = {};
  let provider: string | undefined;
  let modelId: string | undefined;
  let inDefaultModel = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;

    const indented = /^\s/.test(rawLine) && rawLine.trim() !== "";
    if (inDefaultModel && !indented) inDefaultModel = false;

    if (!indented) {
      const topMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!topMatch) continue;
      const [, key, value] = topMatch;
      if (key === "omp_bin" && value) {
        config.ompBin = stripQuotes(value.trim());
      } else if (key === "default_model") {
        inDefaultModel = true;
      }
      continue;
    }

    if (inDefaultModel) {
      const nested = line.match(/^\s*(provider|modelId):\s*(.+)$/);
      if (!nested) continue;
      const value = stripQuotes(nested[2].trim());
      if (nested[1] === "provider") provider = value;
      else modelId = value;
    }
  }

  if (provider && modelId) {
    config.defaultModel = { provider, modelId };
  }

  return config;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Loads and parses deleg8.local.md for `cwd`. Returns {} if none is found. */
export function loadDeleg8Config(cwd: string = process.cwd()): Deleg8Config {
  const path = configPath(cwd);
  if (!path) return {};
  try {
    return parseDeleg8Frontmatter(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`[deleg8] failed to read config at ${path}: ${(e as Error).message}`);
    return {};
  }
}
