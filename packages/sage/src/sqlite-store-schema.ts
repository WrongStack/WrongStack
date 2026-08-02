import type { DatabaseSync } from 'node:sqlite';
import { SageCachePragmas } from '@wrongstack/core/utils';

export const SQLITE_SCHEMA_VERSION = 5;
export const LEGACY_JSONL_MIGRATION_KEY = 'legacy_jsonl_migrated';
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

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        text, tags, audience, content='memories', content_rowid='rowid'
      );
    `);
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
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
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
  } catch {
    // FTS5 unavailable; search will use LIKE fallback.
  }

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
