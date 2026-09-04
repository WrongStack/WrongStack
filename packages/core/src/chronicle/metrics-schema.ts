import type { DatabaseSync } from 'node:sqlite';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import { withSqliteExperimentalWarningSuppressed } from '../utils/sqlite-warning.js';
import type { ChronicleSignalFamily } from './query.js';
import type { ChronicleEvent } from './types.js';

export const SCHEMA_VERSION = 6;
export const READ_CHUNK_BYTES = 1024 * 1024;
export const SQLITE_SOURCE_PREFIX = 'sqlite:';
export const SQLITE_INGEST_BATCH = 2_000;

export const EMPTY_FAMILIES: Record<ChronicleSignalFamily, number> = {
  llm: 0,
  agent: 0,
  tool: 0,
  file: 0,
  memory: 0,
  task: 0,
  decision: 0,
  runtime: 0,
  finding: 0,
};

export interface ChronicleMetricsRefreshResult {
  ingestedEvents: number;
  ingestedBytes: number;
  sourceFiles: number;
  invalidLines: number;
}

export interface ChronicleProviderDailyRow {
  day: string;
  providerId: string;
  modelId: string;
  attempts: number;
  completed: number;
  failed: number;
  retries: number;
  fallbacks: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  avgDurationMs: number;
  maxDurationMs: number;
}

/** A row of {@link ChronicleMetricsStore.underusedTools}. */
export interface ChronicleUnderusedToolRow {
  toolName: string;
  invocations: number;
  failures: number;
  durationMsTotal: number;
  lastInvokedAt: number | null;
  daysSinceLastUse: number | null;
}

export interface ChronicleTaskOutcomeRow {
  taskId: string;
  runId: string;
  boardId: string;
  sessionId: string;
  agentId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  retries: number;
  verificationFailures: number;
  filesTouched: number;
}

export interface ChronicleFileLineageRow {
  path: string;
  operation: string;
  occurredAt: string;
  sessionId: string;
  agentId: string;
  taskId: string;
  boardId: string;
  runId: string;
  toolName: string;
  providerId: string;
  modelId: string;
  logicalRequestId: string;
  promptManifestId: string;
  provenanceConfidence: 'explicit' | 'correlated' | 'inferred' | 'unknown';
  source: string;
}

export interface ChronicleMetricsSummary {
  providers: { attempts: number; completed: number; failed: number; successRate: number };
  tasks: Record<string, number>;
  files: { mutations: number; uniquePaths: number };
  estimatedCostUsd: number;
}

let Ctor: typeof DatabaseSync | null | undefined;

