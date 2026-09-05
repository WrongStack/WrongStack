/**
 * VectorMemoryStore — SQLite-backed storage for vector entries.
 *
 * Each `remember` embeds the text via the configured provider and persists
 * both the entry and its vector in a single transaction. `search` embeds
 * the query and ranks entries by cosine similarity in pure JS (O(n·d)),
 * matching the existing `packages/tools/src/codebase-index/vector-search.ts`
 * pattern. The store is deliberately separate from SAGE's SQLite database
 * so the two stores cannot contend on the same file lock.
 *
 * Persistence layers:
 *  - SQLite WAL — handles intra-process concurrency, crash recovery.
 *  - `withFileLock` (core/utils) — wraps mutating ops so two processes
 *    pointing at the same `.db` cannot interleave a read-modify-write.
 *  - Provider-level `embedding_cache` table — same text never re-runs the
 *    ONNX forward pass; keyed by (content_hash, provider_id, dimensions)
 *    so a model swap invalidates only the old provider rows.
 *  - UNIQUE index on `entries.content_hash` — defense-in-depth against any
 *    race that bypasses the pre-check; `remember()` is now idempotent.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withFileLock } from '@wrongstack/core/utils';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import { cosineSimilarity, HashingEmbeddingProvider } from '@wrongstack/sage';

import {
  decodeVector,
  encodeVector,
  initVectorSchema,
  lookupEmbeddingCache,
  upsertEmbeddingCache,
  VECTOR_DIMENSIONS_KEY,
  VECTOR_PROVIDER_KEY,
} from './schema.js';
import type {
  SageSyncReport,
  VectorEntry,
  VectorEntryInput,
  VectorEntryWithVector,
  VectorKind,
  VectorMemoryStoreOptions,
  VectorScope,
  VectorSearchHit,
  VectorSearchOptions,
  VectorStoreStats,
} from './types.js';

/** Default `search` result cap, per the tool schema and the public docs. */
const DEFAULT_SEARCH_LIMIT = 10;

/** Clamp a caller-supplied `limit` to a usable positive integer. */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  const floored = Math.floor(limit);
  return floored < 1 ? DEFAULT_SEARCH_LIMIT : floored;
}

const DEFAULT_DIRECTORY = '.wrongstack/vector-memory';
const DEFAULT_FILENAME = 'vector-memory.db';
/** Default file-lock acquire timeout. 5s is enough for embedding + insert. */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
/** Maximum entries to evict in a single LRU sweep. */
const CACHE_EVICT_BATCH = 256;

export class VectorMemoryStore {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly rootDir: string;
  private readonly provider;
  private closed = false;

  constructor(opts: VectorMemoryStoreOptions) {
    if (!opts.provider) throw new Error('VectorMemoryStore: provider is required');
    if (!opts.projectRoot) throw new Error('VectorMemoryStore: projectRoot is required');
    this.provider = opts.provider;

    const dir = opts.directory ?? DEFAULT_DIRECTORY;
    const filename = opts.filename ?? DEFAULT_FILENAME;
    if (path.isAbsolute(dir)) {
      throw new Error('Vector memory directory must be project-relative.');
    }
    const rootDir = path.resolve(opts.projectRoot, dir);
    const rel = path.relative(path.resolve(opts.projectRoot), rootDir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Vector memory directory must stay inside the project root.');
    }
    fs.mkdirSync(rootDir, { recursive: true });
    this.rootDir = rootDir;
    this.dbPath = path.join(rootDir, filename);
    const Database = loadRuntimeDatabaseSync();
    this.db = new Database(this.dbPath);
    initVectorSchema(this.db);
    this.recordActiveProvider();
  }

  /**
   * Absolute path of the store's data directory (the resolved
   * `opts.directory`, default `.wrongstack/vector-memory`). Hosts use this
   * to place sidecar state (e.g. the first-boot SAGE sync marker) next to
   * the db instead of re-deriving the path and drifting from it.
   */
  get directory(): string {
    return this.rootDir;
  }

