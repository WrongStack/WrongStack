import { expectDefined } from '@wrongstack/core/utils';
/**
 * SQLite storage layer for the codebase index.
 *
 * Uses `node:sqlite` (synchronous API — DatabaseSync class).
 * Database file: ~/.wrongstack/projects/<hash>/codebase-index/index.db — kept
 * out of the repo so it never clutters the working tree or needs gitignoring.
 *
 * ### Multi-process safety
 *
 * Several wstack surfaces (TUI, WebUI, parallel terminals) share this per-project
 * database. WAL mode allows concurrent reads alongside a writer, and
 * `busy_timeout` bounds how long a write operation waits for the lock. When
 * the timeout expires and SQLite returns SQLITE_BUSY, the store retries with
 * exponential backoff (up to 3 attempts) before letting the error propagate.
 * If all retries are exhausted, a {@link LockError} is thrown — the circuit
 * breaker treats this as a transient condition and does NOT count it as a failure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type Bm25Index, buildBm25Index, buildIndexableText, tokenise } from './bm25.js';
import { lspKindToInternalKind } from './lsp-kind.js';
import type {
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
import {
  getAllFileMetasWithStatement,
  getAllIndexableWithStatement,
  getFileMetaWithStatement,
  getMaxSymbolIdWithStatement,
  getMetadataWithStatement,
  getStatsWithStatement,
} from './writer-admin.js';
import {
  type BulkSymbolRow,
  bulkInsertFtsWithStatement,
  bulkInsertRefsWithStatement,
  bulkInsertSymbolsWithStatement,
} from './writer-bulk-insert.js';
import {
  findRefsFromWithStatement,
  findRefsToWithStatement,
  getFileGraphWithStatement,
  getPackageGraphWithStatement,
  getSymbolGraphWithStatement,
} from './writer-graph-reader.js';
import { assignRefsToSymbols, escapeLike, resolveIndexDir } from './writer-helpers.js';
import { applyIndexStorePragmas } from './writer-pragmas.js';
import {
  CORE_TABLES_SQL,
  METADATA_TABLE_SQL,
  REFS_INDEX_SQL,
  REFS_TABLE_SQL,
  SYMBOL_INDEX_SQL,
  SYMBOLS_FTS_SQL,
} from './writer-schema.js';
import {
  buildWriterSearchWhere,
  mapWriterSearchRow,
  normalizeSearchLimit,
  type WriterSearchFilter,
  type WriterSearchRow,
} from './writer-search-helpers.js';
import { StorePool } from './writer-store-pool.js';

export { codebaseIndexDirOverride, resolveIndexDir } from './writer-helpers.js';
export { StorePool } from './writer-store-pool.js';

const DB_FILE = 'index.db';

export class IndexStore {
  private db: DatabaseSync;
  /** Absolute path to this project's index directory. */
  private readonly indexDir: string;
  /**
   * True when the SQLite build provides FTS5 (Node's bundled SQLite does).
   * When false, ranked search falls back to the LIKE + in-process BM25 path.
   */
  private ftsAvailable = false;

  /**
   * Cache of prepared statements keyed by their SQL text. `DatabaseSync`
   * compiles SQL on every `.prepare()` call; for the fixed-SQL methods
   * (upsertFile, getFileMeta, deleteFile, insertRefs, …) that runs thousands
   * of times during a full reindex. `StatementSync` objects are reusable
   * across calls on the same connection, so we compile each distinct SQL once
   * and reuse it. Cleared in {@link close} when the connection is torn down.
   */
  private readonly stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  /**
   * Cached full-corpus BM25 index for the FTS5-unavailable fallback path.
   * Built lazily on the first `searchRankedFallback` call and invalidated
   * (via `bm25Dirty`) whenever the `symbols` table is mutated. Computing
   * IDF over the full corpus is also more correct than the old per-query
   * candidate-subset IDF.
   *
   * Cache-lifecycle invariants (single source of truth lives at the
   * `invalidateBm25()` helper — see its docblock for the "every mutation
   * MUST call this" contract):
   *   - declaration: this field + `bm25Dirty` (here)
   *   - invalidation: `invalidateBm25()` flips the flag and nulls the cache
   *   - build: `getOrBuildBm25()` rebuilds against current `symbols` rows
   *   - teardown: `close()` resets the flag and nulls the cache
   */
  private bm25Cache: Bm25Index | null = null;
  // Dirty on open so the first getOrBuildBm25() rebuilds against current rows;
  // an empty or pre-existing corpus makes a stale IDF table meaningless.
  private bm25Dirty = true;

  /** Prepare-once helper: compile `sql` on first use, reuse thereafter. */
  private stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let s = this.stmtCache.get(sql);
    if (s === undefined) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
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

  private initSchema(): void {
    this.db.exec(METADATA_TABLE_SQL);

    // Schema migration: the index is derived, rebuildable data — on any
    // version mismatch we drop everything and let the next index run repopulate
    // from source, instead of maintaining per-version migration scripts.
    const storedRows = this.stmt('SELECT value FROM metadata WHERE key = ?').all('version') as {
      value: string;
    }[];
    const storedVersion = storedRows.length ? Number(storedRows[0]?.value) : null;
    if (storedVersion !== null && storedVersion !== SCHEMA_VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS symbols;
        DROP TABLE IF EXISTS files;
        DROP TABLE IF EXISTS refs;
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
    for (const sql of SYMBOL_INDEX_SQL) this.db.exec(sql);
    this.db.exec(REFS_TABLE_SQL);
    for (const sql of REFS_INDEX_SQL) this.db.exec(sql);

    // FTS5 full-text index over the camelCase-split symbol text; rowid is the
    // symbol id. Replaces the old `LIKE '%token%'` full-table scan + per-query
    // in-process BM25 build: MATCH uses the inverted index and bm25() ranks
    // natively. Kept in sync explicitly in insertSymbols/delete*/clearAll.
    try {
      this.db.exec(SYMBOLS_FTS_SQL);
      this.ftsAvailable = true;
      // A database may have been populated by a runtime without FTS5. Backfill
      // the derived table when FTS later becomes available instead of making
      // every historical symbol invisible until a forced rebuild.
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
        // The drift repair doesn't mutate `symbols`, but the drift may have
        // been caused by an external mutation that left the BM25 cache stale.
        // Invalidate so the next fallback search rebuilds from the repaired
        // FTS state rather than serving a frozen corpus.
        this.invalidateBm25();
      }
    } catch {
      // SQLite built without FTS5 — searchRanked falls back to LIKE + BM25.
      this.ftsAvailable = false;
    }

    // Seed the symbol-id sequence once. Subsequent allocations are O(1)
    // metadata updates instead of SELECT MAX(id) on every insert batch.
    this.ensureNextSymbolIdSeeded();
  }

  // ─── ID allocation & bulk helpers ────────────────────────────────────────────

  private static readonly NEXT_SYMBOL_ID_KEY = 'next_symbol_id';
  /** Stay under typical SQLite SQLITE_MAX_VARIABLE_NUMBER (often 999). */
  private static readonly MAX_SQL_VARS = 900;

  /**
   * Ensure `metadata.next_symbol_id` exists. Safe to call outside a write
   * transaction on open; the first concurrent writer under BEGIN IMMEDIATE
   * re-reads and advances the counter atomically.
   */
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

  /**
   * Reserve `count` consecutive symbol ids. MUST run inside BEGIN IMMEDIATE
   * so concurrent indexers cannot hand out overlapping ranges.
   */
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

  /**
   * Disconnect inbound refs before their target symbols are replaced and
   * return the affected names for scoped re-resolution.
   *
   * This also repairs a long-standing dangling-id edge case: `refs.to_id` has
   * no physical FK, so deleting a symbol previously left callers pointing at a
   * non-existent row.
   */
  private invalidateIncomingRefsForFiles(files: string[]): string[] {
    if (files.length === 0) return [];
    const placeholders = files.map(() => '?').join(',');
    const names = (
      this.stmt(`SELECT DISTINCT name FROM symbols WHERE file IN (${placeholders})`).all(
        ...files,
      ) as Array<{ name: string }>
    ).map((row) => row.name);
    this.stmt(
      `UPDATE refs SET to_id = NULL
       WHERE to_id IN (SELECT id FROM symbols WHERE file IN (${placeholders}))`,
    ).run(...files);
    return names;
  }

  /** Resolve only refs whose target names may have changed. */
  private resolveRefsForNamesUnsafe(names: Iterable<string>): number {
    const unique = [...new Set(names)].filter(Boolean);
    let changes = 0;
    for (let start = 0; start < unique.length; start += IndexStore.MAX_SQL_VARS) {
      const chunk = unique.slice(start, start + IndexStore.MAX_SQL_VARS);
      const placeholders = chunk.map(() => '?').join(',');
      const result = this.stmt(
        `UPDATE refs
         SET to_id = (SELECT MIN(id) FROM symbols WHERE name = refs.to_name)
         WHERE to_name IN (${placeholders})`,
      ).run(...chunk) as { changes?: number };
      changes += result.changes ?? 0;
    }
    return changes;
  }

  // ─── Symbol CRUD ─────────────────────────────────────────────────────────────

  /**
   * Insert symbols, assigning IDs atomically inside `BEGIN IMMEDIATE` /
   * `COMMIT`. Id ranges come from the `next_symbol_id` metadata counter
   * (O(1)); multi-row INSERT amortizes bind overhead for large files.
   *
   * @returns The symbols array with `id` fields populated so the caller can
   *          use them for refs without re-reading from the DB.
   */
  insertSymbols(symbols: IndexSymbol[]): IndexSymbol[] {
    this.invalidateBm25();
    return this.runWithRetry(() => {
      // BEGIN IMMEDIATE serializes writers so allocateSymbolIds cannot overlap.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        let nextId = this.allocateSymbolIds(symbols.length);
        const result: IndexSymbol[] = [];
        const bulk: BulkSymbolRow[] = [];
        const ftsRows: Array<{ id: number; text: string }> = [];

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
          result.push({ ...s, id });
        }
        bulkInsertSymbolsWithStatement((sql) => this.stmt(sql), IndexStore.MAX_SQL_VARS, bulk);
        bulkInsertFtsWithStatement(
          (sql) => this.stmt(sql),
          IndexStore.MAX_SQL_VARS,
          this.ftsAvailable,
          ftsRows,
        );

        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  deleteSymbolsForFile(file: string): void {
    this.invalidateBm25();
    this.runWithRetry(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const affectedNames = this.invalidateIncomingRefsForFiles([file]);
        if (this.ftsAvailable) {
          this.stmt(
            'DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_fk = ?)',
          ).run(file);
        }
        this.stmt('DELETE FROM symbols WHERE file_fk = ?').run(file);
        this.resolveRefsForNamesUnsafe(affectedNames);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  /**
   * Remove every trace of a file (refs, symbols, FTS rows, file meta). Used
   * when a source file disappears between index runs — previously this only
   * dropped the `files` row, leaving its symbols orphaned but still searchable.
   */
  deleteFile(file: string): void {
    this.invalidateBm25();
    this.runWithRetry(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const affectedNames = this.invalidateIncomingRefsForFiles([file]);
        if (this.ftsAvailable) {
          this.stmt(
            'DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_fk = ?)',
          ).run(file);
        }
        this.stmt(
          'DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file_fk = ?)',
        ).run(file);
        this.stmt('DELETE FROM symbols WHERE file_fk = ?').run(file);
        this.stmt('DELETE FROM files WHERE file = ?').run(file);
        this.resolveRefsForNamesUnsafe(affectedNames);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  // ─── File metadata ──────────────────────────────────────────────────────────

  upsertFile(meta: FileMeta): void {
    this.runWithRetry(() => {
      this.stmt(
        `INSERT INTO files(file, lang, mtime_ms, symbol_count, last_indexed)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(file) DO UPDATE SET
           lang = excluded.lang,
           mtime_ms = excluded.mtime_ms,
           symbol_count = excluded.symbol_count,
           last_indexed = excluded.last_indexed`,
      ).run(meta.file, meta.lang, meta.mtimeMs, meta.symbolCount, meta.lastIndexed);
    });
  }

  getFileMeta(file: string): FileMeta | null {
    return getFileMetaWithStatement((sql) => this.stmt(sql), file);
  }

  getAllFileMetas(): FileMeta[] {
    return getAllFileMetasWithStatement((sql) => this.stmt(sql));
  }

  // ─── Search ──────────────────────────────────────────────────────────────────

  search(
    query: string,
    filter?: WriterSearchFilter,
    opts?: { limit?: number | undefined },
  ): SearchResult[] {
    const built = this.buildSearchWhere(query, filter);
    if (built === null) return [];

    const { where, values } = built;
    const limit = normalizeSearchLimit(opts?.limit);
    const limitSql = limit !== undefined ? ' LIMIT ?' : '';
    const sql = `SELECT id, lang, kind, name, file, line, col, signature, doc_comment, text FROM symbols ${where}${limitSql}`;

    const binds = limit !== undefined ? [...values, limit] : values;
    const rows = this.stmt(sql).all(
      ...(binds as (string | number)[]),
    ) as unknown as WriterSearchRow[];

    return rows.map((row) => mapWriterSearchRow(row, filter?.lspKind));
  }

  /** Shared WHERE builder for {@link search} / empty-query ranked totals. */
  private buildSearchWhere(query: string, filter?: WriterSearchFilter | undefined) {
    return buildWriterSearchWhere(query, filter);
  }

  private countSearch(query: string, filter?: WriterSearchFilter | undefined): number {
    const built = this.buildSearchWhere(query, filter);
    if (built === null) return 0;
    const row = this.stmt(`SELECT COUNT(*) AS n FROM symbols ${built.where}`).get(
      ...(built.values as (string | number)[]),
    ) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * Ranked search — the one-stop query the codebase-search tool and plug-lsp
   * use. With FTS5 this is a single indexed `MATCH` ranked by SQLite's native
   * `bm25()` with a built-in `snippet()`; without FTS5 it falls back to the
   * legacy LIKE scan + in-process BM25 (identical semantics, slower).
   *
   * Tokens are matched as prefixes (`"tok"*`), mirroring the old
   * `LIKE '%tok%'` recall for the common symbol-search shapes ("user" finds
   * "users", camelCase-split text makes "complex" find "complexOperation").
   */
  searchRanked(
    query: string,
    filter: WriterSearchFilter | undefined,
    limit: number,
  ): { results: SearchResult[]; total: number } {
    const rawLimit = Number.isFinite(limit) ? Math.trunc(limit) : 20;
    const safeLimit = Math.max(1, Math.min(rawLimit, 100));
    const tokens = tokenise(query);
    // No usable tokens → plain filtered listing (matches old `search('')`).
    if (tokens.length === 0 || !this.ftsAvailable) {
      return this.searchRankedFallback(query, filter, safeLimit);
    }

    let effectiveKind: SymbolKind | undefined = filter?.kind;
    if (filter?.lspKind !== undefined) {
      const mapped = lspKindToInternalKind(filter.lspKind);
      if (mapped === null) return { results: [], total: 0 };
      effectiveKind = mapped;
    }

    // Each token is quoted (neutralises FTS5 query syntax) and prefix-starred.
    const match = tokens.map((t) => `"${t.replaceAll('"', '')}"*`).join(' OR ');

    const conditions: string[] = ['symbols_fts MATCH ?'];
    const values: (string | number)[] = [match];
    if (effectiveKind) {
      conditions.push('s.kind = ?');
      values.push(effectiveKind);
    }
    if (filter?.lang) {
      conditions.push('s.lang = ?');
      values.push(filter.lang);
    }
    if (filter?.file) {
      conditions.push("replace(s.file, '\\', '/') LIKE ? ESCAPE '\\'");
      values.push(`%${escapeLike(filter.file.replace(/\\/g, '/'))}%`);
    }
    const where = conditions.join(' AND ');

    const countRows = this.stmt(
      `SELECT COUNT(*) AS n FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid WHERE ${where}`,
    ).all(...values) as { n: number }[];
    const total = countRows[0] ? Number(countRows[0].n) : 0;
    if (total === 0) return { results: [], total: 0 };

    const rows = this.stmt(
      `SELECT s.id, s.lang, s.kind, s.name, s.file, s.line, s.col, s.signature, s.doc_comment,
                -bm25(symbols_fts) AS score,
                snippet(symbols_fts, 0, '', '', '…', 12) AS snippet
         FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
         WHERE ${where}
         ORDER BY
           CASE WHEN lower(s.name) = lower(?) THEN 0
                WHEN lower(s.name) LIKE lower(?) ESCAPE '\\' THEN 1
                ELSE 2 END,
           bm25(symbols_fts), lower(s.name), s.file, s.line, s.col, s.id
         LIMIT ?`,
    ).all(...values, query.trim(), `${escapeLike(query.trim())}%`, safeLimit) as {
      id: number;
      lang: string;
      kind: string;
      name: string;
      file: string;
      line: number;
      col: number;
      signature: string;
      doc_comment: string;
      score: number;
      snippet: string;
    }[];

    return {
      results: rows.map((row) =>
        mapWriterSearchRow(row, filter?.lspKind, Math.max(0.0001, row.score), row.snippet),
      ),
      total,
    };
  }

  /**
   * Invalidate the cached BM25 index.
   *
   * **Contract: every method that mutates `symbols` MUST call this before
   * returning.** (`refs` mutations do not affect the BM25 fallback because
   * the corpus is built from `symbols.text` via `getAllIndexable()` and the
   * BM25 score is filtered by the LIKE-selected candidate set in
   * `searchRankedFallback`.) Today the call sites are `repairDrift`,
   * `insertSymbols`, `deleteSymbolsForFile`, `deleteFile`, `clearAll`, and
   * `commitBatch`. A future mutation that adds a new write path (e.g.
   * `renameFile`, `updateSignature`) MUST also call this — otherwise the
   * FTS5-unavailable fallback will serve stale search results. The
   * `close()` reset at L1820-1821 tears the cache down on store shutdown,
   * which is the only legitimate place that flips the flag outside this
   * helper.
   *
   * Called *before* `runWithRetry` on purpose: if the write fails all
   * retries the flag stays set, forcing a rebuild on the next search rather
   * than trusting a cache that may not reflect the intended mutation.
   * Do not move this inside the retry closure.
   */
  private invalidateBm25(): void {
    this.bm25Dirty = true;
    this.bm25Cache = null;
  }

  /**
   * Return the cached full-corpus BM25 index, rebuilding it only when the
   * symbols table has been mutated since the last build. The full-corpus IDF
   * is more correct than the old per-query candidate-subset IDF, and the
   * amortized build cost drops from O(symbols × tokens) per search to once
   * per write batch.
   *
   * Note: the first call after a long idle (or on a freshly opened store)
   * pays the full corpus rebuild synchronously on the search path. For a
   * 5 500+ symbol corpus this is a visible one-time latency spike.
   */
  private getOrBuildBm25(): Bm25Index {
    if (this.bm25Cache && !this.bm25Dirty) return this.bm25Cache;
    const docs = this.getAllIndexable();
    this.bm25Cache = buildBm25Index(docs);
    this.bm25Dirty = false;
    return this.bm25Cache;
  }

  /** Legacy ranked path: LIKE candidates + in-process BM25 + JS snippets. */
  private searchRankedFallback(
    query: string,
    filter: WriterSearchFilter | undefined,
    limit: number,
  ): { results: SearchResult[]; total: number } {
    // Empty query = filtered listing: push LIMIT into SQL so a 10k-symbol
    // corpus never materializes fully just to take the first N rows.
    if (!query.trim()) {
      const total = this.countSearch(query, filter);
      if (total === 0) return { results: [], total: 0 };
      return { results: this.search(query, filter, { limit }), total };
    }

    const candidates = this.search(query, filter);
    if (candidates.length === 0) return { results: [], total: 0 };

    const candidateById = new Map(candidates.map((c) => [c.id, c]));
    // Use the cached full-corpus BM25 index instead of rebuilding from the
    // LIKE candidate subset on every query. The filter restricts scoring to
    // candidates; full-corpus IDF is more correct than subset IDF.
    const bm25 = this.getOrBuildBm25();
    const scored = bm25.score(query, (id) => candidateById.has(id));
    const q = query.trim().toLowerCase();
    const rank = (id: number): number => {
      const name = candidateById.get(id)?.name.toLowerCase() ?? '';
      if (name === q) return 0;
      if (name.startsWith(q)) return 1;
      return 2;
    };
    scored.sort((a, b) => {
      const rankDiff = rank(a.id) - rank(b.id);
      if (rankDiff !== 0) return rankDiff;
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      const left = expectDefined(candidateById.get(a.id));
      const right = expectDefined(candidateById.get(b.id));
      return (
        left.name.localeCompare(right.name) ||
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.col - right.col ||
        left.id - right.id
      );
    });
    const qTokens = tokenise(query);

    const results = scored.slice(0, limit).map(({ id, score }) => {
      const c = expectDefined(candidateById.get(id));
      return { ...c, score, snippet: bm25.extractSnippet(id, qTokens) };
    });
    return { results, total: candidates.length };
  }

  getAllIndexable(): Array<{ id: number; text: string }> {
    return getAllIndexableWithStatement((sql) => this.stmt(sql));
  }

  /**
   * Largest symbol id currently in the table (0 when empty). New ids must be
   * allocated from this, NOT from `COUNT(*)`: incremental reindexes delete a
   * changed file's rows, so the row count drops below the max id and a
   * count-based id would collide with a surviving row (UNIQUE constraint on
   * `symbols.id`). Ids may have gaps — that is fine.
   */
  getMaxSymbolId(): number {
    return getMaxSymbolIdWithStatement((sql) => this.stmt(sql));
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  getStats(): IndexStats {
    return getStatsWithStatement((sql) => this.stmt(sql), this.indexDir);
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
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // DROP+CREATE is O(1) page-truncation vs DELETE's full-table scan.
        // Force-rebuilds (schema version change, manual /codebase-reindex)
        // were spending hundreds of ms on row-by-row deletion of thousands of
        // symbols and refs. DROP is instant regardless of table size.
        this.db.exec('DROP TABLE IF EXISTS refs');
        this.db.exec('DROP TABLE IF EXISTS symbols');
        this.db.exec('DROP TABLE IF EXISTS files');
        this.db.exec('DROP TABLE IF EXISTS metadata');
        if (this.ftsAvailable) this.db.exec('DROP TABLE IF EXISTS symbols_fts');
        this.db.exec('COMMIT');
        // Clear statement cache — prepared stmts reference the now-dropped tables.
        this.stmtCache.clear();
        this.initSchema();
        // Reset the symbol-id counter to 1 so repeated forced rebuilds
        // don't allocate from a monotonically growing id namespace.
        this.stmt('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run(
          IndexStore.NEXT_SYMBOL_ID_KEY,
          '1',
        );
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  // ─── Ref CRUD ────────────────────────────────────────────────────────────────

  /**
   * Insert cross-references for a given source symbol id.
   * Replaces any existing refs from the same source (idempotent on re-index).
   */
  insertRefs(fromId: number, refs: Ref[]): void {
    this.runWithRetry(() => {
      // Delete old refs from this symbol (handles re-index)
      this.stmt('DELETE FROM refs WHERE from_id = ?').run(fromId);
      if (refs.length === 0) return;
      bulkInsertRefsWithStatement(
        (sql) => this.stmt(sql),
        IndexStore.MAX_SQL_VARS,
        refs.map((ref) => ({ ...ref, fromId })),
      );
    });
  }

  /**
   * Bulk-insert refs for many source symbols in a single transaction.
   *
   * Unlike {@link insertRefs} this does NOT delete per source id — the caller
   * (the indexer) has already cleared stale refs for the file via
   * {@link deleteRefsForFile}, so the per-source DELETE would be redundant work
   * repeated once per symbol. One transaction for the whole file instead of one
   * per symbol turns an O(symbols) transaction count into O(1).
   *
   * Each ref's own {@link Ref.fromId} is used; pass an empty array to no-op.
   */
  insertRefsBatch(refs: Ref[]): void {
    if (refs.length === 0) return;
    this.runWithRetry(() => {
      bulkInsertRefsWithStatement((sql) => this.stmt(sql), IndexStore.MAX_SQL_VARS, refs);
    });
  }

  /**
   * Commit a batch of file-level symbol/refs/upserts in a single transaction.
   *
   * Used by the indexer to amortize SQLite commit overhead across many files.
   * Before this, the indexer issued one transaction per file (BEGIN IMMEDIATE
   * for symbols, plus per-file deletes and an upsertFile call), so a 20-file
   * parallel batch cost ~5+ transactions × 20 files = 100+ commits. With
   * this entry point we do exactly one BEGIN/COMMIT per parallel batch.
   *
   * Each entry must already be a fully-parsed FileSymbols (symbols + refs).
   * The caller is responsible for the per-file prefix accounting
   * (refsByLine → flat list with `fromId` populated). `deleteForFiles` lets
   * the caller clear stale symbols/refs for any files being re-indexed before
   * the inserts run (required to keep refs → symbols FK invariants).
   *
   * Returns the symbols back with their assigned `id` (same shape as
   * {@link insertSymbols}) so callers can build final per-file results.
   */
  commitBatch(
    entries: Array<{
      file: string;
      lang: SymbolLang;
      symbols: IndexSymbol[];
      refs: Ref[];
      mtimeMs: number;
      symbolCount: number;
    }>,
    options: { deleteForFiles?: string[] | undefined } = {},
  ): IndexSymbol[] {
    if (entries.length === 0 && (options.deleteForFiles?.length ?? 0) === 0) {
      return [];
    }
    this.invalidateBm25();
    return this.runWithRetry(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const affectedNames = new Set<string>();
        for (const entry of entries) {
          for (const symbol of entry.symbols) affectedNames.add(symbol.name);
          for (const ref of entry.refs) affectedNames.add(ref.toName);
        }
        // 1) Clear stale refs+symbols for any files being re-indexed.
        if (options.deleteForFiles && options.deleteForFiles.length > 0) {
          const placeholders = options.deleteForFiles.map(() => '?').join(',');
          for (const name of this.invalidateIncomingRefsForFiles(options.deleteForFiles)) {
            affectedNames.add(name);
          }
          if (this.ftsAvailable) {
            this.stmt(
              `DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file IN (${placeholders}))`,
            ).run(...options.deleteForFiles);
          }
          // Refs first (FK direction: refs.from_id → symbols.id).
          this.stmt(
            `DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file IN (${placeholders}))`,
          ).run(...options.deleteForFiles);
          this.stmt(`DELETE FROM symbols WHERE file IN (${placeholders})`).run(
            ...options.deleteForFiles,
          );
        }

        // 2) Assign ids + multi-row insert symbols (+ FTS).
        const totalSymbols = entries.reduce((n, e) => n + e.symbols.length, 0);
        let nextId = this.allocateSymbolIds(totalSymbols);

        const allInserted: IndexSymbol[] = [];
        const refsToInsert: Ref[] = [];
        const bulkSyms: BulkSymbolRow[] = [];
        const ftsRows: Array<{ id: number; text: string }> = [];

        for (const entry of entries) {
          const insertedForEntry: IndexSymbol[] = [];
          for (const s of entry.symbols) {
            const id = nextId++;
            bulkSyms.push({
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
              ftsRows.push({
                id,
                text: buildIndexableText(s.name, s.signature, s.docComment),
              });
            }
            const inserted = { ...s, id };
            allInserted.push(inserted);
            insertedForEntry.push(inserted);
          }
          refsToInsert.push(...assignRefsToSymbols(entry.refs, insertedForEntry));
        }

        bulkInsertSymbolsWithStatement((sql) => this.stmt(sql), IndexStore.MAX_SQL_VARS, bulkSyms);
        bulkInsertFtsWithStatement(
          (sql) => this.stmt(sql),
          IndexStore.MAX_SQL_VARS,
          this.ftsAvailable,
          ftsRows,
        );

        // 3) Multi-row insert all refs.
        bulkInsertRefsWithStatement((sql) => this.stmt(sql), IndexStore.MAX_SQL_VARS, refsToInsert);

        // 4) Upsert file metadata for every entry (small N — single-row is fine).
        const upsertStmt = this.stmt(
          `INSERT INTO files(file, lang, mtime_ms, symbol_count, last_indexed)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(file) DO UPDATE SET
             lang = excluded.lang,
             mtime_ms = excluded.mtime_ms,
             symbol_count = excluded.symbol_count,
             last_indexed = excluded.last_indexed`,
        );
        const now = Date.now();
        for (const entry of entries) {
          upsertStmt.run(entry.file, entry.lang, entry.mtimeMs, entry.symbolCount, now);
        }

        this.resolveRefsForNamesUnsafe(affectedNames);
        this.db.exec('COMMIT');
        return allInserted;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  /**
   * Delete all refs whose source symbols are in a given file.
   * Used when re-indexing a file to clear stale refs.
   */
  deleteRefsForFile(file: string): void {
    this.runWithRetry(() => {
      this.stmt('DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file = ?)').run(
        file,
      );
    });
  }

  /**
   * Resolve `to_name` → `to_id` for all refs that have a name but no id.
   * Call this after all symbols have been inserted to fill in cross-references.
   *
   * Single statement: the `to_name IN (SELECT name FROM symbols)` guard restricts
   * the UPDATE to refs that will actually resolve, so `.changes` counts only refs
   * that found a target — matching the previous per-row loop's return value.
   */
  resolveRefs(): number {
    return this.runWithRetry(() => {
      // Prefer UPDATE-FROM with a pre-aggregated name→id map (SQLite ≥ 3.33).
      // One hash join instead of a correlated subquery per unresolved row.
      // MIN(id) matches the previous LIMIT 1 / arbitrary-first semantics when
      // multiple symbols share a name.
      try {
        const result = this.stmt(
          `UPDATE refs
           SET to_id = s.id
           FROM (
             SELECT name, MIN(id) AS id FROM symbols GROUP BY name
           ) AS s
           WHERE refs.to_id IS NULL
             AND refs.to_name IS NOT NULL
             AND refs.to_name = s.name`,
        ).run() as { changes?: number };
        return result.changes ?? 0;
      } catch {
        const result = this.stmt(
          `UPDATE refs SET to_id = (
             SELECT id FROM symbols WHERE name = refs.to_name LIMIT 1
           ) WHERE to_id IS NULL AND to_name IS NOT NULL
             AND to_name IN (SELECT name FROM symbols)`,
        ).run() as { changes?: number };
        return result.changes ?? 0;
      }
    });
  }

  resolveRefsForNames(names: Iterable<string>): number {
    return this.runWithRetry(() => this.resolveRefsForNamesUnsafe(names));
  }

  /**
   * Clear symbols/refs for a file and mark it as indexed with zero symbols.
   * Used by the indexer for empty-parse results so three writes share one txn.
   */
  replaceEmptyFile(meta: FileMeta): void {
    this.invalidateBm25();
    this.runWithRetry(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const affectedNames = this.invalidateIncomingRefsForFiles([meta.file]);
        if (this.ftsAvailable) {
          this.stmt(
            'DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_fk = ?)',
          ).run(meta.file);
        }
        this.stmt(
          'DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file_fk = ?)',
        ).run(meta.file);
        this.stmt('DELETE FROM symbols WHERE file_fk = ?').run(meta.file);
        this.stmt(
          `INSERT INTO files(file, lang, mtime_ms, symbol_count, last_indexed)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(file) DO UPDATE SET
             lang = excluded.lang,
             mtime_ms = excluded.mtime_ms,
             symbol_count = excluded.symbol_count,
             last_indexed = excluded.last_indexed`,
        ).run(meta.file, meta.lang, meta.mtimeMs, meta.symbolCount, meta.lastIndexed);
        this.resolveRefsForNamesUnsafe(affectedNames);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  /** Best-effort query planner refresh after a large reindex. */
  optimize(): void {
    try {
      this.db.exec('PRAGMA optimize');
    } catch {
      /* optional */
    }
  }

  /**
   * Reclaim page churn left by repeated force rebuilds.
   *
   * SQLite's DROP/CREATE path makes rebuilds fast but leaves pages on the
   * freelist. Compact only large, materially sparse databases and only when the
   * caller is already on a full-index maintenance path.
   */
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
      // Compaction is maintenance, never a reason to fail a valid index run.
      return false;
    }
  }

  /**
   * Find all references TO a given symbol (who calls / uses this symbol?).
   */
  findRefsTo(symbolId: number): Ref[] {
    return findRefsToWithStatement((sql) => this.stmt(sql), symbolId);
  }

  /**
   * Find all references FROM a given symbol (what does this symbol call/use?).
   */
  findRefsFrom(symbolId: number): Ref[] {
    return findRefsFromWithStatement((sql) => this.stmt(sql), symbolId);
  }

  // ─── CodeMap graph aggregation ──────────────────────────────────────────────

  /**
   * Package-level graph: each workspace package is a node; edges are derived
   * from cross-package symbol references (a symbol in package A references a
   * symbol resolved in package B). Node metadata includes symbol/file counts.
   */
  getPackageGraph(): CodeMapGraph {
    return getPackageGraphWithStatement((sql) => this.stmt(sql));
  }

  /**
   * File-level graph for a single package: each file is a node; edges are
   * derived from cross-file symbol references within the package.
   */
  getFileGraph(packageFilter: string): CodeMapGraph {
    return getFileGraphWithStatement((sql) => this.stmt(sql), packageFilter);
  }

  /**
   * Symbol-level graph for a single file: each symbol is a node; edges are
   * derived from intra-file and cross-file symbol references (who calls whom).
   */
  getSymbolGraph(fileFilter: string): CodeMapGraph {
    return getSymbolGraphWithStatement((sql) => this.stmt(sql), fileFilter);
  }

  /**
   * Returns every symbol in the index. Used by dead-code analysis to
   * build the full symbol universe for the reachability scan.
   */
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

  /**
   * Returns every resolved reference (to_id IS NOT NULL). Used by
   * dead-code analysis to build the consumer-ship graph. Refs whose
   * target symbol id is null (unresolved imports) are excluded.
   */
  getAllResolvedRefs(): Array<{
    fromId: number;
    toId: number;
    callType: string;
  }> {
    return this.stmt(
      'SELECT from_id AS fromId, to_id AS toId, call_type AS callType FROM refs WHERE to_id IS NOT NULL',
    ).all() as Array<{ fromId: number; toId: number; callType: string }>;
  }

  /**
   * Returns ALL import refs (including unresolved) with their source-file
   * path and resolved target id.  Used by the dead-code scan's file-level
   * graph traversal to handle barrel-only entry points where no symbol
   * carries the ref.
   *
   * Refs whose `from_id` doesn't match a known symbol (e.g. pure-barrel
   * files with no declarations) will have `sourceFile === null`.
   */
  getAllImportRefs(): Array<{
    /** Source-file path (null when the owning symbol can't be resolved). */
    sourceFile: string | null;
    toName: string;
    /** Resolved target symbol id (null when the name couldn't be matched). */
    toId: number | null;
    callType: string;
    line: number;
  }> {
    return this.stmt(
      `SELECT s.file AS sourceFile, r.to_name AS toName, r.to_id AS toId,
              r.call_type AS callType, r.line
       FROM refs r
       LEFT JOIN symbols s ON r.from_id = s.id
       WHERE r.call_type = 'import'
       ORDER BY r.line`,
    ).all() as Array<{
      sourceFile: string | null;
      toName: string;
      toId: number | null;
      callType: string;
      line: number;
    }>;
  }

  close(): void {
    // Drop cached StatementSync references before closing; db.close() finalizes
    // them, and keeping the map would retain handles to a dead connection.
    this.stmtCache.clear();
    // Release the BM25 cache and mark dirty so a hypothetical reopen starts
    // from a clean slate instead of serving a stale index.
    this.bm25Dirty = true;
    this.bm25Cache = null;
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/** Process-wide singleton pool. */
export const indexStorePool = new StorePool(
  (projectRoot: string, opts?: { indexDir?: string | undefined }) =>
    new IndexStore(projectRoot, opts),
);
