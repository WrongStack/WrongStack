/**
 * SQLite schema for the vector memory store.
 *
 * Two tables:
 *  - `entries` — text + metadata, no embedding column
 *  - `vectors` — (entry_id, provider_id) PK, raw float32 blob
 *
 * The vectors table is keyed by (entry_id, provider_id) so a model swap
 * invalidates only the old provider rows on insert — no mixed-vector search.
 * A companion `schema_meta` table records the active provider id and dims.
 */
import type { DatabaseSync } from 'node:sqlite';

export const VECTOR_SCHEMA_VERSION = 1;
export const VECTOR_PROVIDER_KEY = 'active_provider_id';
export const VECTOR_DIMENSIONS_KEY = 'active_provider_dimensions';

export function initVectorSchema(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      summary TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      tags TEXT NOT NULL DEFAULT '[]',
      scope TEXT NOT NULL DEFAULT 'project',
      kind TEXT NOT NULL DEFAULT 'note',
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_entries_hash ON entries(content_hash)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_entries_updated ON entries(updated_at DESC)',
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS vectors (
      entry_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (entry_id, provider_id),
      FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
    );
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_vectors_provider ON vectors(provider_id)');

  // Lightweight lexical fallback index — a simple LIKE search over text and
  // tags when the caller explicitly opts in. FTS5 was considered but skipped
  // to keep the schema portable across Node SQLite builds.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      id UNINDEXED, text, tags, content='entries', content_rowid='rowid'
    );
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
      INSERT INTO entries_fts(rowid, text, tags)
      VALUES (new.rowid, new.text, new.tags);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, text, tags)
      VALUES('delete', old.rowid, old.text, old.tags);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
      INSERT INTO entries_fts(entries_fts, rowid, text, tags)
      VALUES('delete', old.rowid, old.text, old.tags);
      INSERT INTO entries_fts(rowid, text, tags)
      VALUES (new.rowid, new.text, new.tags);
    END;
  `);
}

/** Encode a Float32Array to a SQLite BLOB (Buffer). */
export function encodeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Decode a SQLite BLOB (Buffer or Uint8Array) back to a Float32Array. */
export function decodeVector(buf: Buffer | Uint8Array): Float32Array {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const copy = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < copy.length; i++) {
    copy[i] = view.getFloat32(i * 4, true);
  }
  return copy;
}
