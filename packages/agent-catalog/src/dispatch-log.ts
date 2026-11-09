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
import { safeParse } from '@wrongstack/primitives/safe-json';
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
  /** Leader tool that spawned. Absent on entries written before it was recorded. */
  tool?: 'delegate' | 'spawn_subagent' | undefined;
  /** The spawned worker, so its task outcomes can be joined back at read time. */
  subagentId?: string | undefined;
}

/** How one task of a routed worker ended. */
export type DispatchOutcomeStatus = 'success' | 'failed' | 'timeout' | 'stopped';

/**
 * One finished task of a worker a routing entry spawned. Written as its own
 * line (`kind: 'outcome'`) rather than by rewriting the spawn line, so the log
 * stays append-only; `summarizeDispatchLog` joins the two on `subagentId`.
 * Without it the log said where work went and nothing about whether it went
 * well — a role the dispatcher favours and that keeps failing looked the same
 * as one that keeps delivering.
 */
export interface DispatchOutcomeEntry {
  at: string;
  subagentId: string;
  /** Role as the host knew it; the joined spawn line wins when present. */
  role?: string | undefined;
  status: DispatchOutcomeStatus;
  durationMs?: number | undefined;
  /** Spend of this task alone, not the worker's running total. */
  costUsd?: number | undefined;
  provider?: string | undefined;
  model?: string | undefined;
}

/**
 * Rotate once the file passes this size. Checked with `statSync` rather than by
 * counting lines: a line count costs a full read on *every* append, which turns
 * a constant-time telemetry write into an O(log size) one and shows up as real
 * latency on a fleet that spawns thousands of times a week.
 */
const ROTATE_AT_BYTES = 1_024 * 1_024;
/**
 * Bytes kept after a rotation: half the cap, so rotation is amortised.
 *
 * A byte budget, not a line count. Keeping a fixed 2,500 lines only halved the
 * file while lines averaged under ~420 bytes; a project with long custom role
 * names (or six long alternatives per entry) crossed that, the rotated file
 * stayed above the cap, and every later append paid a full read and rewrite.
 */
const ROTATE_KEEP_BYTES = ROTATE_AT_BYTES / 2;
/** Cap per array field so one pathological entry cannot bloat a line. */
const MAX_LIST_ITEMS = 6;

export function dispatchLogPath(projectRoot?: string): string {
  return path.join(agentsDir(projectRoot), 'dispatch-log.jsonl');
}

function trimList(values: string[] | undefined, exclude?: string): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const deduped = [
    ...new Set(values.filter((v): v is string => typeof v === 'string' && v !== exclude)),
  ].slice(0, MAX_LIST_ITEMS);
  return deduped.length > 0 ? deduped : undefined;
}

/**
 * Append one routing decision. Never throws: telemetry must not be able to
 * fail a spawn, so every filesystem error is swallowed.
 */
export function recordDispatch(entry: DispatchLogEntry, projectRoot?: string): void {
  try {
    const filePath = dispatchLogPath(projectRoot);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const alternatives = trimList(entry.alternatives, entry.role);
    const matched = trimList(entry.matched);
    const validConfidence =
      typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)
        ? Math.max(0, Math.min(1, entry.confidence))
        : undefined;
    const line = `${JSON.stringify({
      at: entry.at,
      role: entry.role,
      source: entry.source,
      ...(entry.method ? { method: entry.method } : {}),
      ...(validConfidence !== undefined
        ? { confidence: Math.round(validConfidence * 1000) / 1000 }
        : {}),
      ...(alternatives ? { alternatives } : {}),
      ...(matched ? { matched } : {}),
      ...(entry.rosterMiss ? { rosterMiss: true } : {}),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.tool ? { tool: entry.tool } : {}),
      ...(entry.subagentId ? { subagentId: entry.subagentId } : {}),
    })}\n`;
    appendLine(filePath, line);
  } catch {
    // Telemetry is best-effort by design.
  }
}

/** Append one task outcome. Never throws, for the same reason as `recordDispatch`. */
export function recordDispatchOutcome(entry: DispatchOutcomeEntry, projectRoot?: string): void {
  try {
    const filePath = dispatchLogPath(projectRoot);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const line = `${JSON.stringify({
      kind: 'outcome',
      at: entry.at,
      subagentId: entry.subagentId,
      ...(entry.role ? { role: entry.role } : {}),
      status: entry.status,
      ...(typeof entry.durationMs === 'number' ? { durationMs: Math.round(entry.durationMs) } : {}),
      ...(typeof entry.costUsd === 'number' && entry.costUsd > 0
        ? { costUsd: Math.round(entry.costUsd * 1_000_000) / 1_000_000 }
        : {}),
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...(entry.model ? { model: entry.model } : {}),
    })}\n`;
    appendLine(filePath, line);
  } catch {
    // Telemetry is best-effort by design.
  }
}

function appendLine(filePath: string, line: string): void {
  appendFileSync(filePath, line, 'utf8');
  rotateIfLarge(filePath);
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
  /** Finished tasks of this role's routed workers, by how they ended. */
  outcomes: Record<DispatchOutcomeStatus, number>;
  /** Spend across those tasks, USD. */
  costUsd: number;
  /** `provider/model` → tasks run on it. */
  models: Record<string, number>;
}

/** Outcome counts under one routing source or method. */
export type DispatchOutcomeCounts = Record<DispatchOutcomeStatus, number>;

