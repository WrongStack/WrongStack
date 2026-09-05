import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type Bm25Index, buildBm25Index } from './bm25.js';
import type {
  CallSite,
  CodeMapGraph,
  FileMeta,
  IndexStats,
  Symbol as IndexSymbol,
  Ref,
  SearchResult,
  SymbolKind,
  SymbolLang,
} from './schema.js';
import { loadDatabaseSync, runSqliteWithRetry } from './sqlite-runtime.js';
import {
  getAllFileMetasWithStatement,
  getAllIndexableWithStatement,
  getFileMetaWithStatement,
  getIndexSummaryWithStatement,
  getMaxSymbolIdWithStatement,
  getMetadataWithStatement,
  getStatsWithStatement,
  type IndexSummary,
} from './writer-admin.js';
import { bulkInsertRefsWithStatement } from './writer-bulk-insert.js';
import {
  findIncomingCallsByName,
  findOutgoingCallsByName,
  findReachableSymbolIds,
  findRefsFromWithStatement,
  findRefsToWithStatement,
  findTransitiveIncomingCallsByName,
  findTransitiveOutgoingCallsByName,
  getFileGraphWithStatement,
  getPackageGraphWithStatement,
  getSymbolGraphWithStatement,
} from './writer-graph-reader.js';
import { inListChunks, padToInBucket, placeholders, resolveIndexDir } from './writer-helpers.js';
import { allocateSymbolIds, initIndexSchema, NEXT_SYMBOL_ID_KEY } from './writer-init.js';
import {
  checkpointWal,
  compactIfNeeded,
  optimizeFtsIfNeeded,
  optimizeStore,
  recordFtsChurn,
} from './writer-maintenance.js';
import {
  commitBatchWithStatement,
  insertSymbolsWithStatement,
  setFilePackagesWithStatement,
  upsertFileWithStatement,
} from './writer-mutations.js';
import { applyIndexStorePragmas } from './writer-pragmas.js';
import {
  applyImportResolutionsWithStatement,
  getAllImportRefsWithStatement,
  getAllResolvedRefsWithStatement,
  getFilePackagesWithStatement,
  getNamespaceDeclarationsWithStatement,
  getUnresolvedImportsWithStatement,
  resolveRefsForNamesUnsafe,
  resolveRefsWithStatement,
} from './writer-refs.js';
import {
  countSearchWithStatement,
  searchRankedWithStatement,
  searchWithStatement,
} from './writer-search.js';
import type { WriterSearchFilter } from './writer-search-helpers.js';
import { StorePool } from './writer-store-pool.js';

export { codebaseIndexDirOverride, resolveIndexDir } from './writer-helpers.js';
export { StorePool } from './writer-store-pool.js';

const DB_FILE = 'index.db';
const MAX_STATEMENT_CACHE = 128;

export class IndexStore {
  private db: DatabaseSync;
  private atomicIndexUpdateActive = false;
  private writeSavepointSequence = 0;
  private readonly indexDir: string;
  private ftsAvailable = false;
  private vectorsAvailable = false;
  private readonly stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private bm25Cache: Bm25Index | null = null;
  private bm25Dirty = true;

