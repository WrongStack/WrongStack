import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { withSqliteExperimentalWarningSuppressed } from '../utils/index.js';
import type { ChronicleEvent } from './types.js';

export const CHRONICLE_SQLITE_FILE = 'chronicle.sqlite';
export const LEGACY_JSONL_MIGRATION_KEY = 'legacy-jsonl-v1';
export const LEGACY_JSONL_QUARANTINE_KEY = 'legacy-jsonl-v1:quarantine';
export const LEGACY_JSONL_BOUNDARY_KEY = 'legacy-jsonl-v1:boundary';

export const SCHEMA_VERSION = 3;

let Ctor: typeof DatabaseSync | null | undefined;

export function loadDatabaseSync(): typeof DatabaseSync {
  if (Ctor) return Ctor;
  if (Ctor === null) throw new Error('node:sqlite is unavailable in this runtime');
  try {
    Ctor = withSqliteExperimentalWarningSuppressed(
      () =>
        (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
          .DatabaseSync,
    );
    return Ctor;
  } catch (error) {
    Ctor = null;
    throw new Error(
      "The Chronicle journal needs Node's built-in SQLite (node:sqlite, Node >= 22.5): " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

export interface ProjectedRow {
  occurredAt: string;
  outcome: string | null;
  projectId: string | null;
  sessionId: string | null;
  agentId: string | null;
  taskId: string | null;
  traceId: string | null;
  logicalRequestId: string | null;
  promptManifestId: string | null;
  resourceKind: string | null;
  resourceId: string | null;
  resourcePath: string | null;
  durationNs: string | null;
}

export function projectEvent(event: ChronicleEvent): ProjectedRow {
  const occurredAt = event.occurredAt ?? event.observedAt;
  return {
    occurredAt,
    outcome: event.outcome ?? null,
    projectId: event.scope.projectId ?? null,
    sessionId: event.scope.sessionId ?? null,
    agentId: event.scope.agentId ?? null,
    taskId: event.scope.taskId ?? null,
    traceId: event.correlation?.traceId ?? null,
    logicalRequestId: event.correlation?.logicalRequestId ?? null,
    promptManifestId: event.correlation?.promptManifestId ?? null,
    resourceKind: event.resource?.kind ?? null,
    resourceId: event.resource?.id ?? null,
    resourcePath: event.resource?.path ?? null,
    durationNs: event.durationNs ?? null,
  };
}

export function ensureChronicleSchema(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      day                TEXT NOT NULL,
      sequence           INTEGER NOT NULL,
      event_id           TEXT NOT NULL UNIQUE,
      hash               TEXT NOT NULL,
      previous_hash      TEXT NOT NULL,
      occurred_at        TEXT NOT NULL,
      event_type         TEXT NOT NULL,
      outcome            TEXT,
      project_id         TEXT,
      session_id         TEXT,
      agent_id           TEXT,
      task_id            TEXT,
      trace_id           TEXT,
      logical_request_id TEXT,
      prompt_manifest_id TEXT,
      resource_kind      TEXT,
      resource_id        TEXT,
      resource_path      TEXT,
      duration_ns        TEXT,
      payload            TEXT NOT NULL,
      PRIMARY KEY (day, sequence)
    );
    CREATE INDEX IF NOT EXISTS events_occurred_at ON events(occurred_at);
    CREATE INDEX IF NOT EXISTS events_type_outcome ON events(event_type, outcome);
    CREATE INDEX IF NOT EXISTS events_session ON events(session_id, day, sequence);
    CREATE INDEX IF NOT EXISTS events_trace ON events(trace_id);
    CREATE INDEX IF NOT EXISTS events_logical_request ON events(logical_request_id);

    CREATE TABLE IF NOT EXISTS chain_checkpoint (
      day      TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      hash     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chronicle_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  if (version < 2) {
    db.exec('DROP INDEX IF EXISTS events_resource_path');
  }
  if (version > 0 && version < 3) {
    db.exec('ALTER TABLE events ADD COLUMN prompt_manifest_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS events_prompt_manifest ON events(prompt_manifest_id)');
  if (version !== SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}
