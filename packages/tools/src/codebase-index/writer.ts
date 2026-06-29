import { expectDefined } from '@wrongstack/core';
import { LockError } from './circuit-breaker.js';
import { toErrorMessage } from '@wrongstack/core/utils';
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

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { resolveWstackPaths } from '@wrongstack/core';
import type { FileMeta, IndexStats, Ref, SearchResult, Symbol as IndexSymbol, SymbolKind, SymbolLang } from './schema.js';
import { SCHEMA_VERSION } from './schema.js';
import { lspKindToInternalKind } from './lsp-kind.js';
import { buildBm25Index, buildIndexableText, tokenise } from './bm25.js';
const DB_FILE = 'index.db';

/**
 * Resolve the per-project index directory. By default it lives under the
 * global project dir (`~/.wrongstack/projects/<hash>/codebase-index`),
 * matching every other piece of per-project state. Callers may pass an
 * explicit `override` (used by tests and any wiring that already resolved the
 * path) to avoid touching the real home directory.
 */
export function resolveIndexDir(projectRoot: string, override?: string): string {
  return override ?? resolveWstackPaths({ projectRoot }).projectCodebaseIndex;
}

/**
 * Optional index-directory override carried on the run context's `meta` bag.
 * Production leaves it unset (the index resolves to the global per-project
 * dir); tests and bespoke wiring set `meta.codebaseIndexDir` to redirect it.
 */
export function codebaseIndexDirOverride(ctx: { meta?: Record<string, unknown> }): string | undefined {
  const v = ctx.meta?.['codebaseIndexDir'];
  return typeof v === 'string' ? v : undefined;
}

let warningSilenced = false;
/**
 * Swallow the one-time `ExperimentalWarning: SQLite ...` Node prints the first
 * time `node:sqlite` loads. Patched only once, and only filters that specific
 * warning — every other warning passes through untouched.
 */