export function loadDatabaseSync(): typeof DatabaseSync {
  if (Ctor) return Ctor;
  if (Ctor === null) throw new Error('SQLite is unavailable in this runtime');
  try {
    Ctor = withSqliteExperimentalWarningSuppressed(loadRuntimeDatabaseSync);
    return Ctor;
  } catch (error) {
    Ctor = null;
    throw new Error(
      'Chronicle metrics need node:sqlite (Node >= 22.5) or bun:sqlite: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

export function isChronicleMetricsAvailable(): boolean {
  try {
    loadDatabaseSync();
    return true;
  } catch {
    return false;
  }
}

/**
 * Tables holding one row per observed event, and the column that dates them.
 *
 * These are the only tables pruned. Everything else in this schema is a daily
 * aggregate keyed by `day` that stays for as long as the file does, and that
 * asymmetry *is* the data diet: `file_lineage` answers "which session and task
 * changed this file", a question only ever asked about recent work, and was
 * measured at 31k rows against the 48 rows of `provider_daily` covering the
 * same period.
 *
 * `file_seen_daily` is deliberately absent. It looks like per-event detail but
 * it is a distinct-set: `summary()` counts `DISTINCT path_key` over it, so
 * pruning it would silently change a historical number rather than drop
 * redundancy.
 *
 * `file_lineage` dates rows by `occurred_at`, a full ISO-8601 timestamp, which
 * compares correctly against a `YYYY-MM-DD` cutoff precisely because ISO-8601
 * sorts lexicographically.
 */
const ROW_LEVEL_TABLES: ReadonlyArray<{ table: string; dayColumn: string }> = [
  { table: 'file_lineage', dayColumn: 'occurred_at' },
  { table: 'logical_request_daily', dayColumn: 'day' },
];

/** Every table this schema owns, in drop order. */
const ALL_TABLES = [
  'ingest_state',
  'provider_daily',
  'task_outcomes',
  'file_lineage',
  'token_cost',
  'daily_counters',
  'family_daily',
  'agent_daily',
  'logical_request_daily',
  'file_seen_daily',
  'tool_daily',
] as const;

/**
 * Drop row-level detail older than `retentionDays`, keeping every aggregate.
 *
 * The window is measured from the newest row the store holds, not from the
 * wall clock. This store is derived from the journal, so "the last 30 days"
 * most usefully means the last 30 days *of recorded activity*: a project left
 * alone for two months should still be able to answer what changed in it, and
 * making the contents a pure function of the journal keeps a refresh
 * deterministic instead of dependent on when it happened to run.
 *
 * Returns the number of rows removed. Callers run this on the same cadence as
 * ingest; it is idempotent, and the deletes are range scans over the date
 * column each table is keyed or indexed by.
 */
export function pruneMetricsRowDetail(db: DatabaseSync, retentionDays: number): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const newest = newestRowDay(db);
  if (!newest) return 0;
  const cutoffDay = new Date(Date.parse(`${newest}T00:00:00.000Z`) - retentionDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  let deleted = 0;
  for (const { table, dayColumn } of ROW_LEVEL_TABLES) {
    const before = Number(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${dayColumn} < ?`).get(cutoffDay) as {
          n: number;
        }
      ).n,
    );
    if (before === 0) continue;
    db.prepare(`DELETE FROM ${table} WHERE ${dayColumn} < ?`).run(cutoffDay);
    deleted += before;
  }
  if (deleted > 0) {
    try {
      db.exec('PRAGMA incremental_vacuum(2048)');
    } catch {
      // Not in incremental mode -- pages stay on the freelist for reuse.
    }
  }
  return deleted;
}

/** Latest `YYYY-MM-DD` any row-level table carries, or undefined when empty. */
function newestRowDay(db: DatabaseSync): string | undefined {
  let newest: string | undefined;
  for (const { table, dayColumn } of ROW_LEVEL_TABLES) {
    const row = db.prepare(`SELECT MAX(${dayColumn}) AS day FROM ${table}`).get() as {
      day: string | null;
    };
    const day = row.day?.slice(0, 10);
    if (day && (!newest || day > newest)) newest = day;
  }
  return newest;
}

export function ensureMetricsSchema(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  if (version !== 0 && version !== SCHEMA_VERSION) {
    db.exec(ALL_TABLES.map((table) => `DROP TABLE IF EXISTS ${table};`).join(''));
    // A schema bump discards the entire derived corpus. Measured on a live
    // install this left 202 MB of a 220 MB file on the freelist, never
    // returned: the store is a rebuildable cache, so the pages are handed
    // straight back rather than kept for a re-ingest that reuses none of the
    // old row layout. VACUUM (not incremental) because the drop happens once,
    // at open, on a database nothing else has a handle on yet.
    try {
      db.exec('VACUUM');
    } catch {
      // A concurrent reader can block the rewrite; the freelist is reused by
      // the re-ingest either way.
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_state (
      file TEXT PRIMARY KEY,
      bytes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_daily (
      day TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      retries INTEGER NOT NULL DEFAULT 0,
      fallbacks INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms_total REAL NOT NULL DEFAULT 0,
      duration_ms_max REAL NOT NULL DEFAULT 0,
      duration_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, provider_id, model_id)
    );
    CREATE TABLE IF NOT EXISTS task_outcomes (
      task_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL DEFAULT '',
      board_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'started',
      started_at TEXT,
      ended_at TEXT,
      duration_ms REAL,
      retries INTEGER NOT NULL DEFAULT 0,
      verification_failures INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS file_lineage (
      event_id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      path_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT '',
      task_id TEXT NOT NULL DEFAULT '',
      board_id TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      tool_name TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      logical_request_id TEXT NOT NULL DEFAULT '',
      prompt_manifest_id TEXT NOT NULL DEFAULT '',
      provenance_confidence TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_file_lineage_path ON file_lineage(path_key, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_file_lineage_task ON file_lineage(task_id);
    -- Latest cumulative token snapshot per (project, session, agent) scope.
    -- token.accounted carries a running total, so last-write-wins is the
    -- correct reduction; the WHERE guard on ingest keeps it order-independent.
    --
    -- The token columns exist because cost alone was unusable: subscription
    -- providers price at 0, so a table holding only cost reported nothing for
    -- most real sessions while the token counts it was derived from were
    -- discarded. provider/model are recorded for the same reason the session
    -- journal now stamps them on llm_response: a spend row that cannot name
    -- the model it paid for cannot be attributed.
    CREATE TABLE IF NOT EXISTS token_cost (
      scope_key TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      cost REAL NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_token_cost_model ON token_cost(provider, model);
    CREATE TABLE IF NOT EXISTS daily_counters (
      day TEXT PRIMARY KEY,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      completed_tools INTEGER NOT NULL DEFAULT 0,
      failed_tools INTEGER NOT NULL DEFAULT 0,
      tool_duration_ms_total REAL NOT NULL DEFAULT 0,
      tool_duration_ms_max REAL NOT NULL DEFAULT 0,
      tool_duration_count INTEGER NOT NULL DEFAULT 0,
      processes INTEGER NOT NULL DEFAULT 0,
      failed_processes INTEGER NOT NULL DEFAULT 0,
      file_events_all INTEGER NOT NULL DEFAULT 0,
      decisions INTEGER NOT NULL DEFAULT 0,
      escalations INTEGER NOT NULL DEFAULT 0,
      agent_events INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      cancellations INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS family_daily (
      day TEXT NOT NULL,
      family TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, family)
    );
    CREATE TABLE IF NOT EXISTS agent_daily (day TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY (day, agent_id));
    CREATE TABLE IF NOT EXISTS logical_request_daily (day TEXT NOT NULL, logical_request_id TEXT NOT NULL, PRIMARY KEY (day, logical_request_id));
    CREATE TABLE IF NOT EXISTS file_seen_daily (day TEXT NOT NULL, path_key TEXT NOT NULL, PRIMARY KEY (day, path_key));
    -- Per-tool daily rollup for the auto-thinning pipeline. Distinct from
    -- daily_counters (which is name-agnostic): this is keyed by tool_name so
    -- underusedTools() can pick candidates without scanning the journal.
    CREATE TABLE IF NOT EXISTS tool_daily (
      day TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      invocations INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      duration_ms_total REAL NOT NULL DEFAULT 0,
      duration_ms_max REAL NOT NULL DEFAULT 0,
      last_invoked_at INTEGER,
      PRIMARY KEY (day, tool_name)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_daily_name ON tool_daily(tool_name, day);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

export function eventDay(event: ChronicleEvent): string {
  return (event.occurredAt ?? event.observedAt).slice(0, 10);
}

export function durationMs(event: ChronicleEvent): number {
  const value = Number(event.durationNs ?? 0) / 1_000_000;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function numberOrDuration(
  event: ChronicleEvent,
  attributes: Record<string, unknown>,
): number {
  const explicit = attributes.durationMs;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  return durationMs(event);
}

export function numberAt(event: ChronicleEvent, dotPath: string): number {
  const value = readPath(event.attributes ?? {}, dotPath);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function readPath(value: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[part]
          : undefined,
      value,
    );
}

export function stringAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function clampLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), 10_000);
}

export function normalizeKey(value: string): string {
  return value.replaceAll('\\', '/');
}

export function normalizePathKey(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}
