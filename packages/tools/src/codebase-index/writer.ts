import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type Bm25Index, buildBm25Index, buildIndexableText } from './bm25.js';
import { LANG_FAMILY_ENTRIES } from './languages.js';
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
import { SCHEMA_VERSION } from './schema.js';
import { loadDatabaseSync, runSqliteWithRetry } from './sqlite-runtime.js';
import { embedText, encodeVector, vectorEmbeddingEnabled } from './vector-search.js';
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
import {
  type BulkSymbolRow,
  type BulkVectorRow,
  bulkInsertFtsWithStatement,
  bulkInsertRefsWithStatement,
  bulkInsertSymbolsWithStatement,
  bulkInsertVectorsWithStatement,
} from './writer-bulk-insert.js';
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
import { commitBatchWithStatement } from './writer-mutations.js';
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
  CORE_TABLES_SQL,
  FILE_INDEX_SQL,
  LANG_FAMILY_TABLE_SQL,
  LANG_FAMILY_WILDCARD,
  METADATA_TABLE_SQL,
  REFS_INDEX_SQL,
  REFS_TABLE_SQL,
  SYMBOL_INDEX_SQL,
  SYMBOL_VECTORS_TABLE_SQL,
  SYMBOLS_FTS_SQL,
} from './writer-schema.js';
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

  private seedLangFamilies(): void {
    const insert = this.stmt('INSERT OR REPLACE INTO lang_family(lang, family) VALUES (?, ?)');
    for (const [lang, family] of LANG_FAMILY_ENTRIES) insert.run(lang, family);
    insert.run('', LANG_FAMILY_WILDCARD);
  }

  private repairMissingColumns(): void {
    const expected: ReadonlyArray<{ table: string; columns: ReadonlyArray<[string, string]> }> = [
      {
        table: 'files',
        columns: [
          ['package', "TEXT NOT NULL DEFAULT ''"],
          ['content_hash', "TEXT NOT NULL DEFAULT ''"],
        ],
      },
      {
        table: 'refs',
        columns: [
          ['lang', "TEXT NOT NULL DEFAULT ''"],
          ['module', 'TEXT'],
          ['to_file', 'TEXT'],
        ],
      },
    ];

    for (const { table, columns } of expected) {
      const present = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>).flatMap(
          (row) => (typeof row.name === 'string' ? [row.name] : []),
        ),
      );
      if (present.size === 0) continue;
      for (const [name, type] of columns) {
        if (present.has(name)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
    }
  }

  private initSchema(): void {
    this.db.exec(METADATA_TABLE_SQL);

    const storedRows = this.stmt('SELECT value FROM metadata WHERE key = ?').all('version') as {
      value: string;
    }[];
    const storedVersion = storedRows.length ? Number(storedRows[0]?.value) : null;
    if (storedVersion !== null && storedVersion !== SCHEMA_VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS symbols;
        DROP TABLE IF EXISTS files;
        DROP TABLE IF EXISTS refs;
        DROP TABLE IF EXISTS symbol_vectors;
      `);
      this.db.exec('DROP TABLE IF EXISTS symbols_fts');
      this.stmt('UPDATE metadata SET value = ? WHERE key = ?').run(
        String(SCHEMA_VERSION),
        'version',
      );
    } else if (storedVersion === null) {
      this.stmt('INSERT INTO metadata(key, value) VALUES (?, ?)').run(
        'version',
        String(SCHEMA_VERSION),
      );
    }

    this.db.exec(CORE_TABLES_SQL);
    this.db.exec(REFS_TABLE_SQL);
    this.repairMissingColumns();
    for (const sql of FILE_INDEX_SQL) this.db.exec(sql);
    for (const sql of SYMBOL_INDEX_SQL) this.db.exec(sql);
    for (const sql of REFS_INDEX_SQL) this.db.exec(sql);
    this.db.exec(LANG_FAMILY_TABLE_SQL);
    this.seedLangFamilies();

    try {
      const ftsSchema = this.stmt(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='symbols_fts'",
      ).get() as { sql?: string } | undefined;
      if (ftsSchema?.sql?.includes('unicode61')) {
        this.db.exec('DROP TABLE IF EXISTS symbols_fts');
      }
      this.db.exec(SYMBOLS_FTS_SQL);
      this.ftsAvailable = true;
      const symbolCount = Number(
        (this.stmt('SELECT COUNT(*) AS n FROM symbols').get() as { n?: number } | undefined)?.n ??
          0,
      );
      const ftsCount = Number(
        (this.stmt('SELECT COUNT(*) AS n FROM symbols_fts').get() as { n?: number } | undefined)
          ?.n ?? 0,
      );
      if (symbolCount !== ftsCount) {
        this.db.exec('DELETE FROM symbols_fts');
        // NB: vectorsAvailable is not yet assigned here (the vector init block
        // below runs later in initSchema) — gate on the env source of truth.
        // Guard the purge: on a same-version DB where vectors were just
        // enabled, symbol_vectors may not exist yet (the vector init below
        // creates it). An unguarded DELETE would throw, and this whole block
        // sits inside the FTS try — the broad catch would then flip
        // ftsAvailable=false, silently disabling FTS because a *vector* table
        // was missing.
        if (
          vectorEmbeddingEnabled() &&
          (this.stmt(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='symbol_vectors'",
          ).get() as { '1'?: number } | undefined) !== undefined
        ) {
          this.db.exec('DELETE FROM symbol_vectors');
        }
        const rows = this.stmt(
          'SELECT id, name, signature, doc_comment FROM symbols ORDER BY id',
        ).all() as Array<{ id: number; name: string; signature: string; doc_comment: string }>;
        bulkInsertFtsWithStatement(
          (sql) => this.stmt(sql),
          IndexStore.MAX_SQL_VARS,
          this.ftsAvailable,
          rows.map((row) => ({
            id: row.id,
            text: buildIndexableText(row.name, row.signature, row.doc_comment),
          })),
        );
        this.invalidateBm25();
      }
    } catch {
      this.ftsAvailable = false;
    }

    // P4.11: the vector layer is opt-in (WRONGSTACK_INDEX_VECTORS=1).
    // Default off — see vectorEmbeddingEnabled(). When off, a legacy database
    // may still carry symbol_vectors; dropping it returns those pages to the
    // free list instead of carrying ~1.5KB/symbol of dead BLOBs forever.
    // Re-enabling + a force reindex repopulates it.
    try {
      if (vectorEmbeddingEnabled()) {
        this.db.exec(SYMBOL_VECTORS_TABLE_SQL);
        this.vectorsAvailable = true;
      } else {
        this.db.exec('DROP TABLE IF EXISTS symbol_vectors');
        this.vectorsAvailable = false;
      }
    } catch {
      this.vectorsAvailable = false;
    }

    this.ensureNextSymbolIdSeeded();
  }

  private static readonly NEXT_SYMBOL_ID_KEY = 'next_symbol_id';
  private static readonly MAX_SQL_VARS = 900;

  private ensureNextSymbolIdSeeded(): void {
    const existing = this.stmt('SELECT value FROM metadata WHERE key = ?').get(
      IndexStore.NEXT_SYMBOL_ID_KEY,
    ) as { value?: string } | undefined;
    if (existing?.value !== undefined) return;
    const maxRows = this.stmt('SELECT MAX(id) AS m FROM symbols').all() as {
      m: number | null;
    }[];
    const next = (maxRows[0]?.m ?? 0) + 1;
    this.stmt('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run(
      IndexStore.NEXT_SYMBOL_ID_KEY,
      String(next),
    );
  }

  private allocateSymbolIds(count: number): number {
    if (count <= 0) return this.getMaxSymbolId() + 1;
    this.ensureNextSymbolIdSeeded();
    const row = this.stmt('SELECT value FROM metadata WHERE key = ?').get(
      IndexStore.NEXT_SYMBOL_ID_KEY,
    ) as { value?: string } | undefined;
    const start = Math.max(1, Number(row?.value ?? 1) || 1);
    this.stmt('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run(
      IndexStore.NEXT_SYMBOL_ID_KEY,
      String(start + count),
    );
    return start;
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
        let nextId = this.allocateSymbolIds(symbols.length);
        const result: IndexSymbol[] = [];
        const bulk: BulkSymbolRow[] = [];
        const ftsRows: Array<{ id: number; text: string }> = [];
        const vectorRows: BulkVectorRow[] = [];

        for (const s of symbols) {
          const id = nextId++;
          bulk.push({
            id,
            lang: s.lang,
            kind: s.kind,
            name: s.name,
            file: s.file,
            line: s.line,
            col: s.col,
            signature: s.signature,
            docComment: s.docComment,
            scope: s.scope,
            text: s.text,
          });
          if (this.ftsAvailable) {
            ftsRows.push({ id, text: buildIndexableText(s.name, s.signature, s.docComment) });
          }
          if (this.vectorsAvailable) {
            vectorRows.push({
              id,
              vector: encodeVector(
                embedText(s.text || buildIndexableText(s.name, s.signature, s.docComment)),
              ),
            });
          }
          result.push({ ...s, id });
        }
        bulkInsertSymbolsWithStatement((sql) => this.stmt(sql), IndexStore.MAX_SQL_VARS, bulk);
        bulkInsertFtsWithStatement(
          (sql) => this.stmt(sql),
          IndexStore.MAX_SQL_VARS,
          this.ftsAvailable,
          ftsRows,
        );
        if (this.vectorsAvailable) {
          bulkInsertVectorsWithStatement(
            (sql) => this.stmt(sql),
            IndexStore.MAX_SQL_VARS,
            vectorRows,
          );
        }

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
        this.stmt('DELETE FROM symbols WHERE file = ?').run(file);
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
        this.stmt('DELETE FROM symbols WHERE file = ?').run(file);
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
    this.runWithRetry(() => {
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
    });
  }

  getFileMeta(file: string): FileMeta | null {
    return getFileMetaWithStatement((sql) => this.stmt(sql), file);
  }

  getAllFileMetas(): FileMeta[] {
    return getAllFileMetasWithStatement((sql) => this.stmt(sql));
  }

  setFilePackages(entries: ReadonlyMap<string, string>): void {
    if (entries.size === 0) return;
    this.runWithRetry(() => {
      const update = this.stmt('UPDATE files SET package = ? WHERE file = ?');
      for (const [file, label] of entries) update.run(label, file);
    });
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
        this.stmt('DELETE FROM symbols WHERE file = ?').run(meta.file);
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
    try {
      this.db.exec('PRAGMA optimize');
    } catch {
      /* optional */
    }
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
    try {
      const probe = this.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as
        | { busy?: number }
        | undefined;
      if (Number(probe?.busy ?? 1) !== 0) return false;
      const done = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
        | { busy?: number }
        | undefined;
      return Number(done?.busy ?? 1) === 0;
    } catch {
      return false;
    }
  }

  compactIfNeeded(options: { minBytes?: number; minFreeRatio?: number } = {}): boolean {
    const minBytes = options.minBytes ?? 256 * 1024 * 1024;
    const minFreeRatio = options.minFreeRatio ?? 0.35;
    try {
      const pageCount = Number(
        (this.stmt('PRAGMA page_count').get() as { page_count?: number } | undefined)?.page_count ??
          0,
      );
      const pageSize = Number(
        (this.stmt('PRAGMA page_size').get() as { page_size?: number } | undefined)?.page_size ?? 0,
      );
      const freePages = Number(
        (this.stmt('PRAGMA freelist_count').get() as { freelist_count?: number } | undefined)
          ?.freelist_count ?? 0,
      );
      if (
        pageCount <= 0 ||
        pageSize <= 0 ||
        pageCount * pageSize < minBytes ||
        freePages / pageCount < minFreeRatio
      ) {
        return false;
      }
      this.runWithRetry(() => {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        this.db.exec('VACUUM');
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      });
      return true;
    } catch {
      return false;
    }
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
