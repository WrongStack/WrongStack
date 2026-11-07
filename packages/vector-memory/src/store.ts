import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withFileLock } from '@wrongstack/core/utils';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import { HashingEmbeddingProvider } from '@wrongstack/sage';
import { VectorMemoryError, VectorMemoryProviderUnavailableError } from './errors.js';
import {
  encodeVector,
  initVectorSchema,
  lookupEmbeddingCache,
  sageKeyedContentHash,
  upsertEmbeddingCache,
  VECTOR_DIMENSIONS_KEY,
  VECTOR_PROVIDER_KEY,
} from './schema.js';
import {
  evictVectorCache,
  reindexVectorEntries,
  type VectorMaintenanceHost,
  vectorCacheStats,
  vectorEmbeddingCoverage,
  vectorStoreStats,
} from './store-maintenance.js';
import {
  decodeVectorEntry,
  listVectorEntries,
  searchVectorEntries,
  type VectorQueryHost,
} from './store-query.js';
import {
  type SageSyncSource,
  syncSageEntries,
  type VectorSageSyncHost,
} from './store-sage-sync.js';
import {
  assertVectorKind,
  assertVectorScope,
  cloneJsonMetadata,
  DEFAULT_LOCK_TIMEOUT_MS,
  errMsg,
  vectorContentHash,
} from './store-values.js';
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

export type { SageSyncSource } from './store-sage-sync.js';

const DEFAULT_DIRECTORY = '.wrongstack/vector-memory';

const DEFAULT_FILENAME = 'vector-memory.db';

export class VectorMemoryStore {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly rootDir: string;
  private readonly provider;
  private closed = false;

