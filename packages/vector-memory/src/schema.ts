/**
 * SQLite schema for the vector memory store.
 *
 * Tables:
 *  - `entries` — text + metadata, no embedding column.
 *  - `vectors` — (entry_id, provider_id) PK, raw float32 blob.
 *  - `embedding_cache` — provider-level text→vector cache so repeated
 *    `embed()` calls for the same text skip the ONNX forward pass. Keyed
 *    by (content_hash, provider_id, model_dimensions) so a model swap
 *    invalidates only the old provider rows on insert — no mixed-vector
 *    search. Independent of `entries`, so the cache survives entry deletes.
 *  - `schema_meta` — active provider id and dimensions.
 *
 * The vectors table is keyed by (entry_id, provider_id) so a model swap
 * invalidates only the old provider rows on insert — no mixed-vector search.
 */
import type { DatabaseSync } from 'node:sqlite';

export const VECTOR_SCHEMA_VERSION = 2;
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
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_hash ON entries(content_hash)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_entries_updated ON entries(updated_at DESC)');

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

  // Provider-level embedding cache. (content_hash, provider_id, dimensions)
  // is the lookup key; `text` is kept for debugging and so cache entries can
  // be inspected with a plain SQL query. NOT foreign-keyed to `entries` so
  // a delete on entries does not invalidate the cache (the underlying
  // embedding is still valid for the same content_hash).
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      content_hash TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (content_hash, provider_id, dimensions)
    );
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_cache_last_used ON embedding_cache(last_used_at)');

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

/**
 * Upsert a vector into the embedding cache. `use_count` increments on
 * conflict so hot texts can be identified later. `last_used_at` advances
 * to the current timestamp on every hit so LRU eviction has something to
 * read.
 */
export function upsertEmbeddingCache(
  db: DatabaseSync,
  row: {
    contentHash: string;
    providerId: string;
    dimensions: number;
    vector: Buffer;
    text: string;
    now: string;
  },
): void {
  db.prepare(
    `INSERT INTO embedding_cache
       (content_hash, provider_id, dimensions, vector, text, created_at, last_used_at, use_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(content_hash, provider_id, dimensions) DO UPDATE SET
       last_used_at = excluded.last_used_at,
       use_count = embedding_cache.use_count + 1,
       vector = excluded.vector`,
  ).run(row.contentHash, row.providerId, row.dimensions, row.vector, row.text, row.now, row.now);
}

/**
 * Look up a vector in the cache. Returns the decoded vector and bumps
 * `last_used_at` / `use_count` atomically. Returns undefined on miss.
 */
export function lookupEmbeddingCache(
  db: DatabaseSync,
  contentHash: string,
  providerId: string,
  dimensions: number,
  now: string,
): Float32Array | undefined {
  const row = db
    .prepare(
      `SELECT vector FROM embedding_cache
        WHERE content_hash = ? AND provider_id = ? AND dimensions = ?
        LIMIT 1`,
    )
    .get(contentHash, providerId, dimensions) as { vector: Buffer | Uint8Array } | undefined;
  if (!row) return undefined;
  // Best-effort: bump usage counter. Don't fail the read if the UPDATE
  // races with a cache eviction — the read result is already valid.
  try {
    db.prepare(
      `UPDATE embedding_cache SET last_used_at = ?, use_count = use_count + 1
        WHERE content_hash = ? AND provider_id = ? AND dimensions = ?`,
    ).run(now, contentHash, providerId, dimensions);
  } catch {
    /* ignore — cache is advisory */
  }
  return decodeVector(row.vector);
}

/** Encode a Float32Array to a SQLite BLOB (Buffer). */
export function encodeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Decode a SQLite BLOB (Buffer or Uint8Array) back to a Float32Array. */
export function decodeVector(buf: Buffer | Uint8Array): Float32Array {
  // A blob whose length is not a whole number of float32s is corrupt. Without
  // this guard `new Float32Array(3 / 4)` truncates to length 0 rather than
  // throwing, so the corruption reaches cosineSimilarity as a scoreable
  // empty vector instead of being reported. Same message as the guard in
  // vector-codec.ts, which tests/vector-codec.test.ts already pins.
  if (buf.byteLength % 4 !== 0) {
    throw new Error(
      `decodeVector: invalid vector byteLength ${buf.byteLength} (must be a multiple of 4)`,
    );
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const copy = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < copy.length; i++) {
    copy[i] = view.getFloat32(i * 4, true);
  }
  return copy;
}