export interface DispatchSummary {
  entries: number;
  since: string | null;
  until: string | null;
  totals: {
    bySource: Record<DispatchSource, number>;
    byMethod: Record<DispatchMethodTag, number>;
    /** Spawns whose resolved role had no roster entry. */
    rosterMisses: number;
    /** Task outcomes recorded (joined to a spawn or not). */
    outcomes: number;
    /**
     * Outcomes by how the worker's role was chosen — the question this log
     * exists to answer: does a dispatcher pick deliver as often as an explicit
     * role? Only outcomes whose spawn line is still in the log count here.
     */
    outcomesBySource: Record<DispatchSource, DispatchOutcomeCounts>;
    outcomesByMethod: Record<DispatchMethodTag, DispatchOutcomeCounts>;
  };
  roles: DispatchRoleSummary[];
}

function emptySources(): Record<DispatchSource, number> {
  return { 'explicit-role': 0, description: 0, 'name-only': 0 };
}

function emptyMethods(): Record<DispatchMethodTag, number> {
  return { heuristic: 0, llm: 0, fallback: 0 };
}

function emptyOutcomes(): DispatchOutcomeCounts {
  return { success: 0, failed: 0, timeout: 0, stopped: 0 };
}

const OUTCOME_STATUSES = new Set<string>(['success', 'failed', 'timeout', 'stopped']);

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
    totals: {
      bySource: emptySources(),
      byMethod: emptyMethods(),
      rosterMisses: 0,
      outcomes: 0,
      outcomesBySource: {
        'explicit-role': emptyOutcomes(),
        description: emptyOutcomes(),
        'name-only': emptyOutcomes(),
      },
      outcomesByMethod: {
        heuristic: emptyOutcomes(),
        llm: emptyOutcomes(),
        fallback: emptyOutcomes(),
      },
    },
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
        outcomes: emptyOutcomes(),
        costUsd: 0,
        models: {},
        confidenceSum: 0,
        decided: 0,
      };
      byRole.set(id, row);
    }
    return row;
  };

  const spawnsById = new Map<string, DispatchLogEntry>();
  const outcomes: DispatchOutcomeEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    const parsed = safeParse<DispatchLogEntry & { kind?: string }>(line);
    if (!parsed.ok || !parsed.value) continue;
    if (parsed.value.kind === 'outcome') {
      const outcome = parsed.value as unknown as DispatchOutcomeEntry;
      if (typeof outcome.subagentId === 'string' && OUTCOME_STATUSES.has(outcome.status)) {
        outcomes.push(outcome);
      }
      continue;
    }
    if (typeof parsed.value.role !== 'string') continue;
    const entry = parsed.value;
    if (entry.subagentId) spawnsById.set(entry.subagentId, entry);
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
    if (Object.hasOwn(row.bySource, entry.source)) {
      row.bySource[entry.source] += 1;
      summary.totals.bySource[entry.source] += 1;
    }
    if (entry.method && Object.hasOwn(row.byMethod, entry.method)) {
      row.byMethod[entry.method] += 1;
      summary.totals.byMethod[entry.method] += 1;
    }
    if (typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)) {
      row.confidenceSum += Math.max(0, Math.min(1, entry.confidence));
      row.decided += 1;
    }
    if (entry.rosterMiss) summary.totals.rosterMisses += 1;
    const seenAlt = new Set<string>();
    for (const alternative of entry.alternatives ?? []) {
      if (
        typeof alternative === 'string' &&
        alternative !== entry.role &&
        !seenAlt.has(alternative)
      ) {
        seenAlt.add(alternative);
        accumulator(alternative).runnerUp += 1;
      }
    }
  }

  // Outcomes join after every spawn line is read: a worker's spawn line always
  // precedes its outcomes, but a rotation can cut the spawn and keep the
  // outcome — that one still counts for its role, just not by source.
  for (const outcome of outcomes) {
    const spawn = spawnsById.get(outcome.subagentId);
    const role = spawn?.role ?? outcome.role;
    if (!role) continue;
    summary.totals.outcomes += 1;
    const row = accumulator(role);
    row.outcomes[outcome.status] += 1;
    if (
      typeof outcome.costUsd === 'number' &&
      Number.isFinite(outcome.costUsd) &&
      outcome.costUsd > 0
    ) {
      row.costUsd += outcome.costUsd;
    }
    if (outcome.model) {
      const label = outcome.provider ? `${outcome.provider}/${outcome.model}` : outcome.model;
      row.models[label] = (Object.hasOwn(row.models, label) ? row.models[label]! : 0) + 1;
    }
    if (spawn && Object.hasOwn(summary.totals.outcomesBySource, spawn.source)) {
      summary.totals.outcomesBySource[spawn.source][outcome.status] += 1;
    }
    if (spawn?.method && Object.hasOwn(summary.totals.outcomesByMethod, spawn.method)) {
      summary.totals.outcomesByMethod[spawn.method][outcome.status] += 1;
    }
  }

  summary.roles = [...byRole.values()]
    .map(({ confidenceSum, decided, ...rest }) => ({
      ...rest,
      avgConfidence: decided > 0 ? Math.round((confidenceSum / decided) * 1000) / 1000 : null,
      costUsd: Math.round(rest.costUsd * 1_000_000) / 1_000_000,
    }))
    .sort((a, b) => b.spawns - a.spawns || b.runnerUp - a.runnerUp || a.role.localeCompare(b.role));
  return summary;
}
