import type { DatabaseSync } from 'node:sqlite';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
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
  if (Ctor === null) throw new Error('SQLite is unavailable in this runtime');
  try {
    Ctor = withSqliteExperimentalWarningSuppressed(loadRuntimeDatabaseSync);
    return Ctor;
  } catch (error) {
    Ctor = null;
    throw new Error(
      'The Chronicle journal needs node:sqlite (Node >= 22.5) or bun:sqlite: ' +
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

/** Below this, an existing database is left in its current vacuum mode. */
const CONVERT_VACUUM_MIN_BYTES = 64 * 1024 * 1024;

/**
 * Above this, conversion is left to the explicit `chronicle compact` path.
 *
 * The conversion runs in the journal constructor, so its cost is a stall
 * before the daemon serves its first append. A gigabyte rewrites in seconds;
 * the multi-gigabyte files this codebase has actually seen -- a 1.47 GB
 * partition, a 12.4 GB corpus -- would stall it for minutes with nothing to
 * tell an operator why. Those are exactly the cases that deserve a deliberate,
 * announced `wstack chronicle compact` instead.
 */
const CONVERT_VACUUM_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** SQLite's numeric code for `PRAGMA auto_vacuum = INCREMENTAL`. */
const INCREMENTAL_AUTO_VACUUM = 2;

/**
 * Put the database in incremental-vacuum mode so freed pages can be handed
 * back to the filesystem instead of sitting on the freelist forever.
 *
 * **Call this before `PRAGMA journal_mode = WAL` and before any CREATE TABLE.**
 * `auto_vacuum` is a header bit SQLite will only accept while the file is still
 * empty *and* still in rollback-journal mode; issued after the WAL switch it is
 * accepted silently and does nothing, which is exactly how the first version of
 * this shipped. The pragma is therefore always read back, and a database that
 * refused it is converted by the only mechanism that can -- a full `VACUUM` --
 * or left alone.
 *
 * Conversion is not free: `VACUUM` rewrites the whole file and needs room for a
 * second copy, so it is spent only where it buys something -- a database that
 * is mostly freelist, or one already large enough that never shrinking is
 * itself the problem -- and never on a file so large the rewrite would stall
 * the daemon past noticing.
 *
 * Without this, `purge()` and the `maxEvents` trim return pages to the freelist
 * and the file keeps its all-time high-water mark. Measured on a live install:
 * a 220 MB `metrics.db` holding 18 MB of live data.
 */
export function ensureIncrementalVacuum(
  db: DatabaseSync,
): 'already' | 'set' | 'converted' | 'skipped' {
  if (autoVacuumMode(db) === INCREMENTAL_AUTO_VACUUM) return 'already';
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  if (autoVacuumMode(db) === INCREMENTAL_AUTO_VACUUM) return 'set';

  const pages = pragmaNumber(db, 'page_count');
  const freelist = pragmaNumber(db, 'freelist_count');
  const bytes = pages * pragmaNumber(db, 'page_size');
  const worthRewriting = freelist > pages / 4 || bytes > CONVERT_VACUUM_MIN_BYTES;
  if (!worthRewriting || bytes > CONVERT_VACUUM_MAX_BYTES) return 'skipped';
  db.exec('VACUUM');
  return autoVacuumMode(db) === INCREMENTAL_AUTO_VACUUM ? 'converted' : 'skipped';
}

function autoVacuumMode(db: DatabaseSync): number {
  return pragmaNumber(db, 'auto_vacuum');
}

function pragmaNumber(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
  return Number(row[name]);
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