function silenceSqliteExperimentalWarning(): void {
  if (warningSilenced) return;
  warningSilenced = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
    const msg = typeof warning === 'string' ? warning : ((warning as Error)?.message ?? '');
    const name = typeof warning === 'string' ? String(rest[0] ?? '') : ((warning as Error)?.name ?? '');
    if (/sqlite/i.test(msg) && /experimental/i.test(`${name} ${msg}`)) return;
    (original as (w: unknown, ...r: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

let DatabaseSyncCtor: typeof DatabaseSync | undefined;
/**
 * Load `node:sqlite`'s `DatabaseSync` lazily. Keeping this off the module's
 * top-level import means the codebase-index tools can be registered at CLI boot
 * without eagerly loading SQLite — so a runtime that lacks `node:sqlite` (it is
 * experimental, available since Node 22.5) only fails if the index is actually
 * used, with a clear message instead of a crash on import.
 */
function loadDatabaseSync(): typeof DatabaseSync {
  if (DatabaseSyncCtor) return DatabaseSyncCtor;
  silenceSqliteExperimentalWarning();
  try {
    const req = createRequire(import.meta.url);
    DatabaseSyncCtor = (req('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  } catch (err) {
    throw new Error(
      "The codebase index needs Node's built-in SQLite (node:sqlite), available since Node 22.5. " +
        `This runtime doesn't provide it: ${toErrorMessage(err)}`,
    );
  }
  return DatabaseSyncCtor;
}

// ─── SQLite lock-error retry ───────────────────────────────────────────────────

/** Maximum retry attempts for a lock-conflict error. */
const MAX_LOCK_RETRIES = 3;
/**
 * Base delay (ms) before the first retry after a lock error. Each subsequent
 * retry doubles this (exponential backoff). Combined with the 5-second
 * busy_timeout pragma, this means: 5s (pragma) + 50ms + 100ms + 200ms per
 * attempt — enough to wait out most cross-process writer conflicts.
 */
const LOCK_RETRY_BASE_DELAY_MS = 50;
/** Cap on the per-retry delay so we never sleep for more than this. */
const LOCK_RETRY_MAX_DELAY_MS = 500;

/**
 * Returns true when `err` represents a SQLite lock conflict (SQLITE_BUSY or
 * SQLITE_LOCKED).  These are transient — another process holds the write lock
 * and will release it shortly.  Retry instead of failing.
 *
 * node:sqlite surfaces these as plain Error instances with `code` set to
 * 'SQLITE_BUSY' or 'SQLITE_LOCKED', or with a message that contains the
 * error name. Defensive: anything we can't classify as safe is NOT treated
 * as a lock error so real failures are not retried indefinitely.
 */
function isLockError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as { code?: unknown; sqliteCode?: unknown };
  const code = e.code ?? e.sqliteCode;
  if (typeof code === 'string' && /SQLITE_(BUSY|LOCKED)/.test(code)) return true;
  if (typeof code === 'number' && (code === 5 || code === 6)) return true; // SQLITE_BUSY=5, SQLITE_LOCKED=6
  // node:sqlite sometimes surfaces the numeric code as a string in the message
  if (/SQLITE_(BUSY|LOCKED)/.test(err.message)) return true;
  return false;
}

/**
 * Synchronous sleep via Atomics.wait on a zero-length SharedArrayBuffer.
 * This is the only way to synchronously block in a Worker thread without
 * busy-waiting.  The main thread (where DatabaseSync is never used) is
 * unaffected.
 *
 * The call is wrapped in try/catch because Atomics.wait throws in browsers
 * and other environments where SharedArrayBuffer is not available.
 */
function sleepSync(ms: number): void {
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
  } catch {
    // Atomics.wait not available (browser, unknown runtime) — fall through.
    // The retry still happens but without sleeping, which is acceptable because
    // busy_timeout already handled the bulk of the wait.
  }
}

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
   * Execute a SQLite write operation with automatic retry on lock conflicts.
   *
   * When another wstack process is holding the write lock the statement first
   * waits up to `busy_timeout` ms, then throws SQLITE_BUSY.  This wrapper catches
   * that error and retries (up to MAX_LOCK_RETRIES) with exponential backoff,
   * giving the competing writer time to finish and release the lock.
   *
   * @param fn  The write operation to execute. Can return a value which is
   *            returned to the caller on success.
   * @throws   {@link LockError} when all retries are exhausted on a lock conflict
   *            (non-lock errors always propagate on the first attempt).
   */
  runWithRetry<T>(fn: () => T): T {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_LOCK_RETRIES; attempt++) {
      try {
        return fn();
      } catch (err) {
        lastError = err;
        if (!isLockError(err)) throw err;
        if (attempt === MAX_LOCK_RETRIES) {
          // All retries exhausted — wrap in LockError so the circuit breaker
          // knows this is a transient lock conflict, not a real failure.
          const msg = lastError instanceof Error ? lastError.message : String(lastError);
          throw new LockError(`SQLite lock conflict after ${MAX_LOCK_RETRIES} retries: ${msg}`);
        }
        // Exponential backoff: 50ms → 100ms → 200ms, capped at 500ms.
        const delay = Math.min(
          LOCK_RETRY_BASE_DELAY_MS * 2 ** attempt,
          LOCK_RETRY_MAX_DELAY_MS,
        );
        sleepSync(delay);
      }
    }
    throw lastError; // unreachable — satisfies TypeScript
  }

  constructor(projectRoot: string, opts: { indexDir?: string | undefined } = {}) {
    this.indexDir = resolveIndexDir(projectRoot, opts.indexDir);
    fs.mkdirSync(this.indexDir, { recursive: true });
    const Database = loadDatabaseSync();
    this.db = new Database(path.join(this.indexDir, DB_FILE));
    // Multi-process safety: several wstack surfaces (TUI, WebUI, parallel
    // terminals) share this per-project db. WAL lets readers coexist with the
    // writer, and busy_timeout gives SQLite a head start waiting for the lock.
    // When the timeout expires the statement throws SQLITE_BUSY; the
    // runWithRetry() wrapper then retries with exponential backoff so most
    // lock-conflict errors are resolved without a circuit-breaker failure.
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA busy_timeout = 5000');
    } catch {
      /* pragmas are best-effort — an old SQLite build without WAL still works */
    }
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Schema migration: the index is derived, rebuildable data — on any
    // version mismatch we drop everything and let the next index run repopulate
    // from source, instead of maintaining per-version migration scripts.
    const storedRows = this.db.prepare('SELECT value FROM metadata WHERE key = ?').all('version') as { value: string }[];
    const storedVersion = storedRows.length ? Number(storedRows[0]?.value) : null;
    if (storedVersion !== null && storedVersion !== SCHEMA_VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS symbols;
        DROP TABLE IF EXISTS files;
        DROP TABLE IF EXISTS refs;
      `);
      this.db.exec('DROP TABLE IF EXISTS symbols_fts');
      this.db.prepare('UPDATE metadata SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'version');
    } else if (storedVersion === null) {
      this.db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('version', String(SCHEMA_VERSION));
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        file TEXT PRIMARY KEY,
        lang TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        symbol_count INTEGER NOT NULL DEFAULT 0,
        last_indexed INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY,
        lang TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        col INTEGER NOT NULL,
        signature TEXT NOT NULL DEFAULT '',
        doc_comment TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        file_fk TEXT NOT NULL
      );
    `);

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_s_name ON symbols(name)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_s_kind ON symbols(kind)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_s_lang ON symbols(lang)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_s_file ON symbols(file)');
    // Compound index for the common lang+kind filter in ranked search.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_s_lang_kind ON symbols(lang, kind)');
    // Index on file_fk: deleteSymbolsForFile and FTS delete paths query by
    // file_fk — without this index every reindex/delete scans the symbols table.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_s_file_fk ON symbols(file_fk)');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS refs (
        id INTEGER PRIMARY KEY,
        from_id INTEGER NOT NULL,
        to_name TEXT NOT NULL,
        to_id INTEGER,
        call_type TEXT NOT NULL,
        line INTEGER NOT NULL
      );
    `);

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_r_from ON refs(from_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_r_to_id ON refs(to_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_r_to_name ON refs(to_name)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_r_call_type ON refs(call_type)');

    // FTS5 full-text index over the camelCase-split symbol text; rowid is the
    // symbol id. Replaces the old `LIKE '%token%'` full-table scan + per-query
    // in-process BM25 build: MATCH uses the inverted index and bm25() ranks
    // natively. Kept in sync explicitly in insertSymbols/delete*/clearAll.
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(text, tokenize = 'unicode61')");
      this.ftsAvailable = true;
    } catch {
      // SQLite built without FTS5 — searchRanked falls back to LIKE + BM25.
      this.ftsAvailable = false;
    }
  }

  // ─── Symbol CRUD ─────────────────────────────────────────────────────────────

  /**
   * Insert symbols, assigning IDs atomically inside `BEGIN IMMEDIATE` /
   * `COMMIT`. The ID allocation (`SELECT MAX(id)`) and all `INSERT`s share
   * the same transaction, preventing UNIQUE constraint violations when two
   * processes index concurrently (each would see a different `MAX(id)` and
   * neither can insert with the other's IDs).
   *
   * @returns The symbols array with `id` fields populated so the caller can
   *          use them for refs without re-reading from the DB.
   */
  insertSymbols(symbols: IndexSymbol[]): IndexSymbol[] {
    return this.runWithRetry(() => {
      // BEGIN IMMEDIATE takes a write lock immediately (does not wait for the
      // first INSERT). This serializes writers: the next process blocks here
      // until this transaction commits, so its `SELECT MAX(id)` sees all IDs
      // we assign — no collisions.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const maxRows = this.db.prepare('SELECT MAX(id) AS m FROM symbols').all() as { m: number | null }[];
        let nextId = (maxRows[0]?.m ?? 0) + 1;

        const stmt = this.db.prepare(
          `INSERT INTO symbols(id, lang, kind, name, file, line, col, signature, doc_comment, scope, text, file_fk)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const ftsStmt = this.ftsAvailable
          ? this.db.prepare('INSERT INTO symbols_fts(rowid, text) VALUES (?, ?)')
          : null;

        const result: IndexSymbol[] = [];
        for (const s of symbols) {
          const id = nextId++;
          stmt.run(
            id,
            s.lang,
            s.kind,
            s.name,
            s.file,
            s.line,
            s.col,
            s.signature,
            s.docComment,
            s.scope,
            s.text,
            s.file,
          );
          ftsStmt?.run(id, buildIndexableText(s.name, s.signature, s.docComment));
          result.push({ ...s, id });
        }

        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  deleteSymbolsForFile(file: string): void {
    this.runWithRetry(() => {
      if (this.ftsAvailable) {
        this.db
          .prepare('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_fk = ?)')
          .run(file);
      }
      this.db.prepare('DELETE FROM symbols WHERE file_fk = ?').run(file);
    });
  }

  /**
   * Remove every trace of a file (refs, symbols, FTS rows, file meta). Used
   * when a source file disappears between index runs — previously this only
   * dropped the `files` row, leaving its symbols orphaned but still searchable.
   */
  deleteFile(file: string): void {
    this.runWithRetry(() => {
      this.deleteRefsForFile(file);
      this.deleteSymbolsForFile(file);
      this.db.prepare('DELETE FROM files WHERE file = ?').run(file);
    });
  }

  // ─── File metadata ──────────────────────────────────────────────────────────

  upsertFile(meta: FileMeta): void {
    this.runWithRetry(() => {
      this.db.prepare(
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
    const rows = this.db.prepare(
      'SELECT file, lang, mtime_ms, symbol_count, last_indexed FROM files WHERE file = ?',
    ).all(file) as { file: string; lang: string; mtime_ms: number; symbol_count: number; last_indexed: number }[];
    if (!rows.length) return null;
    const r = expectDefined(rows[0]);
    return { file: r.file, lang: r.lang as SymbolLang, mtimeMs: r.mtime_ms, symbolCount: r.symbol_count, lastIndexed: r.last_indexed };
  }

  getAllFileMetas(): FileMeta[] {
    return (this.db.prepare(
      'SELECT file, lang, mtime_ms, symbol_count, last_indexed FROM files',
    ).all() as { file: string; lang: string; mtime_ms: number; symbol_count: number; last_indexed: number }[]).map(
      (r) => ({ file: r.file, lang: r.lang as SymbolLang, mtimeMs: r.mtime_ms, symbolCount: r.symbol_count, lastIndexed: r.last_indexed }),
    );
  }

  // ─── Search ──────────────────────────────────────────────────────────────────

  search(
    query: string,
    filter?: { kind?: SymbolKind | undefined; lang?: SymbolLang | undefined; file?: string | undefined; lspKind?: number | undefined },
  ): SearchResult[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    let effectiveKind: SymbolKind | undefined = filter?.kind;
    if (filter?.lspKind !== undefined) {
      const mapped = lspKindToInternalKind(filter.lspKind);
      if (mapped !== null) {
        effectiveKind = mapped;
      } else {
        // LSP kind was explicitly provided but has no internal mapping → no results
        return [];
      }
    }

    if (effectiveKind) {
      conditions.push('kind = ?');
      values.push(effectiveKind);
    }
    if (filter?.lang) {
      conditions.push('lang = ?');
      values.push(filter.lang);
    }
    if (filter?.file) {
      conditions.push('file LIKE ?');
      values.push(`%${filter.file}%`);
    }
    if (query.trim()) {
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const tokenConds = tokens.map(() => 'text LIKE ?');
      conditions.push(`(${tokenConds.join(' OR ')})`);
      for (const t of tokens) values.push(`%${t}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT id, lang, kind, name, file, line, col, signature, doc_comment, text FROM symbols ${where}`;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...values as (string | number)[]) as {
      id: number; lang: string; kind: string; name: string; file: string;
      line: number; col: number; signature: string; doc_comment: string; text: string;
    }[];

    return rows.map((r) => ({
      id: r.id,
      lang: r.lang as SymbolLang,
      kind: r.kind as SymbolKind,
      name: r.name,
      file: r.file,
      line: r.line,
      col: r.col,
      signature: r.signature,
      docComment: r.doc_comment,
      score: 0,
      snippet: '',
      lspKind: filter?.lspKind,
    }));
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
    filter:
      | { kind?: SymbolKind | undefined; lang?: SymbolLang | undefined; file?: string | undefined; lspKind?: number | undefined }
      | undefined,
    limit: number,
  ): { results: SearchResult[]; total: number } {
    const tokens = tokenise(query);
    // No usable tokens → plain filtered listing (matches old `search('')`).
    if (tokens.length === 0 || !this.ftsAvailable) {
      return this.searchRankedFallback(query, filter, limit);
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
      conditions.push('s.file LIKE ?');
      values.push(`%${filter.file}%`);
    }
    const where = conditions.join(' AND ');

    const countRows = this.db
      .prepare(`SELECT COUNT(*) AS n FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid WHERE ${where}`)
      .all(...values) as { n: number }[];
    const total = countRows[0] ? Number(countRows[0].n) : 0;
    if (total === 0) return { results: [], total: 0 };

    const rows = this.db
      .prepare(
        `SELECT s.id, s.lang, s.kind, s.name, s.file, s.line, s.col, s.signature, s.doc_comment,
                -bm25(symbols_fts) AS score,
                snippet(symbols_fts, 0, '', '', '…', 12) AS snippet
         FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
         WHERE ${where}
         ORDER BY bm25(symbols_fts)
         LIMIT ?`,
      )
      .all(...values, limit) as {
      id: number; lang: string; kind: string; name: string; file: string;
      line: number; col: number; signature: string; doc_comment: string;
      score: number; snippet: string;
    }[];

    return {
      results: rows.map((r) => ({
        id: r.id,
        lang: r.lang as SymbolLang,
        kind: r.kind as SymbolKind,
        name: r.name,
        file: r.file,
        line: r.line,
        col: r.col,
        signature: r.signature,
        docComment: r.doc_comment,
        // bm25() is negative-is-better; negate so callers keep "higher is
        // better" and clamp so a match never reports a zero score.
        score: Math.max(0.0001, r.score),
        snippet: r.snippet,
        lspKind: filter?.lspKind,
      })),
      total,
    };
  }

  /** Legacy ranked path: LIKE candidates + in-process BM25 + JS snippets. */
  private searchRankedFallback(
    query: string,
    filter:
      | { kind?: SymbolKind | undefined; lang?: SymbolLang | undefined; file?: string | undefined; lspKind?: number | undefined }
      | undefined,
    limit: number,
  ): { results: SearchResult[]; total: number } {
    const candidates = this.search(query, filter);
    if (candidates.length === 0) return { results: [], total: 0 };

    if (!query.trim()) {
      return { results: candidates.slice(0, limit), total: candidates.length };
    }

    const candidateById = new Map(candidates.map((c) => [c.id, c]));
    const bm25 = buildBm25Index(
      candidates.map((c) => ({ id: c.id, text: buildIndexableText(c.name, c.signature, c.docComment) })),
    );
    const scored = bm25.score(query, (id) => candidateById.has(id));
    scored.sort((a, b) => b.score - a.score);
    const qTokens = tokenise(query);

    const results = scored.slice(0, limit).map(({ id, score }) => {
      const c = expectDefined(candidateById.get(id));
      return { ...c, score, snippet: bm25.extractSnippet(id, qTokens) };
    });
    return { results, total: candidates.length };
  }

  getAllIndexable(): Array<{ id: number; text: string }> {
    return (this.db.prepare('SELECT id, text FROM symbols').all() as { id: number; text: string }[]).map(
      ({ id, text }) => ({ id, text }),
    );
  }

  /**
   * Largest symbol id currently in the table (0 when empty). New ids must be
   * allocated from this, NOT from `COUNT(*)`: incremental reindexes delete a
   * changed file's rows, so the row count drops below the max id and a
   * count-based id would collide with a surviving row (UNIQUE constraint on
   * `symbols.id`). Ids may have gaps — that is fine.
   */
  getMaxSymbolId(): number {
    const rows = this.db.prepare('SELECT MAX(id) AS m FROM symbols').all() as { m: number | null }[];
    return rows[0]?.m ?? 0;
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  getStats(): IndexStats {
    const sizeBytes = this.sizeBytes();

    const lastRows = this.db.prepare(
      "SELECT value FROM metadata WHERE key = 'last_indexed'",
    ).all() as { value: string }[];
    const lastIndexed = lastRows.length ? Number(lastRows[0]?.value) : null;

    const totalRows = this.db.prepare('SELECT COUNT(*) FROM symbols').all() as { 'COUNT(*)': number }[];
    const totalSymbols = totalRows[0] ? Number(totalRows[0]['COUNT(*)']) : 0;

    const fileRows = this.db.prepare('SELECT COUNT(*) FROM files').all() as { 'COUNT(*)': number }[];
    const totalFiles = fileRows[0] ? Number(fileRows[0]['COUNT(*)']) : 0;

    const langRows = this.db.prepare(
      'SELECT lang, COUNT(*) FROM symbols GROUP BY lang',
    ).all() as { lang: string; 'COUNT(*)': number }[];
    const byLang = {} as Record<SymbolLang, number>;
    for (const row of langRows) byLang[row.lang as SymbolLang] = Number(row['COUNT(*)']);

    const kindRows = this.db.prepare(
      'SELECT kind, COUNT(*) FROM symbols GROUP BY kind',
    ).all() as { kind: string; 'COUNT(*)': number }[];
    const byKind = {} as Record<SymbolKind, number>;
    for (const row of kindRows) byKind[row.kind as SymbolKind] = Number(row['COUNT(*)']);

    return {
      totalSymbols,
      totalFiles,
      byLang,
      byKind,
      indexPath: this.indexDir,
      lastIndexed,
      sizeBytes,
      version: SCHEMA_VERSION,
    };
  }

  setLastIndexed(ts: number): void {
    this.runWithRetry(() => {
      this.db.prepare(
        "INSERT OR REPLACE INTO metadata(key, value) VALUES('last_indexed', ?)",
      ).run(String(ts));
    });
  }

  clearAll(): void {
    this.runWithRetry(() => {
      this.db.exec('DELETE FROM symbols');
      this.db.exec('DELETE FROM files');
      this.db.exec('DELETE FROM refs');
      if (this.ftsAvailable) this.db.exec('DELETE FROM symbols_fts');
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
      this.db.prepare('DELETE FROM refs WHERE from_id = ?').run(fromId);
      if (refs.length === 0) return;

      const stmt = this.db.prepare(
        `INSERT INTO refs(from_id, to_name, to_id, call_type, line)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const ref of refs) {
        stmt.run(fromId, ref.toName, ref.toId ?? null, ref.callType, ref.line);
      }
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
      const stmt = this.db.prepare(
        `INSERT INTO refs(from_id, to_name, to_id, call_type, line)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const ref of refs) {
        stmt.run(ref.fromId, ref.toName, ref.toId ?? null, ref.callType, ref.line);
      }
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
    return this.runWithRetry(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // 1) Clear stale refs+symbols for any files being re-indexed.
        if (options.deleteForFiles && options.deleteForFiles.length > 0) {
          const placeholders = options.deleteForFiles.map(() => '?').join(',');
          if (this.ftsAvailable) {
            this.db
              .prepare(
                `DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file IN (${placeholders}))`,
              )
              .run(...options.deleteForFiles);
          }
          // Refs first (FK direction: refs.from_id → symbols.id).
          this.db
            .prepare(
              `DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file IN (${placeholders}))`,
            )
            .run(...options.deleteForFiles);
          this.db
            .prepare(`DELETE FROM symbols WHERE file IN (${placeholders})`)
            .run(...options.deleteForFiles);
        }

        // 2) Assign ids + insert symbols.
        const maxRows = this.db.prepare('SELECT MAX(id) AS m FROM symbols').all() as { m: number | null }[];
        let nextId = (maxRows[0]?.m ?? 0) + 1;

        const symStmt = this.db.prepare(
          `INSERT INTO symbols(id, lang, kind, name, file, line, col, signature, doc_comment, scope, text, file_fk)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const ftsStmt = this.ftsAvailable
          ? this.db.prepare('INSERT INTO symbols_fts(rowid, text) VALUES (?, ?)')
          : null;

        const allInserted: IndexSymbol[] = [];
        const refsToInsert: Ref[] = [];

        for (const entry of entries) {
          for (const s of entry.symbols) {
            const id = nextId++;
            symStmt.run(
              id,
              s.lang,
              s.kind,
              s.name,
              s.file,
              s.line,
              s.col,
              s.signature,
              s.docComment,
              s.scope,
              s.text,
              s.file,
            );
            ftsStmt?.run(id, buildIndexableText(s.name, s.signature, s.docComment));
            allInserted.push({ ...s, id });
          }
          // Carry refs forward — caller has already populated `fromId`.
          for (const r of entry.refs) refsToInsert.push(r);
        }

        // 3) Insert all refs in one go.
        if (refsToInsert.length > 0) {
          const refStmt = this.db.prepare(
            `INSERT INTO refs(from_id, to_name, to_id, call_type, line)
             VALUES (?, ?, ?, ?, ?)`,
          );
          for (const ref of refsToInsert) {
            refStmt.run(ref.fromId, ref.toName, ref.toId ?? null, ref.callType, ref.line);
          }
        }

        // 4) Upsert file metadata for every entry.
        const upsertStmt = this.db.prepare(
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
      this.db.prepare(
        'DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file = ?)',
      ).run(file);
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
      const result = this.db.prepare(
        `UPDATE refs SET to_id = (
           SELECT id FROM symbols WHERE name = refs.to_name LIMIT 1
         ) WHERE to_id IS NULL AND to_name IS NOT NULL
           AND to_name IN (SELECT name FROM symbols)`,
      ).run() as { changes?: number };
      return result.changes ?? 0;
    });
  }

  /**
   * Find all references TO a given symbol (who calls / uses this symbol?).
   */
  findRefsTo(symbolId: number): Ref[] {
    return (this.db.prepare(
      'SELECT id, from_id, to_name, to_id, call_type, line FROM refs WHERE to_id = ? OR to_name = (SELECT name FROM symbols WHERE id = ?)',
    ).all(symbolId, symbolId) as { id: number; from_id: number; to_name: string; to_id: number | null; call_type: string; line: number }[]).map((r) => ({
      id: r.id, fromId: r.from_id, toName: r.to_name, toId: r.to_id ?? undefined, callType: r.call_type as Ref['callType'], line: r.line,
    }));
  }

  /**
   * Find all references FROM a given symbol (what does this symbol call/use?).
   */
  findRefsFrom(symbolId: number): Ref[] {
    return (this.db.prepare(
      'SELECT id, from_id, to_name, to_id, call_type, line FROM refs WHERE from_id = ?',
    ).all(symbolId) as { id: number; from_id: number; to_name: string; to_id: number | null; call_type: string; line: number }[]).map((r) => ({
      id: r.id, fromId: r.from_id, toName: r.to_name, toId: r.to_id ?? undefined, callType: r.call_type as Ref['callType'], line: r.line,
    }));
  }

  private sizeBytes(): number {
    const dbPath = path.join(this.indexDir, DB_FILE);
    try {
      return fs.statSync(dbPath).size;
    } catch {
      return 0;
    }
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}
