/**
 * The code index store. Layered: {@link IndexStoreBase} (connection,
 * transactions, helper hosts) → {@link IndexStoreDerivedLayers} (call graph,
 * ranks, vectors, concepts) → IndexStore (symbol/file/ref writes, search,
 * stats, maintenance).
 */

import { commitBatch, replaceEmptyFile } from './index-store-batches.js';
import * as indexStoreMaintenance from './index-store-maintenance.js';
import type { RefBindingResult, RefBindingScope } from './ref-binding-pass.js';
import { bindRefsByImports } from './ref-binding-pass.js';
import type {
  FileMeta,
  IndexStats,
  Symbol as IndexSymbol,
  Ref,
  SearchResult,
  SymbolLang,
} from './schema.js';
import type { IndexSummary } from './writer-admin.js';
import * as writerAdmin from './writer-admin.js';
import { bulkInsertRefsWithStatement } from './writer-bulk-insert.js';
import {
  checkpointWal as checkpointWalFromHost,
  deferSecondaryIndexes as deferSecondaryIndexesFromHost,
  optimizeFtsIfNeeded as optimizeFtsIfNeededFromHost,
  restoreSecondaryIndexes as restoreSecondaryIndexesFromHost,
  setLastIndexed as setLastIndexedFromHost,
} from './writer-cache-lifecycle.js';
import * as writerDeletion from './writer-deletion.js';
import { optimizeStore } from './writer-maintenance.js';
import * as writerMutations from './writer-mutations.js';
import * as writerRefs from './writer-refs.js';
import * as writerSearch from './writer-search.js';
import type { WriterSearchFilter } from './writer-search-helpers.js';
import { IndexStoreBase } from './writer-store-base.js';
import { IndexStoreDerivedLayers } from './writer-store-derived.js';
import { StorePool } from './writer-store-pool.js';

export { codebaseIndexDirOverride, resolveIndexDir } from './writer-helpers.js';

export { StorePool } from './writer-store-pool.js';

export class IndexStore extends IndexStoreDerivedLayers {
  insertSymbols(symbols: IndexSymbol[]): IndexSymbol[] {
    this.invalidateBm25();
    return this.runWriteTransaction(() => {
      const result = writerMutations.insertSymbolsWithStatement(
        (sql) => this.stmt(sql),
        IndexStoreBase.MAX_SQL_VARS,
        this.ftsAvailable,
        this.vectorsAvailable,
        this.allocateSymbolIds.bind(this),
        symbols,
      );
      this.recordFtsChurn(symbols.length);
      return result;
    });
  }

  deleteSymbolsForFile(file: string): void {
    writerDeletion.deleteFileSymbols(this.indexDeletionHost(), file);
  }

  /** `deferResolution` collects the names to re-resolve instead (see deleteIndexedFile). */
  deleteFile(file: string, opts?: { deferResolution?: Set<string> }): void {
    writerDeletion.deleteIndexedFile(this.indexDeletionHost(), file, opts?.deferResolution);
  }

  upsertFile(meta: FileMeta): void {
    this.runWithRetry(() => writerMutations.upsertFileWithStatement((sql) => this.stmt(sql), meta));
  }

  getFileMeta(file: string): FileMeta | null {
    return writerAdmin.getFileMetaWithStatement((sql) => this.stmt(sql), file);
  }

  getAllFileMetas(): FileMeta[] {
    return writerAdmin.getAllFileMetasWithStatement((sql) => this.stmt(sql));
  }

  /** Metadata for just `files`; absent ones are missing from the result. */
  getFileMetas(files: readonly string[]): FileMeta[] {
    if (files.length === 0) return [];
    return writerAdmin.getFileMetasWithStatement(
      (sql) => this.stmt(sql),
      IndexStoreBase.MAX_SQL_VARS,
      files,
    );
  }

  setFilePackages(entries: ReadonlyMap<string, string>): void {
    this.runWithRetry(() =>
      writerMutations.setFilePackagesWithStatement((sql) => this.stmt(sql), entries),
    );
  }

  /** Record the Git blob each file's rows were built from ('' clears it). */
  setGitBlobs(entries: ReadonlyMap<string, string>): void {
    this.runWithRetry(() =>
      writerMutations.setGitBlobsWithStatement((sql) => this.stmt(sql), entries),
    );
  }

  getNamespaceDeclarations(): Array<{ name: string; file: string }> {
    return writerRefs.getNamespaceDeclarationsWithStatement((sql) => this.stmt(sql));
  }

  getFilePackages(): Map<string, string> {
    return writerRefs.getFilePackagesWithStatement((sql) => this.stmt(sql));
  }

  getUnresolvedImports(onlyFiles?: readonly string[]): Array<{
    fromFile: string;
    lang: string;
    module: string;
  }> {
    return writerRefs.getUnresolvedImportsWithStatement(
      (sql) => this.stmt(sql),
      IndexStoreBase.MAX_SQL_VARS,
      onlyFiles,
    );
  }

  getFilesWithDanglingImports(): string[] {
    return writerRefs.getFilesWithDanglingImportsWithStatement((sql) => this.stmt(sql));
  }

  /** Imports whose `to_file` is unset — the ones a newly added file can satisfy. */
  getImportsWithoutTarget(): Array<{ fromFile: string; lang: string; module: string }> {
    return writerRefs.getImportsWithoutTargetWithStatement((sql) => this.stmt(sql));
  }

  /** Files holding an import resolved to one of `targets`. */
  getImportersOfFiles(targets: readonly string[]): string[] {
    if (targets.length === 0) return [];
    return writerRefs.getImportersOfFilesWithStatement(
      (sql) => this.stmt(sql),
      IndexStoreBase.MAX_SQL_VARS,
      targets,
    );
  }

