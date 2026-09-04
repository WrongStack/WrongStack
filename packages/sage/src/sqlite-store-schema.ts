import type { DatabaseSync } from 'node:sqlite';
import { SageCachePragmas } from '@wrongstack/core/utils';

export const SQLITE_SCHEMA_VERSION = 5;
export const LEGACY_JSONL_MIGRATION_KEY = 'legacy_jsonl_migrated';
const FTS_INDEX_INITIALIZED_KEY = 'fts_index_initialized';
// The audit log is a recent activity trail, not a compliance record.
export const AUDIT_LOG_MAX_ROWS = 1000;
// Prune opportunistically so growth stays bounded without a DELETE on every insert.
export const AUDIT_LOG_PRUNE_INTERVAL = 256;

/** Local command helpers (mirror store-helpers; kept private to SQLite storage). */
export function sqliteNormalizeCommand(command: string): string {
  return command.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function sqliteCommandFamily(command: string): string {
  return command.split(/\s+/).slice(0, 2).join(' ');
}

export function initSchema(db: DatabaseSync): void {
  // WAL + NORMAL is the multi-process sweet spot used across WrongStack SQLite stores.
  // cache_size/temp_store/mmap reduce page-cache thrash on hot read paths.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec('PRAGMA temp_store = MEMORY');
  const cache = SageCachePragmas();
  db.exec(`PRAGMA cache_size = -${cache.cacheSizeKiB}`);
  db.exec(`PRAGMA mmap_size = ${cache.mmapBytes}`);
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      legacy_scope TEXT,
      importance REAL NOT NULL,
      confidence REAL NOT NULL,
      freshness REAL NOT NULL,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      audience TEXT,
      tags TEXT,
      owner_session_id TEXT,
      canonical_text TEXT NOT NULL DEFAULT ''
    );
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_status ON memories(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_kind ON memories(kind)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_scope ON memories(scope)');
  // idx_scope_legacy is created by SqliteSageStore after migrations because
  // existing v3 databases do not have the legacy_scope column yet when
  // initSchema() runs.
  db.exec('CREATE INDEX IF NOT EXISTS idx_importance ON memories(importance DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_updated ON memories(updated_at DESC)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_status_importance_updated ON memories(status, importance DESC, updated_at DESC)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_status_updated_id ON memories(status, updated_at DESC, id DESC)',
  );

  let ftsAvailable = false;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        text, tags, audience, content='memories', content_rowid='rowid'
      );
    `);
    ftsAvailable = true;
  } catch {
    // FTS5 unavailable; search will use LIKE fallback. Do not write the
    // initialization marker so a later FTS-capable runtime retries.
  }

  if (ftsAvailable) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, text, tags, audience)
        VALUES (new.rowid,
          json_extract(new.data, '$.text'),
          COALESCE(new.tags, ''),
          COALESCE(new.audience, ''));
      END;
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, tags, audience)
        VALUES('delete', old.rowid,
          json_extract(old.data, '$.text'),
          COALESCE(old.tags, ''),
          COALESCE(old.audience, ''));
      END;
    `);
    // The WHEN clause is a load-bearing guard, not a micro-optimization.
    // memories_fts indexes exactly three values (text, tags, audience), so a
    // delete+reinsert is only meaningful when one of them actually changed.
    // Without the guard every UPDATE re-indexed the row — and the hottest
    // writers on this table change no indexed value at all:
    // recordSqliteInjection/recordSqliteUse json_set() the injectionCount /
    // useCount / lastAccessedAt keys inside `data` on every injected memory,
    // every tool turn. That paid a full FTS delete+insert (and the WAL frames
    // behind it) per counter bump. Note the guard cannot be expressed as
    // `AFTER UPDATE OF data` — the counter writers do update `data`; only the
    // extracted `$.text` is unchanged.
    //
    // Recreated unconditionally (not IF NOT EXISTS) so databases carrying the
    // earlier unguarded version pick up the WHEN clause. Dropping and
    // recreating a trigger is pure DDL — it does not touch the FTS index.
    db.exec('DROP TRIGGER IF EXISTS memories_au');
    db.exec(`
      CREATE TRIGGER memories_au AFTER UPDATE ON memories
      WHEN json_extract(old.data, '$.text') IS NOT json_extract(new.data, '$.text')
        OR COALESCE(old.tags, '') IS NOT COALESCE(new.tags, '')
        OR COALESCE(old.audience, '') IS NOT COALESCE(new.audience, '')
      BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, tags, audience)
        VALUES('delete', old.rowid,
          json_extract(old.data, '$.text'),
          COALESCE(old.tags, ''),
          COALESCE(old.audience, ''));
        INSERT INTO memories_fts(rowid, text, tags, audience)
        VALUES (new.rowid,
          json_extract(new.data, '$.text'),
          COALESCE(new.tags, ''),
          COALESCE(new.audience, ''));
      END;
    `);
    ensureFtsIndexInitialized(db);
  }

  initRemainingSchema(db);
}

