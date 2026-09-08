/**
 * Spawn-routing telemetry — how every subagent spawn chose its role.
 *
 * The roster has 75 roles. Measuring which ones get *used* was already
 * possible (`.wrongstack/agents/<role>/learning.json`), but that only counts
 * spawns that reached capture, and it cannot separate the two failure modes
 * that matter:
 *
 *   - the leader never called `spawn_subagent` at all, versus
 *   - it called it and the dispatcher dropped to `DEFAULT_DISPATCH_ROLE`.
 *
 * `dispatchAgent` already computes everything needed to tell them apart
 * (`method`, `confidence`, `alternatives`) and then throws it away. This
 * records it.
 *
 * ## Why append-only JSONL rather than a counter file
 *
 * A project runs many sessions at once (CLI, TUI, WebUI, subagents), all
 * writing the same path. A read-modify-write counter loses updates under that
 * load, which would quietly understate exactly the number we are trying to
 * trust. A single `appendFileSync` of a sub-4KB line is atomic on both
 * platforms, so concurrent writers interleave lines instead of clobbering each
 * other. Aggregation happens at read time.
 *
 * ## What is deliberately NOT recorded
 *
 * The task description never reaches disk. The diagnostic value is in the
 * *matched keywords*, which are catalog-owned text rather than user content — a
 * role that keeps losing on a keyword it should have won is the thing worth
 * seeing, and it costs no privacy to keep.
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
import { safeParse } from '../../utils/safe-json.js';
import { agentsDir } from './project-agent-paths.js';

/** How the caller addressed the spawn — before dispatch had any say. */
export type DispatchSource =
  /** Caller passed `role`; dispatch was skipped entirely. */
  | 'explicit-role'
  /** Caller passed `description`; the dispatcher chose. */
  | 'description'
  /** Caller passed neither; a bare `name` config was used. */
  | 'name-only';

/** Which dispatch stage decided. Absent when dispatch did not run. */
export type DispatchMethodTag = 'heuristic' | 'llm' | 'fallback';

export interface DispatchLogEntry {
  /** ISO 8601. */
  at: string;
  /** Role the spawn actually used. */
  role: string;
  source: DispatchSource;
  method?: DispatchMethodTag | undefined;
  /** 0..1 heuristic margin. Absent when dispatch did not run. */
  confidence?: number | undefined;
  /** Runner-up roles the dispatcher passed over, best-first. */
  alternatives?: string[] | undefined;
  /** Catalog keywords that matched. Catalog-owned text, never user content. */
  matched?: string[] | undefined;
  /** The resolved role had no roster entry; a catalog template was used. */
  rosterMiss?: boolean | undefined;
  /** Session that spawned, so a burst can be attributed to one run. */
  sessionId?: string | undefined;
}

/**
 * Rotate once the file passes this size. Checked with `statSync` rather than by
 * counting lines: a line count costs a full read on *every* append, which turns
 * a constant-time telemetry write into an O(log size) one and shows up as real
 * latency on a fleet that spawns thousands of times a week.
 */
const ROTATE_AT_BYTES = 1_024 * 1_024;
/** Lines kept after a rotation. Roughly half the cap, so rotation is amortised. */
const ROTATE_KEEP_LINES = 2_500;
/** Cap per array field so one pathological entry cannot bloat a line. */
const MAX_LIST_ITEMS = 6;

export function dispatchLogPath(projectRoot?: string): string {
  return path.join(agentsDir(projectRoot), 'dispatch-log.jsonl');
}

function trimList(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.slice(0, MAX_LIST_ITEMS);
}

/**
 * Append one routing decision. Never throws: telemetry must not be able to
 * fail a spawn, so every filesystem error is swallowed.
 */
export function recordDispatch(entry: DispatchLogEntry, projectRoot?: string): void {
  try {
    const filePath = dispatchLogPath(projectRoot);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const alternatives = trimList(entry.alternatives);
    const matched = trimList(entry.matched);
    const line = `${JSON.stringify({
      at: entry.at,
      role: entry.role,
      source: entry.source,
      ...(entry.method ? { method: entry.method } : {}),
      ...(typeof entry.confidence === 'number'
        ? { confidence: Math.round(entry.confidence * 1000) / 1000 }
        : {}),
      ...(alternatives ? { alternatives } : {}),
      ...(matched ? { matched } : {}),
      ...(entry.rosterMiss ? { rosterMiss: true } : {}),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    })}\n`;
    appendFileSync(filePath, line, 'utf8');
    rotateIfLarge(filePath);
  } catch {
    // Telemetry is best-effort by design.
  }
}

/**
 * Rotate in place once the log grows past the size cap. The `statSync` guard
 * runs on every append and the full read only after it trips.
 */