  /**
   * [owner file, to_name] of every ref whose `to_file` is one of `targets` —
   * imports resolved to them and names the binding pass bound into them.
   */
  getRefNamesTargeting(targets: readonly string[]): Array<[string, string]> {
    if (targets.length === 0) return [];
    return writerRefs.getRefNamesTargetingWithStatement(
      (sql) => this.stmt(sql),
      IndexStoreBase.MAX_SQL_VARS,
      targets,
    );
  }

  /** Import-aware rebinding of JS-family refs; see ref-binding-pass.ts. */
  bindRefsByImports(scope: RefBindingScope | 'all'): RefBindingResult {
    return bindRefsByImports(
      {
        stmt: (sql) => this.stmt(sql) as never,
        maxSqlVars: IndexStoreBase.MAX_SQL_VARS,
        write: (operation) => this.runWriteTransaction(operation),
      },
      scope,
    );
  }

  applyImportResolutions(
    resolutions: ReadonlyArray<{
      fromFile: string;
      lang: string;
      module: string;
      toFile: string | null;
    }>,
  ): number {
    return writerRefs.applyImportResolutionsWithStatement(
      this.db,
      (sql) => this.stmt(sql),
      this.runWithRetry.bind(this),
      IndexStoreBase.MAX_SQL_VARS,
      resolutions,
    );
  }

  search(
    query: string,
    filter?: WriterSearchFilter,
    opts?: { limit?: number | undefined },
  ): SearchResult[] {
    return writerSearch.searchWithStatement((sql) => this.stmt(sql), query, filter, opts);
  }

  countSearch(query: string, filter?: WriterSearchFilter | undefined): number {
    return writerSearch.countSearchWithStatement((sql) => this.stmt(sql), query, filter);
  }

  searchRanked(
    query: string,
    filter: WriterSearchFilter | undefined,
    limit: number,
  ): { results: SearchResult[]; total: number } {
    return writerSearch.searchRankedWithStatement(
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

  getStats(): IndexStats {
    return writerAdmin.getStatsWithStatement((sql) => this.stmt(sql), this.indexDir);
  }

  /** P2.5: minimal summary for search-response piggyback (see writer-admin). */
  getIndexSummary(): IndexSummary {
    return writerAdmin.getIndexSummaryWithStatement((sql) => this.stmt(sql));
  }

  setLastIndexed(ts: number): void {
    setLastIndexedFromHost(this.writerCacheLifecycleHost(), ts);
  }

  clearAll(): void {
    writerDeletion.clearIndex(this.indexDeletionHost());
  }

  /**
   * Drop the secondary indexes of `symbols` and `refs` for a rebuild into an
   * empty index, so the bulk inserts maintain one b-tree per table instead of
   * eight; {@link restoreSecondaryIndexes} builds them once, sorted, at the
   * end. Only for a run that has just cleared everything and issues no
   * lookups by those columns until it restores them. Inside the atomic
   * update a failure rolls the drop back with everything else.
   */
  deferSecondaryIndexes(): void {
    deferSecondaryIndexesFromHost(this.writerCacheLifecycleHost());
  }

  /** Recreate what {@link deferSecondaryIndexes} dropped (idempotent). */
  restoreSecondaryIndexes(): void {
    restoreSecondaryIndexesFromHost(this.writerCacheLifecycleHost());
  }

  insertRefs(fromId: number, refs: Ref[]): void {
    this.runWithRetry(() => {
      this.stmt('DELETE FROM refs WHERE from_id = ?').run(fromId);
      if (refs.length === 0) return;
      bulkInsertRefsWithStatement(
        (sql) => this.stmt(sql),
        IndexStoreBase.MAX_SQL_VARS,
        refs.map((ref) => ({ ...ref, fromId })),
      );
    });
  }

  insertRefsBatch(refs: Ref[]): void {
    if (refs.length === 0) return;
    this.runWithRetry(() => {
      bulkInsertRefsWithStatement((sql) => this.stmt(sql), IndexStoreBase.MAX_SQL_VARS, refs);
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
    options: {
      deleteForFiles?: string[] | undefined;
      /** See {@link commitBatchWithStatement}. */
      deferResolution?: Set<string> | undefined;
    } = {},
  ): IndexSymbol[] {
    return commitBatch(this.indexStoreBatchesHost(), entries, options);
  }

  deleteRefsForFile(file: string): void {
    this.runWithRetry(() => {
      this.stmt('DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file = ?)').run(
        file,
      );
    });
  }

  resolveRefs(): number {
    return this.runWithRetry(() => writerRefs.resolveRefsWithStatement((sql) => this.stmt(sql)));
  }

  resolveRefsForNames(names: Iterable<string>): number {
    return this.runWithRetry(() => this.resolveRefsForNamesUnsafe(names));
  }

  replaceEmptyFile(meta: FileMeta): void {
    replaceEmptyFile(this.indexStoreBatchesHost(), meta);
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
    return optimizeFtsIfNeededFromHost(this.writerCacheLifecycleHost(), options);
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
    return checkpointWalFromHost(this.writerCacheLifecycleHost());
  }

  compactIfNeeded(options: { minBytes?: number; minFreeRatio?: number } = {}): boolean {
    return indexStoreMaintenance.compactIfNeeded(this.indexStoreMaintenanceHost(), options);
  }
}

export const indexStorePool = new StorePool(
  (projectRoot: string, opts?: { indexDir?: string | undefined }) =>
    new IndexStore(projectRoot, opts),
);