  /**
   * Absolute path of the SQLite database file. Hosts use this to take a
   * file-level lock that covers all mutating operations (see
   * `withFileLock(this.dbPath + '.lock', …)`).
   */
  get databasePath(): string {
    return this.dbPath;
  }

  /** The lockfile path used to serialize mutating operations. */
  get lockPath(): string {
    return `${this.dbPath}.lock`;
  }

  get activeProviderId(): string {
    const row = this.db
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get(VECTOR_PROVIDER_KEY) as { value: string } | undefined;
    return row?.value ?? this.provider.id;
  }

  private recordActiveProvider(): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO schema_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(VECTOR_PROVIDER_KEY, this.provider.id);
      this.db
        .prepare(
          `INSERT INTO schema_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(VECTOR_DIMENSIONS_KEY, String(this.provider.dimensions));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  static contentHash(text: string): string {
    return createHash('sha256').update(text.normalize('NFKC').trim()).digest('hex');
  }

  /**
   * Look up a vector for `text` in the provider-level embedding cache.
   * Cache hit returns the cached vector (no ONNX pass). Miss returns
   * `undefined`.
   */
  private cachedVector(text: string, now: string): Float32Array | undefined {
    return lookupEmbeddingCache(
      this.db,
      VectorMemoryStore.contentHash(text),
      this.provider.id,
      this.provider.dimensions,
      now,
    );
  }

  /** Persist `vec` for `text` to the embedding cache. */
  private cacheVector(text: string, vec: Float32Array, now: string): void {
    upsertEmbeddingCache(this.db, {
      contentHash: VectorMemoryStore.contentHash(text),
      providerId: this.provider.id,
      dimensions: vec.length,
      vector: encodeVector(vec),
      text,
      now,
    });
  }

  /**
   * Embed `text`, hitting the provider-level cache first. Cache miss falls
   * through to the configured provider and writes the result back. Returns
   * `undefined` when the provider fails — the caller can persist the entry
   * without a vector (fail-open).
   */
  private async embedWithCache(text: string): Promise<Float32Array | undefined> {
    const now = new Date().toISOString();
    const cached = this.cachedVector(text, now);
    if (cached) return cached;
    try {
      const result = await this.provider.embed([text]);
      const vec = result[0];
      if (vec) this.cacheVector(text, vec, now);
      return vec;
    } catch {
      return undefined;
    }
  }

  /**
   * Look up an existing entry by `content_hash`. Returns `undefined` when
   * the entry is not present. Used by `remember()` to make writes idempotent
   * and by `syncFromSage()` to skip already-indexed SAGE memories.
   */
  findByContentHash(contentHash: string): VectorEntryWithVector | undefined {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM entries WHERE content_hash = ? LIMIT 1')
      .get(contentHash) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const vectorRow = this.db
      .prepare('SELECT * FROM vectors WHERE entry_id = ?')
      .get(row.id as string) as
      | { provider_id: string; dimensions: number; vector: Buffer | Uint8Array }
      | undefined;
    return this.rowToEntry(row, vectorRow);
  }

  /**
   * Look up the entry mirroring a given SAGE memory id (i.e. the entry
   * whose `metadata.sageId` equals `sageId`). Returns `undefined` when
   * no such entry exists. Used by the event-driven mirror to delete
   * vector entries on SAGE delete events (the emitter knows the SAGE
   * id, not the vector entry id).
   *
   * Index lookup is `json_extract(metadata, '$.sageId')` — the metadata
   * column is the JSON blob `syncFromSage` writes, so this avoids a
   * full table scan.
   */
  findBySageId(sageId: string): VectorEntryWithVector | undefined {
    this.assertOpen();
    const row = this.db
      .prepare(
        `SELECT * FROM entries
          WHERE json_extract(metadata, '$.sageId') = ?
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .get(sageId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const vectorRow = this.db
      .prepare('SELECT * FROM vectors WHERE entry_id = ?')
      .get(row.id as string) as
      | { provider_id: string; dimensions: number; vector: Buffer | Uint8Array }
      | undefined;
    return this.rowToEntry(row, vectorRow);
  }

  /**
   * Persist a new entry. Idempotent: if an entry with the same
   * `content_hash` already exists, that entry is returned unchanged
   * instead of inserting a duplicate. Mutating ops are wrapped in
   * `withFileLock` so two processes cannot race the dedup check.
   */
  async remember(input: VectorEntryInput): Promise<VectorEntryWithVector> {
    this.assertOpen();
    if (!input.text || input.text.trim().length === 0) {
      throw new Error('VectorMemoryStore.remember: text must be non-empty');
    }
    return withFileLock(this.lockPath, () => this.rememberUnlocked(input), {
      timeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    });
  }

  private async rememberUnlocked(input: VectorEntryInput): Promise<VectorEntryWithVector> {
    const now = new Date().toISOString();
    const contentHash = VectorMemoryStore.contentHash(input.text);

    // Idempotent path: dedup on content_hash. The UNIQUE index on
    // entries.content_hash is the second line of defense.
    const existing = this.findByContentHash(contentHash);
    if (existing) return existing;

    const metadata = input.metadata ?? {};
    const tags = input.tags ?? [];
    const scope: VectorScope = input.scope ?? 'project';
    const kind: VectorKind = input.kind ?? 'note';
    const id = randomUUID();

    const vector = await this.embedWithCache(input.text);
    const providerId = vector ? this.provider.id : undefined;

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO entries
            (id, text, summary, metadata, tags, scope, kind, content_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.text,
          input.summary ?? null,
          JSON.stringify(metadata),
          JSON.stringify(tags),
          scope,
          kind,
          contentHash,
          now,
          now,
        );
      if (vector && providerId) {
        this.db
          .prepare(
            `INSERT INTO vectors (entry_id, provider_id, dimensions, vector, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(entry_id, provider_id) DO UPDATE SET
               vector = excluded.vector,
               dimensions = excluded.dimensions,
               created_at = excluded.created_at`,
          )
          .run(id, providerId, vector.length, encodeVector(vector), now);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    const result: VectorEntryWithVector = {
      id,
      text: input.text,
      summary: input.summary ?? undefined,
      metadata,
      tags,
      scope,
      kind,
      contentHash,
      createdAt: now,
      updatedAt: now,
      providerId: providerId ?? '',
      dimensions: vector?.length ?? 0,
    };
    if (vector) result.vector = vector;
    return result;
  }

  get(id: string): VectorEntryWithVector | undefined {
    this.assertOpen();
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const vectorRow = this.db.prepare('SELECT * FROM vectors WHERE entry_id = ?').get(id) as
      | { provider_id: string; dimensions: number; vector: Buffer | Uint8Array }
      | undefined;
    return this.rowToEntry(row, vectorRow);
  }

  /** Hard-delete an entry by id. Wrapped in `withFileLock` for cross-process safety. */
  async forget(id: string): Promise<boolean> {
    this.assertOpen();
    return withFileLock(
      this.lockPath,
      async () => {
        this.db.exec('BEGIN');
        try {
          const info = this.db.prepare('DELETE FROM entries WHERE id = ?').run(id);
          this.db.exec('COMMIT');
          return info.changes > 0;
        } catch (e) {
          this.db.exec('ROLLBACK');
          throw e;
        }
      },
      { timeoutMs: DEFAULT_LOCK_TIMEOUT_MS },
    );
  }

  async search(query: string, opts: VectorSearchOptions = {}): Promise<VectorSearchHit[]> {
    this.assertOpen();
    // Normalize before use: the top-k loop below compares against `limit` and
    // assigns `top.length = limit`. A NaN defeats every comparison (n >= NaN
    // and n > NaN are both false), so neither the skip guard nor the
    // truncation fires and the whole corpus is returned; a negative value
    // makes that assignment throw RangeError. Both are reachable from the
    // model-facing `vector_memory_search` tool, whose schema advertises
    // `minimum: 1` but does not enforce it at runtime.
    const limit = normalizeLimit(opts.limit);
    const threshold = opts.threshold ?? 0;
    const includeVectors = opts.includeVectors === true;
    if (typeof query !== 'string' || query.trim().length === 0) return [];

    // Embed the query through the same provider-level cache as writes —
    // repeated identical queries skip the ONNX pass entirely.
    const queryVec = await this.embedWithCache(query);
    if (!queryVec || queryVec.length === 0) return [];

    const providerId = this.provider.id;
    const dimensions = this.provider.dimensions;

    const filters: string[] = ['v.provider_id = ?', 'v.dimensions = ?'];
    const params: Array<string | number> = [providerId, dimensions];
    if (opts.scope !== undefined) {
      filters.push('e.scope = ?');
      params.push(opts.scope);
    }
    if (opts.kind !== undefined) {
      filters.push('e.kind = ?');
      params.push(opts.kind);
    }

    // Two-phase scan. Cosine ranking is exhaustive by construction (there is
    // no ANN index), but only the top `limit` rows are ever returned — so
    // phase 1 reads the *narrowest* row shape that can produce a score
    // (id + vector blob) and phase 2 hydrates only the survivors.
    //
    // The single-phase version selected `e.text`, `e.summary`, `e.metadata`
    // and `e.tags` for every row in the store and ran `rowToEntry` (a
    // two-`JSON.parse` decode) on everything above the threshold — which, at
    // the default `threshold: 0`, means every row. On a mirrored SAGE corpus
    // those columns are the entire memory text: the query allocated the whole
    // corpus as JS strings and parsed every metadata blob to return ten hits.
    const scanRows = this.db
      .prepare(
        `SELECT e.id AS id, v.vector AS vec_blob
           FROM entries e
           JOIN vectors v ON v.entry_id = e.id
          WHERE ${filters.join(' AND ')}`,
      )
      .all(...params) as Array<{ id: string; vec_blob: Buffer | Uint8Array }>;

    // Bounded top-k by insertion into a small array kept in score order.
    // Sorting the full candidate list would be O(n log n) on a list that is
    // discarded except for its head; `limit` is single-digit in every caller.
    const top: Array<{ id: string; score: number; vector: Float32Array }> = [];
    for (const row of scanRows) {
      const vec = decodeVector(row.vec_blob);
      const raw = cosineSimilarity(queryVec, vec);
      const score = Math.max(0, Math.min(1, raw));
      if (score < threshold) continue;
      if (top.length >= limit && score <= (top[top.length - 1]?.score ?? 0)) continue;
      let at = top.length;
      while (at > 0 && (top[at - 1]?.score ?? 0) < score) at--;
      top.splice(at, 0, { id: row.id, score, vector: vec });
      if (top.length > limit) top.length = limit;
    }
    if (top.length === 0) return [];

    // Phase 2 — hydrate the survivors in one statement, then re-emit in the
    // score order established above (SQL `IN` does not preserve it).
    const placeholders = top.map(() => '?').join(',');
    const hydrated = this.db
      .prepare(
        `SELECT id, text, summary, metadata, tags, scope, kind,
                content_hash, created_at, updated_at
           FROM entries WHERE id IN (${placeholders})`,
      )
      .all(...top.map((t) => t.id)) as Array<Record<string, unknown>>;
    const entryById = new Map<string, VectorEntry>();
    for (const row of hydrated) {
      entryById.set(row.id as string, this.rowToEntry(row) as VectorEntry);
    }

    const scored: VectorSearchHit[] = [];
    for (const candidate of top) {
      const entry = entryById.get(candidate.id);
      // A row deleted between the two phases simply drops out; search is
      // advisory and must not fail on a concurrent forget().
      if (!entry) continue;
      const hit: VectorSearchHit = { entry, score: candidate.score, providerId };
      if (includeVectors) hit.vector = candidate.vector;
      scored.push(hit);
    }
    return scored;
  }

  /**
   * Page through entries, newest first.
   *
   * Ordering is `(updated_at, id)` DESC — `updated_at` alone is not unique, so
   * without the id tiebreak two entries written in the same millisecond can
   * swap places between calls and a paging caller silently skips one.
   *
   * Pagination is keyset (`after`), not offset, because the only caller that
   * pages is `forgetStaleSageMirrors`, which *deletes as it walks*. Under
   * `OFFSET` every deletion shifts the remaining rows left and the next page
   * skips exactly as many entries as were removed. Keyset is immune: it
   * resumes from a position, and the rows a deletion removes are ones the
   * sweep has already passed.
   */
  list(
    opts: {
      limit?: number;
      scope?: VectorScope;
      kind?: VectorKind;
      /** Resume after this entry — pass the last row of the previous page. */
      after?: { updatedAt: string; id: string } | undefined;
    } = {},
  ): VectorEntry[] {
    this.assertOpen();
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.scope !== undefined) {
      where.push('scope = ?');
      params.push(opts.scope);
    }
    if (opts.kind !== undefined) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    if (opts.after) {
      where.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      params.push(opts.after.updatedAt, opts.after.updatedAt, opts.after.id);
    }
    const sql = `SELECT * FROM entries ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY updated_at DESC, id DESC LIMIT ?`;
    params.push(opts.limit ?? 100);
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEntry(r) as VectorEntry);
  }