function rotateIfLarge(filePath: string): void {
  try {
    if (statSync(filePath).size <= ROTATE_AT_BYTES) return;
    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    const kept = lines.slice(-ROTATE_KEEP_LINES);
    const temporaryPath = `${filePath}.rotate.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${kept.join('\n')}\n`, 'utf8');
    renameSync(temporaryPath, filePath);
  } catch {
    // A failed rotation only means the log stays long.
  }
}

export interface DispatchRoleSummary {
  role: string;
  /** Spawns that ended up on this role. */
  spawns: number;
  bySource: Record<DispatchSource, number>;
  byMethod: Record<DispatchMethodTag, number>;
  /**
   * Times this role was a runner-up the dispatcher passed over. A role with a
   * high `runnerUp` and zero `spawns` is losing ties, not going unseen — a
   * different problem from a role nothing ever scores against, and it needs a
   * different fix.
   */
  runnerUp: number;
  /** Mean heuristic confidence across the spawns dispatch decided. */
  avgConfidence: number | null;
  lastAt: string | null;
}

export interface DispatchSummary {
  entries: number;
  since: string | null;
  until: string | null;
  totals: {
    bySource: Record<DispatchSource, number>;
    byMethod: Record<DispatchMethodTag, number>;
    /** Spawns whose resolved role had no roster entry. */
    rosterMisses: number;
  };
  roles: DispatchRoleSummary[];
}

function emptySources(): Record<DispatchSource, number> {
  return { 'explicit-role': 0, description: 0, 'name-only': 0 };
}

function emptyMethods(): Record<DispatchMethodTag, number> {
  return { heuristic: 0, llm: 0, fallback: 0 };
}

interface RoleAccumulator extends DispatchRoleSummary {
  confidenceSum: number;
  decided: number;
}

/**
 * Aggregate the log. Malformed lines are skipped rather than failing the read —
 * a partially-flushed final line from a killed process must not blind the whole
 * report.
 */
export function summarizeDispatchLog(projectRoot?: string): DispatchSummary {
  const summary: DispatchSummary = {
    entries: 0,
    since: null,
    until: null,
    totals: { bySource: emptySources(), byMethod: emptyMethods(), rosterMisses: 0 },
    roles: [],
  };
  let raw: string;
  try {
    raw = readFileSync(dispatchLogPath(projectRoot), 'utf8');
  } catch {
    return summary;
  }

  const byRole = new Map<string, RoleAccumulator>();
  const accumulator = (id: string): RoleAccumulator => {
    let row = byRole.get(id);
    if (!row) {
      row = {
        role: id,
        spawns: 0,
        bySource: emptySources(),
        byMethod: emptyMethods(),
        runnerUp: 0,
        avgConfidence: null,
        lastAt: null,
        confidenceSum: 0,
        decided: 0,
      };
      byRole.set(id, row);
    }
    return row;
  };

  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    const parsed = safeParse<DispatchLogEntry>(line);
    if (!parsed.ok || !parsed.value || typeof parsed.value.role !== 'string') continue;
    const entry = parsed.value;
    summary.entries += 1;
    if (typeof entry.at === 'string') {
      if (!summary.since || entry.at < summary.since) summary.since = entry.at;
      if (!summary.until || entry.at > summary.until) summary.until = entry.at;
    }
    const row = accumulator(entry.role);
    row.spawns += 1;
    if (typeof entry.at === 'string' && (!row.lastAt || entry.at > row.lastAt)) {
      row.lastAt = entry.at;
    }
    if (entry.source in row.bySource) {
      row.bySource[entry.source] += 1;
      summary.totals.bySource[entry.source] += 1;
    }
    if (entry.method && entry.method in row.byMethod) {
      row.byMethod[entry.method] += 1;
      summary.totals.byMethod[entry.method] += 1;
    }
    if (typeof entry.confidence === 'number') {
      row.confidenceSum += entry.confidence;
      row.decided += 1;
    }
    if (entry.rosterMiss) summary.totals.rosterMisses += 1;
    for (const alternative of entry.alternatives ?? []) {
      if (typeof alternative === 'string' && alternative !== entry.role) {
        accumulator(alternative).runnerUp += 1;
      }
    }
  }

  summary.roles = [...byRole.values()]
    .map(({ confidenceSum, decided, ...rest }) => ({
      ...rest,
      avgConfidence: decided > 0 ? Math.round((confidenceSum / decided) * 1000) / 1000 : null,
    }))
    .sort((a, b) => b.spawns - a.spawns || b.runnerUp - a.runnerUp || a.role.localeCompare(b.role));
  return summary;
}
