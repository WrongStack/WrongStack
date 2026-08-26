import type { DatabaseSync } from 'node:sqlite';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import { withSqliteExperimentalWarningSuppressed } from '../utils/sqlite-warning.js';
import type { ChronicleSignalFamily } from './query.js';
import type { ChronicleEvent } from './types.js';

export const SCHEMA_VERSION = 5;
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

export function ensureMetricsSchema(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  if (version !== 0 && version !== SCHEMA_VERSION) {
    db.exec(
      'DROP TABLE IF EXISTS ingest_state; DROP TABLE IF EXISTS provider_daily;' +
        'DROP TABLE IF EXISTS task_outcomes; DROP TABLE IF EXISTS file_lineage;' +
        'DROP TABLE IF EXISTS token_cost; DROP TABLE IF EXISTS daily_counters;' +
        'DROP TABLE IF EXISTS family_daily; DROP TABLE IF EXISTS agent_daily;' +
        'DROP TABLE IF EXISTS logical_request_daily; DROP TABLE IF EXISTS file_seen_daily;',
    );
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