  async reindexAll(): Promise<{ processed: number; errors: number }> {
    this.assertOpen();
    return withFileLock(
      this.lockPath,
      async () => {
        const rows = this.db.prepare('SELECT id, text FROM entries').all() as Array<
          Record<string, unknown>
        >;
        let processed = 0;
        let errors = 0;
        for (const row of rows) {
          try {
            // Bypass the cache during reindex — the goal is to refresh
            // the per-entry vector, even if the cached text-vector is
            // already valid for the same content_hash.
            const result = await this.provider.embed([row.text as string]);
            const v = result[0];
            if (!v) {
              errors++;
              continue;
            }
            const now = new Date().toISOString();
            this.db
              .prepare(
                `INSERT INTO vectors (entry_id, provider_id, dimensions, vector, created_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(entry_id, provider_id) DO UPDATE SET
                   vector = excluded.vector,
                   dimensions = excluded.dimensions,
                   created_at = excluded.created_at`,
              )
              .run(row.id as string, this.provider.id, v.length, encodeVector(v), now);
            // Also refresh the embedding cache so subsequent searches
            // for the same text skip the ONNX pass.
            this.cacheVector(row.text as string, v, now);
            processed++;
          } catch {
            errors++;
          }
        }
        return { processed, errors };
      },
      { timeoutMs: 60_000 },
    );
  }