  private stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    const cached = this.stmtCache.get(sql);
    if (cached !== undefined) {
      this.stmtCache.delete(sql);
      this.stmtCache.set(sql, cached);
      return cached;
    }
    const s = this.db.prepare(sql);
    this.stmtCache.set(sql, s);
    if (this.stmtCache.size > MAX_STATEMENT_CACHE) {
      const oldest = this.stmtCache.keys().next();
      if (!oldest.done) this.stmtCache.delete(oldest.value);
    }
    return s;
  }

  constructor(projectRoot: string, opts: { indexDir?: string | undefined } = {}) {
    this.indexDir = resolveIndexDir(projectRoot, opts.indexDir);
    fs.mkdirSync(this.indexDir, { recursive: true });
    const Database = loadDatabaseSync();
    this.db = new Database(path.join(this.indexDir, DB_FILE));
    applyIndexStorePragmas(this.db);
    this.initSchema();
  }

  runWithRetry<T>(fn: () => T): T {
    return runSqliteWithRetry(fn);
  }

  async runAtomicIndexUpdate<T>(job: () => Promise<T>): Promise<T> {
    if (this.atomicIndexUpdateActive) return job();
    this.runWithRetry(() => this.db.exec('BEGIN IMMEDIATE'));
    this.atomicIndexUpdateActive = true;
    try {
      const result = await job();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* preserve the indexing failure */
      }
      throw error;
    } finally {
      this.atomicIndexUpdateActive = false;
    }
  }

  private beginWriteTransaction(): string | null {
    if (this.atomicIndexUpdateActive) {
      const savepoint = `index_write_${++this.writeSavepointSequence}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      return savepoint;
    }
    this.db.exec('BEGIN IMMEDIATE');
    return null;
  }

  private commitWriteTransaction(savepoint: string | null): void {
    if (savepoint) this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    else this.db.exec('COMMIT');
  }

  private rollbackWriteTransaction(savepoint: string | null): void {
    if (savepoint) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } else {
      this.db.exec('ROLLBACK');
    }
  }

  private initSchema(): void {
    const { ftsAvailable, vectorsAvailable } = initIndexSchema(
      this.db,
      (sql) => this.stmt(sql),
      (key) => this.getMetadata(key),
      (key, value) => this.setMetadata(key, value),
      IndexStore.MAX_SQL_VARS,
      () => this.invalidateBm25(),
    );
    this.ftsAvailable = ftsAvailable;
    this.vectorsAvailable = vectorsAvailable;
  }

  private static readonly NEXT_SYMBOL_ID_KEY = NEXT_SYMBOL_ID_KEY;
  private static readonly MAX_SQL_VARS = 900;

  private allocateSymbolIds(count: number): number {
    return allocateSymbolIds(
      (sql) => this.stmt(sql),
      count,
      () => this.getMaxSymbolId(),
    );
  }

  private invalidateIncomingRefsForFiles(files: readonly string[]): Set<string> {
    if (files.length === 0) return new Set();
    // P4.12: bucketed chunks — a fitting list stays ONE statement pair (IN
    // duplicates are set semantics); an oversized list ladders within budget.
    const names: string[] = [];
    let cursor = 0;
    for (const take of inListChunks(files.length, IndexStore.MAX_SQL_VARS)) {
      const bucket = padToInBucket(files.slice(cursor, cursor + take));
      cursor += take;
      const ph = placeholders(bucket.length);
      for (const row of this.stmt(`SELECT DISTINCT name FROM symbols WHERE file IN (${ph})`).all(
        ...bucket,
      ) as Array<{ name: string }>) {
        names.push(row.name);
      }
      this.stmt(
        `UPDATE refs SET to_id = NULL
         WHERE to_id IN (SELECT id FROM symbols WHERE file IN (${ph}))`,
      ).run(...bucket);
    }
    return new Set(names);
  }

  private resolveRefsForNamesUnsafe(names: Iterable<string>): number {
    return resolveRefsForNamesUnsafe((sql) => this.stmt(sql), IndexStore.MAX_SQL_VARS, names);
  }

  insertSymbols(symbols: IndexSymbol[]): IndexSymbol[] {
    this.invalidateBm25();
    return this.runWithRetry(() => {
      const ownsTransaction = this.beginWriteTransaction();
      try {
        const result = insertSymbolsWithStatement(
          (sql) => this.stmt(sql),
          IndexStore.MAX_SQL_VARS,
          this.ftsAvailable,
          this.vectorsAvailable,
          this.allocateSymbolIds.bind(this),
          symbols,
        );
        this.recordFtsChurn(symbols.length);
        this.commitWriteTransaction(ownsTransaction);
        return result;
      } catch (err) {
        this.rollbackWriteTransaction(ownsTransaction);
        throw err;
      }
    });
  }

  deleteSymbolsForFile(file: string): void {
    this.invalidateBm25();
    this.runWithRetry(() => {
      const ownsTransaction = this.beginWriteTransaction();
      try {
        const affectedNames = this.invalidateIncomingRefsForFiles([file]);
        if (this.ftsAvailable) {
          this.stmt(
            'DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file = ?)',
          ).run(file);
        }
        if (this.vectorsAvailable) {
          this.stmt(
            'DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE file = ?)',
          ).run(file);
        }
        const deletedChanges = Number(
          this.stmt('DELETE FROM symbols WHERE file = ?').run(file).changes,
        );
        this.recordFtsChurn(deletedChanges);
        this.resolveRefsForNamesUnsafe(affectedNames);
        this.commitWriteTransaction(ownsTransaction);
      } catch (error) {
        this.rollbackWriteTransaction(ownsTransaction);
        throw error;
      }
    });
  }

  deleteFile(file: string): void {
    this.invalidateBm25();
    this.runWithRetry(() => {
      const ownsTransaction = this.beginWriteTransaction();
      try {
        const affectedNames = this.invalidateIncomingRefsForFiles([file]);
        if (this.ftsAvailable) {
          this.stmt(
            'DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file = ?)',
          ).run(file);
        }
        if (this.vectorsAvailable) {
          this.stmt(
            'DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE file = ?)',
          ).run(file);
        }
        this.stmt('DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file = ?)').run(
          file,
        );
        const deletedChanges = Number(
          this.stmt('DELETE FROM symbols WHERE file = ?').run(file).changes,
        );
        this.recordFtsChurn(deletedChanges);
        this.stmt('DELETE FROM files WHERE file = ?').run(file);
        this.resolveRefsForNamesUnsafe(affectedNames);
        this.commitWriteTransaction(ownsTransaction);
      } catch (err) {
        this.rollbackWriteTransaction(ownsTransaction);
        throw err;
      }
    });
  }

  upsertFile(meta: FileMeta): void {
    this.runWithRetry(() => upsertFileWithStatement((sql) => this.stmt(sql), meta));
  }

  getFileMeta(file: string): FileMeta | null {
    return getFileMetaWithStatement((sql) => this.stmt(sql), file);
  }

  getAllFileMetas(): FileMeta[] {
    return getAllFileMetasWithStatement((sql) => this.stmt(sql));
  }

  setFilePackages(entries: ReadonlyMap<string, string>): void {
    this.runWithRetry(() => setFilePackagesWithStatement((sql) => this.stmt(sql), entries));
  }

  getNamespaceDeclarations(): Array<{ name: string; file: string }> {
    return getNamespaceDeclarationsWithStatement((sql) => this.stmt(sql));
  }

  getFilePackages(): Map<string, string> {
    return getFilePackagesWithStatement((sql) => this.stmt(sql));
  }

  getUnresolvedImports(onlyFiles?: readonly string[]): Array<{
    fromFile: string;
    lang: string;
    module: string;
  }> {
    return getUnresolvedImportsWithStatement(
      (sql) => this.stmt(sql),
      IndexStore.MAX_SQL_VARS,
      onlyFiles,
    );
  }

  applyImportResolutions(
    resolutions: ReadonlyArray<{ fromFile: string; lang: string; module: string; toFile: string }>,
  ): number {
    return applyImportResolutionsWithStatement(
      this.db,
      (sql) => this.stmt(sql),
      this.runWithRetry.bind(this),
      IndexStore.MAX_SQL_VARS,
      resolutions,
    );
  }

  search(
    query: string,
    filter?: WriterSearchFilter,
    opts?: { limit?: number | undefined },
  ): SearchResult[] {
    return searchWithStatement((sql) => this.stmt(sql), query, filter, opts);
  }

  countSearch(query: string, filter?: WriterSearchFilter | undefined): number {
    return countSearchWithStatement((sql) => this.stmt(sql), query, filter);
  }

  searchRanked(
    query: string,
    filter: WriterSearchFilter | undefined,
    limit: number,
  ): { results: SearchResult[]; total: number } {
    return searchRankedWithStatement(
      (sql) => this.stmt(sql),
      this.search.bind(this),
      this.ftsAvailable,
      this.vectorsAvailable,
      this.getOrBuildBm25.bind(this),
      query,
      filter,
      limit,
    );
  }

  private invalidateBm25(): void {
    this.bm25Dirty = true;
    this.bm25Cache = null;
  }

  private getOrBuildBm25(): Bm25Index {
    if (this.bm25Cache && !this.bm25Dirty) return this.bm25Cache;
    const docs = this.getAllIndexable();
    this.bm25Cache = buildBm25Index(docs);
    this.bm25Dirty = false;
    return this.bm25Cache;
  }

  getAllIndexable(): Array<{ id: number; text: string }> {
    return getAllIndexableWithStatement((sql) => this.stmt(sql));
  }

  getMaxSymbolId(): number {
    return getMaxSymbolIdWithStatement((sql) => this.stmt(sql));
  }

  getStats(): IndexStats {
    return getStatsWithStatement((sql) => this.stmt(sql), this.indexDir);
  }

  /** P2.5: minimal summary for search-response piggyback (see writer-admin). */
  getIndexSummary(): IndexSummary {
    return getIndexSummaryWithStatement((sql) => this.stmt(sql));
  }

  setLastIndexed(ts: number): void {
    this.runWithRetry(() => {
      this.stmt("INSERT OR REPLACE INTO metadata(key, value) VALUES('last_indexed', ?)").run(
        String(ts),
      );
    });
  }

  getMetadata(key: string): string | undefined {
    return getMetadataWithStatement((sql) => this.stmt(sql), key);
  }

  setMetadata(key: string, value: string): void {
    this.runWithRetry(() => {
      this.stmt('INSERT OR REPLACE INTO metadata(key, value) VALUES(?, ?)').run(key, value);
    });
  }

  clearAll(): void {
    this.invalidateBm25();
    this.runWithRetry(() => {
      const ownsTransaction = this.beginWriteTransaction();
      try {
        this.db.exec('DROP TABLE IF EXISTS refs');
        this.db.exec('DROP TABLE IF EXISTS symbols');
        this.db.exec('DROP TABLE IF EXISTS files');
        this.db.exec('DROP TABLE IF EXISTS metadata');
        if (this.ftsAvailable) this.db.exec('DROP TABLE IF EXISTS symbols_fts');
        this.db.exec('DROP TABLE IF EXISTS symbol_vectors');
        this.stmtCache.clear();
        this.initSchema();
        this.stmt('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run(
          IndexStore.NEXT_SYMBOL_ID_KEY,
          '1',
        );
        this.commitWriteTransaction(ownsTransaction);
      } catch (err) {
        this.rollbackWriteTransaction(ownsTransaction);
        throw err;
      }
    });
  }

  insertRefs(fromId: number, refs: Ref[]): void {
    this.runWithRetry(() => {
      this.stmt('DELETE FROM refs WHERE from_id = ?').run(fromId);
      if (refs.length === 0) return;
      bulkInsertRefsWithStatement(
        (sql) => this.stmt(sql),
        IndexStore.MAX_SQL_VARS,
        refs.map((ref) => ({ ...ref, fromId })),
      );
    });
  }

  insertRefsBatch(refs: Ref[]): void {
    if (refs.length === 0) return;
    this.runWithRetry(() => {
      bulkInsertRefsWithStatement((sql) => this.stmt(sql), IndexStore.MAX_SQL_VARS, refs);
    });
  }

  commitBatch(
    entries: Array<{
      file: string;
      lang: SymbolLang;
      symbols: IndexSymbol[];
      refs: Ref[];
      mtimeMs: number;
      symbolCount: number;
      contentHash?: string | undefined;
    }>,
    options: { deleteForFiles?: string[] | undefined } = {},
  ): IndexSymbol[] {
    this.invalidateBm25();
    return this.runWithRetry(() => {
      const ownsTransaction = this.beginWriteTransaction();
      try {
        const owned = options.deleteForFiles?.length ?? 0;
        let churnRows = entries.reduce((sum, e) => sum + e.symbols.length, 0);
        // P2 review fix: deleteForFiles removes FTS rows too. Count those
        // pre-existing rows (pre-DELETE, inside this transaction) so
        // delete-only batches can also cross the maintenance gate.
        if (owned > 0) {
          let cursor = 0;
          for (const take of inListChunks(owned, Math.floor(IndexStore.MAX_SQL_VARS / 4))) {
            const bucket = options.deleteForFiles!.slice(cursor, cursor + take);
            cursor += take;
            const row = this.stmt(
              `SELECT COUNT(*) AS n FROM symbols WHERE file IN (${placeholders(bucket.length)})`,
            ).get(...bucket) as { n?: number } | undefined;
            churnRows += Number(row?.n ?? 0);
          }
        }
        const result = commitBatchWithStatement(
          (sql) => this.stmt(sql),
          IndexStore.MAX_SQL_VARS,
          this.ftsAvailable,
          this.vectorsAvailable,
          this.allocateSymbolIds.bind(this),
          this.invalidateIncomingRefsForFiles.bind(this),
          this.resolveRefsForNamesUnsafe.bind(this),
          entries,
          options,
        );
        this.recordFtsChurn(churnRows);
        this.commitWriteTransaction(ownsTransaction);
        return result;
      } catch (err) {
        this.rollbackWriteTransaction(ownsTransaction);
        throw err;
      }
    });
  }

  deleteRefsForFile(file: string): void {
    this.runWithRetry(() => {
      this.stmt('DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file = ?)').run(
        file,
      );
    });
  }

  resolveRefs(): number {
    return this.runWithRetry(() => resolveRefsWithStatement((sql) => this.stmt(sql)));
  }

  resolveRefsForNames(names: Iterable<string>): number {
    return this.runWithRetry(() => this.resolveRefsForNamesUnsafe(names));
  }

  replaceEmptyFile(meta: FileMeta): void {
    this.invalidateBm25();
    this.runWithRetry(() => {
      const ownsTransaction = this.beginWriteTransaction();
      try {
        const affectedNames = this.invalidateIncomingRefsForFiles([meta.file]);
        if (this.ftsAvailable) {
          this.stmt(
            'DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file = ?)',
          ).run(meta.file);
        }
        if (this.vectorsAvailable) {
          this.stmt(
            'DELETE FROM symbol_vectors WHERE symbol_id IN (SELECT id FROM symbols WHERE file = ?)',
          ).run(meta.file);
        }
        this.stmt('DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file = ?)').run(
          meta.file,
        );
        const deletedChanges = Number(
          this.stmt('DELETE FROM symbols WHERE file = ?').run(meta.file).changes,
        );
        this.recordFtsChurn(deletedChanges);
        this.stmt(
          `INSERT INTO files(file, lang, mtime_ms, content_hash, symbol_count, last_indexed)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(file) DO UPDATE SET
             lang = excluded.lang,
             mtime_ms = excluded.mtime_ms,
             content_hash = excluded.content_hash,
             symbol_count = excluded.symbol_count,
             last_indexed = excluded.last_indexed`,
        ).run(
          meta.file,
          meta.lang,
          meta.mtimeMs,
          meta.contentHash ?? '',
          meta.symbolCount,
          meta.lastIndexed,
        );
        this.resolveRefsForNamesUnsafe(affectedNames);
        this.commitWriteTransaction(ownsTransaction);
      } catch (err) {
        this.rollbackWriteTransaction(ownsTransaction);
        throw err;
      }
    });
  }

  optimize(): void {
    optimizeStore(this.db);
  }

  /**
   * P2: churn-gated FTS5 segment maintenance.
   *
   * FTS5 postings only compact when FTS5 itself merges them: every delete
   * leaves tombstone postings in the segments, and neither VACUUM nor
   * `PRAGMA optimize` reclaims them. Measured on the live index (2026-08-30):
   * one delete+reinsert cycle grew symbols_fts_data 174.9→212.8 MB, while the
   * FTS5 'optimize'/'rebuild' merge resets it (rebuild: 212.9→28.2 MB in
   * 1.26 s for 131k rows). 'optimize' is the recurring command — an
   * incremental merge that discards deleted docs — and only runs once churn
   * crosses the gate, so a clean index never pays for it.
   *
   * Follows the {@link checkpointWal} contract: best-effort, returns whether
   * it ran, safe to call from the daemon's single-threaded idle path.
   */
  optimizeFtsIfNeeded(options: { minChurnRatio?: number; minChurnRows?: number } = {}): boolean {
    return optimizeFtsIfNeeded(
      (sql) => this.stmt(sql),
      this.ftsAvailable,
      (key) => this.getMetadata(key),
      (key, value) => this.setMetadata(key, value),
      (fn) => this.runWithRetry(fn),
      options,
    );
  }

  /**
   * Best-effort churn bookkeeping for {@link optimizeFtsIfNeeded}. Counts the
   * FTS rows a mutation inserts or deletes so the maintenance gate can fire
   * after real churn, not on a timer. Persisted in metadata so the counter
   * survives store open/close cycles in the daemon pool.
   */
  private recordFtsChurn(rows: number): void {
    recordFtsChurn(
      this.ftsAvailable,
      (key) => this.getMetadata(key),
      (key, value) => this.setMetadata(key, value),
      rows,
    );
  }

  /**
   * P4.14: best-effort WAL checkpoint for idle-time maintenance.
   *
   * `wal_autocheckpoint` is PASSIVE and only attempts work after a COMMIT —
   * once writes stop, nothing fires again, so the WAL keeps whatever frames
   * the last burst left. This probes with PASSIVE first (never blocks; busy=1
   * means readers still hold WAL snapshots) and only issues the TRUNCATE —
   * which resets index.db-wal to zero bytes — when the checkpointer can
   * proceed immediately. Callers run this on the daemon's single thread, so
   * never wait on readers here: busy means "retry at the next idle window".
   */
  checkpointWal(): boolean {
    return checkpointWal(this.db);
  }

  compactIfNeeded(options: { minBytes?: number; minFreeRatio?: number } = {}): boolean {
    return compactIfNeeded(
      this.db,
      (sql) => this.stmt(sql),
      (fn) => this.runWithRetry(fn),
      options,
    );
  }

  findIncomingCallsByName(
    symbolName: string,
    file?: string,
    limit = 100,
  ): { calls: CallSite[]; symbolFound: boolean; ambiguous: boolean; totalMatches: number } {
    return findIncomingCallsByName((sql) => this.stmt(sql), symbolName, file, limit);
  }

  findOutgoingCallsByName(
    symbolName: string,
    file?: string,
    limit = 100,
  ): { calls: CallSite[]; symbolFound: boolean; unresolvedCount: number; totalMatches: number } {
    return findOutgoingCallsByName((sql) => this.stmt(sql), symbolName, file, limit);
  }

  findTransitiveIncomingCallsByName(
    symbolName: string,
    file?: string,
    limit = 200,
  ): { calls: CallSite[]; symbolFound: boolean; ambiguous: boolean; totalMatches: number } {
    return findTransitiveIncomingCallsByName((sql) => this.stmt(sql), symbolName, file, limit);
  }

  findTransitiveOutgoingCallsByName(
    symbolName: string,
    file?: string,
    limit = 200,
  ): { calls: CallSite[]; symbolFound: boolean; unresolvedCount: number; totalMatches: number } {
    return findTransitiveOutgoingCallsByName((sql) => this.stmt(sql), symbolName, file, limit);
  }

  findReachableSymbolIds(seedIds: number[]): Set<number> {
    return findReachableSymbolIds((sql) => this.stmt(sql), seedIds);
  }

  findRefsTo(symbolId: number): Ref[] {
    return findRefsToWithStatement((sql) => this.stmt(sql), symbolId);
  }

  findRefsFrom(symbolId: number): Ref[] {
    return findRefsFromWithStatement((sql) => this.stmt(sql), symbolId);
  }

  getPackageGraph(): CodeMapGraph {
    return getPackageGraphWithStatement((sql) => this.stmt(sql));
  }

  getFileGraph(packageFilter: string): CodeMapGraph {
    return getFileGraphWithStatement((sql) => this.stmt(sql), packageFilter);
  }

  getSymbolGraph(fileFilter: string): CodeMapGraph {
    return getSymbolGraphWithStatement((sql) => this.stmt(sql), fileFilter);
  }

  getAllSymbols(): Array<{
    id: number;
    name: string;
    file: string;
    kind: SymbolKind;
    line: number;
  }> {
    return (
      this.stmt('SELECT id, name, file, kind, line FROM symbols ORDER BY id').all() as Array<{
        id: number;
        name: string;
        file: string;
        kind: string;
        line: number;
      }>
    ).map((r) => ({ ...r, kind: r.kind as SymbolKind }));
  }

  getAllResolvedRefs(): Array<{
    fromId: number;
    toId: number;
    callType: string;
  }> {
    return getAllResolvedRefsWithStatement((sql) => this.stmt(sql));
  }

  getAllImportRefs(): Array<{
    sourceFile: string | null;
    toName: string;
    toId: number | null;
    callType: string;
    line: number;
  }> {
    return getAllImportRefsWithStatement((sql) => this.stmt(sql));
  }

  close(): void {
    this.stmtCache.clear();
    this.bm25Dirty = true;
    this.bm25Cache = null;
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

export const indexStorePool = new StorePool(
  (projectRoot: string, opts?: { indexDir?: string | undefined }) =>
    new IndexStore(projectRoot, opts),
);