/**
 * Backfill the external-content FTS index once after FTS5 first becomes
 * available for a database. The schema can legitimately predate FTS support:
 * initSchema() used to catch CREATE VIRTUAL TABLE failures and continue with
 * LIKE search, leaving existing memories unindexed when a later runtime added
 * FTS5.
 *
 * The marker is committed in the same transaction as the rebuild. A process
 * that cannot create/use FTS never writes it, so a later capable runtime
 * retries. Rechecking after BEGIN IMMEDIATE makes concurrent initializers a
 * single-writer no-op after the first successful rebuild.
 */
function ensureFtsIndexInitialized(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const initialized = db
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get(FTS_INDEX_INITIALIZED_KEY);
    if (!initialized) {
      db.exec("INSERT INTO memories_fts(memories_fts) VALUES('delete-all')");
      db.exec(`
        INSERT INTO memories_fts(rowid, text, tags, audience)
        SELECT rowid,
          CASE
            WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.text'), '')
            ELSE ''
          END,
          COALESCE(tags, ''),
          COALESCE(audience, '')
        FROM memories
      `);
      db.prepare(
        'INSERT INTO schema_meta (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = 1',
      ).run(FTS_INDEX_INITIALIZED_KEY);
    }
    db.exec('COMMIT');
  } catch (error) {
    // SQLITE_FULL/IOERR auto-rollback leaves no active transaction, so an
    // unguarded ROLLBACK here would throw "cannot rollback - no transaction
    // is active" and mask the primary error. Preserve the original for the
    // caller.
    try {
      db.exec('ROLLBACK');
    } catch {
      /* preserve original error */
    }
    throw error;
  }
}

function initRemainingSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edges (
      from_node TEXT NOT NULL,
      to_node TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      PRIMARY KEY (from_node, to_node, relation)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_edge_from ON edges(from_node)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_edge_to ON edges(to_node)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      at TEXT NOT NULL,
      trace_id TEXT,
      data TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      canonical_text TEXT NOT NULL DEFAULT ''
    );
  `);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_candidates_status_created ON candidates(status, created_at DESC)',
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_edge_to_relation ON edges(to_node, relation)');
}

// ─── Edge-weight policy (unified 2026-08-02) ───────────────────────────────
//
// Every LIVE writer converges on the same ON CONFLICT semantic:
//   `weight = MAX(weight, excluded.weight)`
// so concurrent writers can never ERODE an edge, and idempotent replays are
// stable instead of inflating strength (the pre-2026-08-02 code had three
// semantics: accumulate in SqliteSageStore.addGraphEdge, overwrite in
// syncSqliteAnchorEdges / hygiene supersedes / the JSONL migration, and MAX
// in the recovery edge helper).
//
// Producers still decide the INCOMING weight:
//   - anchor edges (about_* and related_to from syncSqliteAnchorEdges):
//     the memory's current `confidence`. syncSqliteAnchorEdges DELETEs the
//     memory's about_* edges first, so for about_* the conflict branch is a
//     pure cross-process race net and MAX keeps the newer confidence; the
//     related_to structural edges are upserted WITHOUT a delete, so MAX
//     keeps the higher historical confidence (re-syncing a memory whose
//     confidence dropped does not erode the structural weight).
//   - relationship edges (supersedes / contradicts / addGraphEdge):
//     caller-supplied weight (1 for supersedes) — MAX is monotone and
//     idempotent, so repeated identical assertions cannot inflate strength.
//   - the JSONL migration (sqlite-store-jsonl-migration.ts) replays
//     HISTORICAL edges verbatim with `weight = excluded.weight`: the
//     persisted legacy weight is the source of truth for a replay, not a
//     live merge.
//   - the admin/recovery `addRelationshipEdge` helper (sqlite-store-admin.ts)
//     was already MAX and stays MAX.