  stats(): VectorStoreStats {
    this.assertOpen();
    const entryCount = (this.db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number })
      .n;
    const vectorCount = (
      this.db.prepare('SELECT COUNT(*) AS n FROM vectors').get() as { n: number }
    ).n;
    const providerRows = this.db
      .prepare('SELECT DISTINCT provider_id FROM vectors')
      .all() as Array<{ provider_id: string }>;
    return {
      entries: entryCount,
      vectors: vectorCount,
      providers: providerRows.map((r) => r.provider_id),
      modelAvailable: true,
      modelId: this.provider.id,
      dimensions: this.provider.dimensions,
    };
  }

  /**
   * Embedding-cache diagnostics — entries, hit/miss counters, oldest entry.
   * Useful for the WebUI's vector-memory panel and for diagnosing the
   * "why is search slow?" question.
   */
  cacheStats(): {
    entries: number;
    providers: number;
    totalUseCount: number;
    oldestLastUsedAt: string | null;
  } {
    this.assertOpen();
    const entries = (
      this.db.prepare('SELECT COUNT(*) AS n FROM embedding_cache').get() as {
        n: number;
      }
    ).n;
    const providers = (
      this.db.prepare('SELECT COUNT(DISTINCT provider_id) AS n FROM embedding_cache').get() as {
        n: number;
      }
    ).n;
    const totalUseCount = (
      this.db.prepare('SELECT COALESCE(SUM(use_count), 0) AS n FROM embedding_cache').get() as {
        n: number;
      }
    ).n;
    const oldest = this.db.prepare('SELECT MIN(last_used_at) AS t FROM embedding_cache').get() as
      | { t: string | null }
      | undefined;
    return {
      entries,
      providers,
      totalUseCount,
      oldestLastUsedAt: oldest?.t ?? null,
    };
  }

  /**
   * LRU-evict the embedding cache down to `keepMostRecent` rows. The
   * `embedding_cache` table is independent of `entries`, so a sweep here
   * only removes cached vectors — never stored entries. Called by hosts
   * that want to bound cache growth on long-lived processes.
   */
  async evictCache(keepMostRecent: number): Promise<{ removed: number }> {
    this.assertOpen();
    if (keepMostRecent < 0) {
      throw new Error('evictCache: keepMostRecent must be >= 0');
    }
    return withFileLock(
      this.lockPath,
      async () => {
        const total = (
          this.db.prepare('SELECT COUNT(*) AS n FROM embedding_cache').get() as { n: number }
        ).n;
        if (total <= keepMostRecent) return { removed: 0 };
        const toRemove = total - keepMostRecent;
        const stmt = this.db.prepare(
          `DELETE FROM embedding_cache
            WHERE content_hash IN (
              SELECT content_hash FROM embedding_cache
               ORDER BY last_used_at ASC
               LIMIT ?
            )`,
        );
        const info = stmt.run(Math.min(toRemove, CACHE_EVICT_BATCH));
        return { removed: Number(info.changes) };
      },
      { timeoutMs: DEFAULT_LOCK_TIMEOUT_MS },
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('VectorMemoryStore is closed');
  }

  private rowToEntry(
    row: Record<string, unknown>,
    vectorRow?: { provider_id: string; dimensions: number; vector: Buffer | Uint8Array },
  ): VectorEntryWithVector {
    const summaryValue = row.summary as string | null;
    const entry: VectorEntryWithVector = {
      id: row.id as string,
      text: row.text as string,
      summary: summaryValue ?? (undefined as string | undefined),
      metadata: safeParseJson(row.metadata, {}),
      tags: safeParseJson(row.tags, []),
      scope: row.scope as VectorEntry['scope'],
      kind: row.kind as VectorEntry['kind'],
      contentHash: row.content_hash as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      providerId: vectorRow?.provider_id ?? '',
      dimensions: vectorRow?.dimensions ?? 0,
    };
    if (vectorRow?.vector) {
      entry.vector = decodeVector(vectorRow.vector);
    }
    return entry;
  }

  async syncFromSage(sage: SageSyncSource): Promise<SageSyncReport> {
    this.assertOpen();
    // No upper bound: the cursor-walking `SageSyncSource` terminates on
    // `nextCursor: null` (and has its own defensive progress guard). The
    // historical `limit: 5000` silently truncated large projects; the
    // caller's source is now authoritative.
    const memories = await sage.listActiveMemories({ limit: Number.POSITIVE_INFINITY });
    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    const errors: SageSyncReport['errors'] = [];

    for (const memory of memories) {
      try {
        const hash = VectorMemoryStore.contentHash(memory.text);
        const existing = this.findByContentHash(hash);
        if (existing) {
          skipped++;
          continue;
        }
        await this.rememberUnlocked({
          text: memory.text,
          summary: memory.summary ?? undefined,
          metadata: { source: 'sage', sageId: memory.id, ...(memory.metadata ?? {}) },
          tags: memory.tags ?? [],
          scope: 'project',
          kind: 'note',
        });
        indexed++;
      } catch (err) {
        failed++;
        errors.push({ memoryId: memory.id, message: errMsg(err) });
      }
    }
    return { scanned: memories.length, indexed, skipped, failed, errors };
  }
}

export interface SageSyncSource {
  listActiveMemories(opts: { limit: number }): Promise<
    Array<{
      id: string;
      text: string;
      summary?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
    }>
  >;
}

export function fallbackHashingProvider(dimensions: number): HashingEmbeddingProvider {
  return new HashingEmbeddingProvider({ dimensions });
}

function safeParseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
