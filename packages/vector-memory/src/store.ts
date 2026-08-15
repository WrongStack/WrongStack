/**
 * VectorMemoryStore — SQLite-backed storage for vector entries.
 *
 * Each `remember` embeds the text via the configured provider and persists
 * both the entry and its vector in a single transaction. `search` embeds
 * the query and ranks entries by cosine similarity in pure JS (O(n·d)),
 * matching the existing `packages/tools/src/codebase-index/vector-search.ts`
 * pattern. The store is deliberately separate from SAGE's SQLite database
 * so the two stores cannot contend on the same file lock.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HashingEmbeddingProvider, cosineSimilarity } from '@wrongstack/sage';

import {
  VECTOR_DIMENSIONS_KEY,
  VECTOR_PROVIDER_KEY,
  decodeVector,
  encodeVector,
  initVectorSchema,
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

const DEFAULT_DIRECTORY = '.wrongstack/vector-memory';
const DEFAULT_FILENAME = 'vector-memory.db';

export class VectorMemoryStore {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
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
    this.dbPath = path.join(rootDir, filename);
    this.db = new DatabaseSync(this.dbPath);
    initVectorSchema(this.db);
    this.recordActiveProvider();
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

  async remember(input: VectorEntryInput): Promise<VectorEntryWithVector> {
    this.assertOpen();
    if (!input.text || input.text.trim().length === 0) {
      throw new Error('VectorMemoryStore.remember: text must be non-empty');
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const contentHash = VectorMemoryStore.contentHash(input.text);
    const metadata = input.metadata ?? {};
    const tags = input.tags ?? [];
    const scope: VectorScope = input.scope ?? 'project';
    const kind: VectorKind = input.kind ?? 'note';

    let vector: Float32Array | undefined;
    let providerId: string | undefined;
    try {
      const result = await this.provider.embed([input.text]);
      vector = result[0];
      providerId = this.provider.id;
    } catch {
      // Fail-open: store the entry without a vector so writes don't
      // disappear when the embedding backend is unavailable.
      providerId = undefined;
      vector = undefined;
    }

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
    const vectorRow = this.db
      .prepare('SELECT * FROM vectors WHERE entry_id = ?')
      .get(id) as
      | { provider_id: string; dimensions: number; vector: Buffer | Uint8Array }
      | undefined;
    return this.rowToEntry(row, vectorRow);
  }

  forget(id: string): boolean {
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

  async search(query: string, opts: VectorSearchOptions = {}): Promise<VectorSearchHit[]> {
    this.assertOpen();
    const limit = opts.limit ?? 10;
    const threshold = opts.threshold ?? 0;
    if (typeof query !== 'string' || query.trim().length === 0) return [];

    let queryVec: Float32Array;
    try {
      const result = await this.provider.embed([query]);
      if (!result[0]) return [];
      queryVec = result[0];
    } catch {
      return [];
    }
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

    const rows = this.db
      .prepare(
        `SELECT e.id, e.text, e.summary, e.metadata, e.tags, e.scope, e.kind,
                e.content_hash, e.created_at, e.updated_at,
                v.vector AS vec_blob
           FROM entries e
           JOIN vectors v ON v.entry_id = e.id
          WHERE ${filters.join(' AND ')}`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    const scored: VectorSearchHit[] = [];
    for (const row of rows) {
      const blob = row.vec_blob as Buffer | Uint8Array;
      const vec = decodeVector(blob);
      const raw = cosineSimilarity(queryVec, vec);
      const score = Math.max(0, Math.min(1, raw));
      if (score < threshold) continue;
      const entry = this.rowToEntry(row) as VectorEntry;
      scored.push({ entry, score, providerId });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  list(opts: { limit?: number; scope?: VectorScope; kind?: VectorKind } = {}): VectorEntry[] {
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
    const sql = `SELECT * FROM entries ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY updated_at DESC LIMIT ?`;
    params.push(opts.limit ?? 100);
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEntry(r) as VectorEntry);
  }

  async reindexAll(): Promise<{ processed: number; errors: number }> {
    this.assertOpen();
    const rows = this.db.prepare('SELECT id, text FROM entries').all() as Array<
      Record<string, unknown>
    >;
    let processed = 0;
    let errors = 0;
    for (const row of rows) {
      try {
        const result = await this.provider.embed([row.text as string]);
        const v = result[0];
        if (!v) {
          errors++;
          continue;
        }
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
            row.id as string,
            this.provider.id,
            v.length,
            encodeVector(v),
            new Date().toISOString(),
          );
        processed++;
      } catch {
        errors++;
      }
    }
    return { processed, errors };
  }

  stats(): VectorStoreStats {
    this.assertOpen();
    const entryCount = (this.db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number })
      .n;
    const vectorCount = (this.db.prepare('SELECT COUNT(*) AS n FROM vectors').get() as { n: number })
      .n;
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
      summary: summaryValue ?? undefined as string | undefined,
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
    const memories = await sage.listActiveMemories({ limit: 5000 });
    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    const errors: SageSyncReport['errors'] = [];

    for (const memory of memories) {
      try {
        const existing = this.db
          .prepare('SELECT id FROM entries WHERE content_hash = ? LIMIT 1')
          .get(VectorMemoryStore.contentHash(memory.text)) as { id: string } | undefined;
        if (existing) {
          skipped++;
          continue;
        }
        await this.remember({
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
