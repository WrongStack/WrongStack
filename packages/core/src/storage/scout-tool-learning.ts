/**
 * Which deferred tools a project keeps reaching for through `tool_use`.
 *
 * The Scout identity sends a fixed small tool set and leaves the rest of the
 * catalog behind `tool_search` / `tool_use`. A tool a project calls through
 * that gateway again and again pays a search round trip every time; at the
 * next session start it is promoted into Scout's direct surface instead.
 * Promotion happens only at session start, never mid-session: changing the
 * tool list between turns would invalidate the provider prompt cache.
 *
 * Storage follows the dispatch log: one append-only JSONL file per project in
 * the global project directory (not the repository), written with single
 * `appendFileSync` lines so concurrent sessions interleave rather than lose
 * updates, aggregated at read time, rotated by size. Only the tool name and a
 * timestamp are recorded — never the call's input.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import {
  SCOUT_DIRECT_TOOL_NAMES,
  SCOUT_LEARNED_TOOLS_META_KEY,
} from '../registry/scout-tool-surface.js';

export const SCOUT_TOOL_USE_LOG = 'scout-tool-use.jsonl';

/** Rotation keeps the newest lines once the file passes the cap. */
const ROTATE_AT_BYTES = 256 * 1024;
const ROTATE_KEEP_BYTES = 128 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LearnedScoutToolsOptions {
  /** Only calls newer than this many days count. Default 30. */
  windowDays?: number | undefined;
  /** Calls a tool needs inside the window to be promoted. Default 3. */
  minUses?: number | undefined;
  /** Most tools promoted at once. Default 5. */
  max?: number | undefined;
  /** Names never promoted (already direct, or the gateways themselves). */
  exclude?: ReadonlySet<string> | undefined;
  now?: number | undefined;
}

export function scoutToolUseLogPath(projectDir: string): string {
  return path.join(projectDir, SCOUT_TOOL_USE_LOG);
}

/**
 * Append one gateway call. Never throws: learning is best-effort and must not
 * be able to fail a tool call.
 */
export function recordGatewayToolUse(projectDir: string, tool: string, now = Date.now()): void {
  if (!tool) return;
  try {
    const filePath = scoutToolUseLogPath(projectDir);
    mkdirSync(path.dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify({ at: now, tool })}\n`, 'utf8');
    rotateIfLarge(filePath);
  } catch {
    // Best-effort by design.
  }
}

/**
 * Tools to promote into Scout's direct surface for a new session: called
 * through the gateway at least `minUses` times within the window, most-used
 * first (ties: most recent first), capped at `max`. An unreadable log yields
 * no promotion.
 */
export function readLearnedScoutTools(
  projectDir: string,
  options: LearnedScoutToolsOptions = {},
): string[] {
  const now = options.now ?? Date.now();
  const since = now - (options.windowDays ?? 30) * DAY_MS;
  const minUses = options.minUses ?? 3;
  const max = options.max ?? 5;
  let raw: string;
  try {
    raw = readFileSync(scoutToolUseLogPath(projectDir), 'utf8');
  } catch {
    return [];
  }
  const counts = new Map<string, { uses: number; lastAt: number }>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry: { at?: unknown; tool?: unknown };
    try {
      entry = JSON.parse(line) as { at?: unknown; tool?: unknown };
    } catch {
      continue;
    }
    if (typeof entry.tool !== 'string' || typeof entry.at !== 'number') continue;
    if (entry.at < since || options.exclude?.has(entry.tool)) continue;
    const seen = counts.get(entry.tool) ?? { uses: 0, lastAt: 0 };
    seen.uses++;
    seen.lastAt = Math.max(seen.lastAt, entry.at);
    counts.set(entry.tool, seen);
  }
  return [...counts.entries()]
    .filter(([, seen]) => seen.uses >= minUses)
    .sort(([, a], [, b]) => b.uses - a.uses || b.lastAt - a.lastAt)
    .slice(0, max)
    .map(([tool]) => tool);
}

/**
 * Record every successful `tool_use` gateway call for this project. Hosts
 * attach this once per process; the disposer detaches it.
 */
export function attachScoutToolLearning(events: EventBus, projectDir: string): () => void {
  return events.on('tool.executed', (payload) => {
    if (payload.name !== 'tool_use' || !payload.ok) return;
    const target = (payload.input as { tool?: unknown } | undefined)?.tool;
    if (typeof target === 'string') recordGatewayToolUse(projectDir, target);
  });
}

/**
 * Seed a new conversation's meta with the tools to promote. Scout's fixed set
 * is never promoted (it is already direct). A name not registered yet (an MCP
 * server that connects after boot) is kept: the surface intersects with the
 * registry on every request, and drops spawn-capable tools for a solo session.
 */
export function seedScoutLearnedTools(
  meta: Record<string, unknown>,
  projectDir: string,
  options: Omit<LearnedScoutToolsOptions, 'exclude'> = {},
): readonly string[] {
  const learned = readLearnedScoutTools(projectDir, {
    ...options,
    exclude: SCOUT_DIRECT_TOOL_NAMES,
  });
  if (learned.length > 0) meta[SCOUT_LEARNED_TOOLS_META_KEY] = Object.freeze(learned);
  return learned;
}

function rotateIfLarge(filePath: string): void {
  try {
    if (statSync(filePath).size <= ROTATE_AT_BYTES) return;
    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    const kept: string[] = [];
    let bytes = 0;
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index] as string;
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      if (bytes > ROTATE_KEEP_BYTES && kept.length > 0) break;
      kept.push(line);
    }
    kept.reverse();
    const temporaryPath = `${filePath}.rotate.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${kept.join('\n')}\n`, 'utf8');
    renameSync(temporaryPath, filePath);
  } catch {
    // A failed rotation only means the log stays long.
  }
}