  constructor(opts: VectorMemoryStoreOptions) {
    if (!opts.provider) throw new Error('VectorMemoryStore: provider is required');
    if (
      typeof opts.projectRoot !== 'string' ||
      opts.projectRoot.trim().length === 0 ||
      !path.isAbsolute(opts.projectRoot)
    ) {
      throw new Error('VectorMemoryStore: projectRoot must be a non-empty absolute path');
    }
    if (typeof opts.provider.embed !== 'function') {
      throw new Error('VectorMemoryStore: provider embed must be a function');
    }
    if (typeof opts.provider.id !== 'string' || opts.provider.id.trim().length === 0) {
      throw new Error('VectorMemoryStore: provider id must be a non-empty string');
    }
    if (!Number.isSafeInteger(opts.provider.dimensions) || opts.provider.dimensions < 1) {
      throw new Error('VectorMemoryStore: provider dimensions must be a positive safe integer');
    }
    this.provider = opts.provider;

    const dir = opts.directory === undefined ? DEFAULT_DIRECTORY : opts.directory;
    const filename = opts.filename === undefined ? DEFAULT_FILENAME : opts.filename;
    if (typeof dir !== 'string' || dir.trim().length === 0) {
      throw new Error('Vector memory directory must be a non-empty project-relative path.');
    }
    if (path.isAbsolute(dir)) {
      throw new Error('Vector memory directory must be project-relative.');
    }
    const rootDir = path.resolve(opts.projectRoot, dir);
    const rel = path.relative(path.resolve(opts.projectRoot), rootDir);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error('Vector memory directory must stay inside the project root.');
    }
    fs.mkdirSync(rootDir, { recursive: true });
    this.rootDir = rootDir;
    if (
      typeof filename !== 'string' ||
      filename.trim().length === 0 ||
      path.isAbsolute(filename) ||
      path.basename(filename) !== filename ||
      filename.includes('\0')
    ) {
      throw new Error(
        'Vector memory filename must be a non-empty file name without path segments.',
      );
    }
    this.dbPath = path.join(rootDir, filename);
    const dbRelative = path.relative(rootDir, this.dbPath);
    if (
      dbRelative === '..' ||
      dbRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(dbRelative)
    ) {
      throw new Error('Vector memory database must stay inside its data directory.');
    }
    const Database = loadRuntimeDatabaseSync();
    this.db = new Database(this.dbPath);
    try {
      initVectorSchema(this.db);
      this.recordActiveProvider();
    } catch (error) {
      try {
        this.db.close?.();
      } catch {
        // Preserve the primary initialization error.
      }
      throw error;
    }
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
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // SQLite can end the transaction when a write or COMMIT fails.
        // Preserve the primary database error instead of masking it.
      }
      throw e;
    }
  }

  static contentHash(text: string): string {
    return vectorContentHash(text);
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
   * without a vector (fail-open) — unless `strict`, which throws instead.
   */
  private async embedWithCache(text: string, strict = false): Promise<Float32Array | undefined> {
    const now = new Date().toISOString();
    let cached: Float32Array | undefined;
    try {
      cached = this.cachedVector(text, now);
    } catch {
      // A malformed advisory cache row is a miss; the provider call below
      // repairs it through the normal cache upsert.
    }
    if (cached && cached.length === this.provider.dimensions && cached.every(Number.isFinite)) {
      return cached;
    }
    try {
      const result = await this.provider.embed([text]);
      this.assertOpen();
      const vec = result[0];
      if (vec && vec.length !== this.provider.dimensions) {
        throw new Error(
          `Embedding provider "${this.provider.id}" returned ${vec.length} dimensions; expected ${this.provider.dimensions}.`,
        );
      }
      if (vec && !vec.every(Number.isFinite)) {
        throw new Error(`Embedding provider "${this.provider.id}" returned non-finite values.`);
      }
      if (vec) this.cacheVector(text, vec, now);
      return vec;
    } catch (err) {
      this.assertOpen();
      if (strict) {
        throw new VectorMemoryProviderUnavailableError(
          `Embedding provider "${this.provider.id}" failed: ${errMsg(err)}`,
          err,
        );
      }
      return undefined;
    }
  }

  /**
   * Look up an existing entry by `content_hash`, optionally within a scope.
   * Without a scope, retains the original first-match lookup behavior.
   */
  findByContentHash(contentHash: string, scope?: VectorScope): VectorEntryWithVector | undefined {
    this.assertOpen();
    if (typeof contentHash !== 'string' || !/^[a-f\d]{64}$/i.test(contentHash)) {
      throw new VectorMemoryError(
        'VectorMemoryStore.findByContentHash: contentHash must be a 64-character hex digest',
      );
    }
    if (scope !== undefined) assertVectorScope(scope, 'VectorMemoryStore.findByContentHash');
    const row = (
      scope === undefined
        ? this.db.prepare('SELECT * FROM entries WHERE content_hash = ? LIMIT 1').get(contentHash)
        : this.db
            .prepare('SELECT * FROM entries WHERE content_hash = ? AND scope = ? LIMIT 1')
            .get(contentHash, scope)
    ) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const vectorRow = this.db
      .prepare(
        `SELECT * FROM vectors WHERE entry_id = ?
          ORDER BY (provider_id = ?) DESC, created_at DESC LIMIT 1`,
      )
      .get(row.id as string, this.provider.id) as
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
   * Index lookup is the `CASE WHEN json_valid(metadata) THEN
   * json_extract(metadata, '$.sageId') END` expression declared as an expression
   * index in `initVectorSchema` (schema.ts), so this avoids a full table scan.
   * The two spellings must stay byte-identical in structure: SQLite matches a
   * query against an expression index by comparing the expression trees, so
   * reverting either side to a bare `json_extract` silently drops the lookup
   * back to a whole-corpus walk — and `json_extract` alone also raises on a
   * corrupt `metadata` row instead of returning NULL.
   */
  findBySageId(sageId: string): VectorEntryWithVector | undefined {
    this.assertOpen();
    if (typeof sageId !== 'string' || sageId.trim().length === 0) {
      throw new VectorMemoryError('VectorMemoryStore.findBySageId: sageId must be non-empty');
    }
    const row = this.db
      .prepare(
        `SELECT * FROM entries
          WHERE CASE WHEN json_valid(metadata)
                     THEN json_extract(metadata, '$.sageId')
                END = ?
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .get(sageId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const vectorRow = this.db
      .prepare(
        `SELECT * FROM vectors WHERE entry_id = ?
          ORDER BY (provider_id = ?) DESC, created_at DESC LIMIT 1`,
      )
      .get(row.id as string, this.provider.id) as
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
    if (input.providerId !== undefined && input.providerId !== this.provider.id) {
      throw new VectorMemoryError(
        `Unsupported provider override "${input.providerId}"; active provider is "${this.provider.id}".`,
      );
    }
    if (typeof input.text !== 'string') {
      throw new Error('VectorMemoryStore.remember: text must be a string');
    }
    if (input.text.trim().length === 0) {
      throw new Error('VectorMemoryStore.remember: text must be non-empty');
    }
    if (input.summary !== undefined && typeof input.summary !== 'string') {
      throw new Error('VectorMemoryStore.remember: summary must be a string');
    }
    if (
      input.metadata !== undefined &&
      (typeof input.metadata !== 'object' ||
        input.metadata === null ||
        Array.isArray(input.metadata))
    ) {
      throw new Error('VectorMemoryStore.remember: metadata must be an object');
    }
    if (input.metadata !== undefined) {
      const prototype = Object.getPrototypeOf(input.metadata);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('VectorMemoryStore.remember: metadata must be a plain object');
      }
    }
    if (
      input.tags !== undefined &&
      (!Array.isArray(input.tags) || !input.tags.every((tag) => typeof tag === 'string'))
    ) {
      throw new Error('VectorMemoryStore.remember: tags must be an array of strings');
    }
    if (input.scope !== undefined) assertVectorScope(input.scope, 'VectorMemoryStore.remember');
    if (input.kind !== undefined) assertVectorKind(input.kind, 'VectorMemoryStore.remember');
    const normalizedInput: VectorEntryInput = {
      ...input,
      ...(input.metadata !== undefined ? { metadata: cloneJsonMetadata(input.metadata) } : {}),
      ...(input.tags !== undefined ? { tags: [...input.tags] } : {}),
    };
    return withFileLock(this.lockPath, () => this.rememberUnlocked(normalizedInput), {
      timeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    });
  }

  private async rememberUnlocked(input: VectorEntryInput): Promise<VectorEntryWithVector> {
    this.assertOpen();
    const now = new Date().toISOString();
    let contentHash = VectorMemoryStore.contentHash(input.text);
    const scope: VectorScope = input.scope ?? 'project';

    // Idempotent within each scope; the composite UNIQUE index is the
    // second line of defense across processes.
    let existing = this.findByContentHash(contentHash, scope);
    const sageId = input.metadata?.['sageId'];
    const normalizedSageId =
      typeof sageId === 'string' && sageId.trim().length > 0 ? sageId : undefined;
    // Key by sageId when the rawHash slot belongs to another SAGE memory, or when the
    // rawHash slot is free and this sageId already has a keyed row from an earlier collision.
    if (typeof sageId === 'string' && sageId.length > 0) {
      if (existing && existing.metadata?.['sageId'] !== sageId) {
        contentHash = sageKeyedContentHash(input.text, sageId);
        existing = this.findByContentHash(contentHash, scope);
      } else if (!existing) {
        const keyed = this.findByContentHash(sageKeyedContentHash(input.text, sageId), scope);
        if (keyed) ({ contentHash } = existing = keyed);
      }
    }
    if (existing) {
      if (normalizedSageId !== undefined) {
        this.db
          .prepare(
            `DELETE FROM entries
              WHERE CASE WHEN json_valid(metadata)
                         THEN json_extract(metadata, '$.sageId')
                    END = ?
                AND id != ?`,
          )
          .run(normalizedSageId, existing.id);
      }
      if (
        existing.providerId === this.provider.id &&
        existing.dimensions === this.provider.dimensions &&
        existing.vector
      ) {
        return existing;
      }
      const recoveredVector = await this.embedWithCache(input.text);
      this.assertOpen();
      if (!recoveredVector) {
        const { vector: _staleVector, ...withoutVector } = existing;
        return { ...withoutVector, providerId: '', dimensions: 0 };
      }
      const recoveredAt = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO vectors (entry_id, provider_id, dimensions, vector, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(entry_id, provider_id) DO UPDATE SET
             vector = excluded.vector,
             dimensions = excluded.dimensions,
             created_at = excluded.created_at`,
        )
        .run(
          existing.id,
          this.provider.id,
          recoveredVector.length,
          encodeVector(recoveredVector),
          recoveredAt,
        );
      return {
        ...existing,
        providerId: this.provider.id,
        dimensions: recoveredVector.length,
        vector: recoveredVector,
      };
    }

    const metadata = input.metadata ?? {};
    const tags = input.tags ?? [];
    const kind: VectorKind = input.kind ?? 'note';
    const id = randomUUID();

    const vector = await this.embedWithCache(input.text);
    this.assertOpen();
    const providerId = vector ? this.provider.id : undefined;

    this.db.exec('BEGIN');
    try {
      if (normalizedSageId !== undefined) {
        this.db
          .prepare(
            `DELETE FROM entries
              WHERE CASE WHEN json_valid(metadata)
                         THEN json_extract(metadata, '$.sageId')
                    END = ?
                AND id != ?`,
          )
          .run(normalizedSageId, id);
      }
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
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new VectorMemoryError('VectorMemoryStore.get: id must be a non-empty string');
    }
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const vectorRow = this.db
      .prepare(
        `SELECT * FROM vectors WHERE entry_id = ?
          ORDER BY (provider_id = ?) DESC, created_at DESC LIMIT 1`,
      )
      .get(id, this.provider.id) as
      | { provider_id: string; dimensions: number; vector: Buffer | Uint8Array }
      | undefined;
    return this.rowToEntry(row, vectorRow);
  }

  /** Hard-delete an entry by id without acquiring the lock (caller must hold lock if needed). */
  private forgetUnlocked(id: string): boolean {
    this.assertOpen();
    this.db.exec('BEGIN');
    try {
      const info = this.db.prepare('DELETE FROM entries WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return info.changes > 0;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Hard-delete an entry by id. Wrapped in `withFileLock` for cross-process safety. */
  async forget(id: string): Promise<boolean> {
    this.assertOpen();
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new VectorMemoryError('VectorMemoryStore.forget: id must be a non-empty string');
    }
    return withFileLock(this.lockPath, async () => this.forgetUnlocked(id), {
      timeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    });
  }

  async search(query: string, opts: VectorSearchOptions = {}): Promise<VectorSearchHit[]> {
    return searchVectorEntries(this.queryHost(), query, opts);
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
    return listVectorEntries(this.queryHost(), opts);
  }

  async reindexAll(
    opts: { onlyMissing?: boolean } = {},
  ): Promise<{ processed: number; errors: number }> {
    return reindexVectorEntries(this.maintenanceHost(), opts);
  }

  stats(): VectorStoreStats {
    return vectorStoreStats(this.maintenanceHost());
  }

  /** Coverage usable by this store's search, excluding old providers/dimensions. */
  embeddingCoverage(): { entries: number; covered: number; missing: number } {
    return vectorEmbeddingCoverage(this.maintenanceHost());
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
    return vectorCacheStats(this.maintenanceHost());
  }

  /**
   * LRU-evict the embedding cache down to `keepMostRecent` rows. The
   * `embedding_cache` table is independent of `entries`, so a sweep here
   * only removes cached vectors — never stored entries. Called by hosts
   * that want to bound cache growth on long-lived processes.
   */
  async evictCache(keepMostRecent: number): Promise<{ removed: number }> {
    return evictVectorCache(this.maintenanceHost(), keepMostRecent);
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
    return decodeVectorEntry(row, vectorRow);
  }

  async syncFromSage(sage: SageSyncSource): Promise<SageSyncReport> {
    return syncSageEntries(this.sageSyncHost(), sage);
  }

  private queryHost(): VectorQueryHost {
    return {
      assertOpen: (...args) => this.assertOpen(...args),
      provider: this.provider,
      embedWithCache: (...args) => this.embedWithCache(...args),
      db: this.db,
      rowToEntry: (...args) => this.rowToEntry(...args),
    };
  }

  private maintenanceHost(): VectorMaintenanceHost {
    const self = this;
    return {
      assertOpen: (...args) => this.assertOpen(...args),
      get lockPath() {
        return self.lockPath;
      },
      db: this.db,
      provider: this.provider,
      cacheVector: (...args) => this.cacheVector(...args),
    };
  }

  private sageSyncHost(): VectorSageSyncHost {
    const self = this;
    return {
      assertOpen: (...args) => this.assertOpen(...args),
      findBySageId: (...args) => this.findBySageId(...args),
      get lockPath() {
        return self.lockPath;
      },
      forgetUnlocked: (...args) => this.forgetUnlocked(...args),
      rememberUnlocked: (...args) => this.rememberUnlocked(...args),
    };
  }
}

export function fallbackHashingProvider(dimensions: number): HashingEmbeddingProvider {
  return new HashingEmbeddingProvider({ dimensions });
}
