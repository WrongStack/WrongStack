import { expectDefined } from '@wrongstack/core/utils';
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
import { resolveWstackPaths, sqliteCachePragmas } from '@wrongstack/core/utils';
import type {
  FileMeta,
  IndexStats,
  Ref,
  SearchResult,
  Symbol as IndexSymbol,
  SymbolKind,
  SymbolLang,
  CodeMapGraph,
  GraphNode,
  GraphEdge,
  CallType,
} from './schema.js';
import { SCHEMA_VERSION } from './schema.js';
import { lspKindToInternalKind } from './lsp-kind.js';
import { type Bm25Index, buildBm25Index, buildIndexableText, tokenise } from './bm25.js';
const DB_FILE = 'index.db';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function assignRefsToSymbols(refs: Ref[], symbols: IndexSymbol[]): Ref[] {
  if (refs.length === 0 || symbols.length === 0) return [];
  const ordered = [...symbols].sort((a, b) => a.line - b.line || a.col - b.col || a.id - b.id);
  const seen = new Set<string>();
  const assigned: Ref[] = [];
  for (const ref of refs) {
    let owner: IndexSymbol | undefined;
    for (const symbol of ordered) {
      if (symbol.line > ref.line) break;
      owner = symbol;
    }
    if (!owner && ref.callType === 'import') owner = ordered[0];
    if (!owner || owner.id <= 0) continue;
    const key = `${owner.id}:${ref.toName}:${ref.callType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assigned.push({ ...ref, fromId: owner.id });
  }
  return assigned;
}

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
export function codebaseIndexDirOverride(ctx: {
  meta?: Record<string, unknown>;
}): string | undefined {
  const v = ctx.meta?.['codebaseIndexDir'];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Warm-connection pool for IndexStore instances.
 *
 * Each (projectRoot, indexDir) pair gets one persisted IndexStore. Every read
 * operation (search, stats, graph) acquires the store from the pool instead of
 * opening a fresh SQLite connection, re-parsing the schema, and re-preparing
 * statements. The connection stays warm between calls — only warm-up cost is
 * paid once per project per process lifetime.
 *
 * In WAL mode, readers coexist with the writer connection, so a single pooled
 * connection handles both reads and writes safely. The caller is responsible
 * for serializing writes (the host's promise-chain mutex does this); the pool
 * itself has no lock because the worker processes one message at a time.
 */
export class StorePool {
  private readonly stores = new Map<string, IndexStore>();

  private key(projectRoot: string, indexDir?: string): string {
    return `${projectRoot}\u0000${indexDir ?? ''}`;
  }

  /** Borrow a store. Creates it on first access for this key. */
  acquire(projectRoot: string, opts?: { indexDir?: string | undefined }): IndexStore {
    const k = this.key(projectRoot, opts?.indexDir);
    let store = this.stores.get(k);
    if (!store) {
      store = new IndexStore(projectRoot, { indexDir: opts?.indexDir });
      this.stores.set(k, store);
    }
    return store;
  }

  /** Return the store to the pool. The connection stays warm for subsequent
   * operations on the same (projectRoot, indexDir). */
  release(_store: IndexStore): void {
    // No-op — the store remains open with its prepared-statement cache intact,
    // ready for the next acquire() on the same key. The connection is closed
    // explicitly via closeAll() (shutdown) or evict() (test isolation).
  }

  /** Close every pooled connection and drain the pool. Call on shutdown. */
  closeAll(): void {
    for (const store of this.stores.values()) {
      try {
        store.close();
      } catch {
        /* already closed */
      }
    }
    this.stores.clear();
  }

  /** Remove one store from the pool. Used by tests that need isolation. */
  evict(projectRoot: string, indexDir?: string): void {
    const k = this.key(projectRoot, indexDir);
    const store = this.stores.get(k);
    if (store) {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      this.stores.delete(k);
    }
  }

  /** True when the pool holds a connection for the given key. */
  has(projectRoot: string, indexDir?: string): boolean {
    return this.stores.has(this.key(projectRoot, indexDir));
  }
}

/** Process-wide singleton pool. */
export const indexStorePool = new StorePool();

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
    const name =
      typeof warning === 'string' ? String(rest[0] ?? '') : ((warning as Error)?.name ?? '');
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
        const delay = Math.min(LOCK_RETRY_BASE_DELAY_MS * 2 ** attempt, LOCK_RETRY_MAX_DELAY_MS);
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
      this.db.exec('PRAGMA synchronous = NORMAL');
      // Large reindex batches hold the write lock longer; give concurrent
      // readers/writers more headroom before SQLITE_BUSY → retry.
      this.db.exec('PRAGMA busy_timeout = 15000');
      this.db.exec('PRAGMA temp_store = MEMORY');
      // Cache/mmap follow WRONGSTACK_PERF_PROFILE (frugal = leaner RSS).
      const cache = sqliteCachePragmas();
      this.db.exec(`PRAGMA cache_size = -${cache.cacheSizeKiB}`);
      this.db.exec(`PRAGMA mmap_size = ${cache.mmapBytes}`);
      this.db.exec('PRAGMA foreign_keys = ON');
      // Cap WAL growth so long-lived index processes don't leave multi-GB -wal files.
      this.db.exec('PRAGMA journal_size_limit = 67108864'); // 64 MiB
      this.db.exec('PRAGMA wal_autocheckpoint = 1000');
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
    const storedRows = this.stmt('SELECT value FROM metadata WHERE key = ?')
      .all('version') as { value: string }[];
    const storedVersion = storedRows.length ? Number(storedRows[0]?.value) : null;
    if (storedVersion !== null && storedVersion !== SCHEMA_VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS symbols;
        DROP TABLE IF EXISTS files;
        DROP TABLE IF EXISTS refs;
      `);
      this.db.exec('DROP TABLE IF EXISTS symbols_fts');
      this.stmt('UPDATE metadata SET value = ? WHERE key = ?')
        .run(String(SCHEMA_VERSION), 'version');
    } else if (storedVersion === null) {
      this.stmt('INSERT INTO metadata(key, value) VALUES (?, ?)')
        .run('version', String(SCHEMA_VERSION));
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
    // resolveRefs joins refs.to_name → symbols.name; covering (name, id) avoids
    // a second lookup for the id column on each unresolved ref.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_s_name_id ON symbols(name, id)');

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
      this.db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(text, tokenize = 'unicode61')",
      );
      this.ftsAvailable = true;
      // A database may have been populated by a runtime without FTS5. Backfill
      // the derived table when FTS later becomes available instead of making
      // every historical symbol invisible until a forced rebuild.
      const symbolCount = Number(
        (this.stmt('SELECT COUNT(*) AS n FROM symbols').get() as { n?: number } | undefined)
          ?.n ?? 0,
      );
      const ftsCount = Number(
        (
          this.stmt('SELECT COUNT(*) AS n FROM symbols_fts').get() as
            | { n?: number }
            | undefined
        )?.n ?? 0,
      );
      if (symbolCount !== ftsCount) {
        this.db.exec('DELETE FROM symbols_fts');
        const rows = this.stmt('SELECT id, name, signature, doc_comment FROM symbols ORDER BY id')
          .all() as Array<{ id: number; name: string; signature: string; doc_comment: string }>;
        this.bulkInsertFts(
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

  /** Multi-row INSERT for symbols — amortizes prepare/bind overhead in large batches. */
  private bulkInsertSymbols(
    rows: Array<{
      id: number;
      lang: string;
      kind: string;
      name: string;
      file: string;
      line: number;
      col: number;
      signature: string;
      docComment: string;
      scope: string;
      text: string;
    }>,
  ): void {
    if (rows.length === 0) return;
    const cols = 12;
    const chunkSize = Math.max(1, Math.floor(IndexStore.MAX_SQL_VARS / cols));
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const stmt = this.stmt(
        `INSERT INTO symbols(id, lang, kind, name, file, line, col, signature, doc_comment, scope, text, file_fk)
         VALUES ${placeholders}`,
      );
      const binds: (string | number)[] = [];
      for (const r of chunk) {
        binds.push(
          r.id,
          r.lang,
          r.kind,
          r.name,
          r.file,
          r.line,
          r.col,
          r.signature,
          r.docComment,
          r.scope,
          r.text,
          r.file,
        );
      }
      stmt.run(...binds);
    }
  }

  private bulkInsertFts(rows: Array<{ id: number; text: string }>): void {
    if (!this.ftsAvailable || rows.length === 0) return;
    const cols = 2;
    const chunkSize = Math.max(1, Math.floor(IndexStore.MAX_SQL_VARS / cols));
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '(?, ?)').join(', ');
      const stmt = this.stmt(`INSERT INTO symbols_fts(rowid, text) VALUES ${placeholders}`);
      const binds: (string | number)[] = [];
      for (const r of chunk) binds.push(r.id, r.text);
      stmt.run(...binds);
    }
  }

  private bulkInsertRefs(refs: Ref[]): void {
    if (refs.length === 0) return;
    const cols = 5;
    const chunkSize = Math.max(1, Math.floor(IndexStore.MAX_SQL_VARS / cols));
    for (let i = 0; i < refs.length; i += chunkSize) {
      const chunk = refs.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const stmt = this.stmt(
        `INSERT INTO refs(from_id, to_name, to_id, call_type, line) VALUES ${placeholders}`,
      );
      const binds: (string | number | null)[] = [];
      for (const ref of chunk) {
        binds.push(ref.fromId, ref.toName, ref.toId ?? null, ref.callType, ref.line);
      }
      stmt.run(...binds);
    }
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
        const bulk: Array<{
          id: number;
          lang: string;
          kind: string;
          name: string;
          file: string;
          line: number;
          col: number;
          signature: string;
          docComment: string;
          scope: string;
          text: string;
        }> = [];
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
        this.bulkInsertSymbols(bulk);
        this.bulkInsertFts(ftsRows);

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
      if (this.ftsAvailable) {
        this.stmt(
          'DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_fk = ?)',
        ).run(file);
      }
      this.stmt('DELETE FROM symbols WHERE file_fk = ?').run(file);
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
    const rows = this.stmt(
      'SELECT file, lang, mtime_ms, symbol_count, last_indexed FROM files WHERE file = ?',
    ).all(file) as {
      file: string;
      lang: string;
      mtime_ms: number;
      symbol_count: number;
      last_indexed: number;
    }[];
    if (!rows.length) return null;
    const r = expectDefined(rows[0]);
    return {
      file: r.file,
      lang: r.lang as SymbolLang,
      mtimeMs: r.mtime_ms,
      symbolCount: r.symbol_count,
      lastIndexed: r.last_indexed,
    };
  }

  getAllFileMetas(): FileMeta[] {
    return (
      this.stmt('SELECT file, lang, mtime_ms, symbol_count, last_indexed FROM files')
        .all() as {
        file: string;
        lang: string;
        mtime_ms: number;
        symbol_count: number;
        last_indexed: number;
      }[]
    ).map((r) => ({
      file: r.file,
      lang: r.lang as SymbolLang,
      mtimeMs: r.mtime_ms,
      symbolCount: r.symbol_count,
      lastIndexed: r.last_indexed,
    }));
  }

  // ─── Search ──────────────────────────────────────────────────────────────────

  search(
    query: string,
    filter?: {
      kind?: SymbolKind | undefined;
      lang?: SymbolLang | undefined;
      file?: string | undefined;
      lspKind?: number | undefined;
    },
    opts?: { limit?: number | undefined },
  ): SearchResult[] {
    const built = this.buildSearchWhere(query, filter);
    if (built === null) return [];

    const { where, values } = built;
    const limit =
      typeof opts?.limit === 'number' && Number.isFinite(opts.limit)
        ? Math.max(0, Math.trunc(opts.limit))
        : undefined;
    const limitSql = limit !== undefined ? ' LIMIT ?' : '';
    const sql = `SELECT id, lang, kind, name, file, line, col, signature, doc_comment, text FROM symbols ${where}${limitSql}`;

    const binds = limit !== undefined ? [...values, limit] : values;
    const rows = this.stmt(sql).all(...(binds as (string | number)[])) as {
      id: number;
      lang: string;
      kind: string;
      name: string;
      file: string;
      line: number;
      col: number;
      signature: string;
      doc_comment: string;
      text: string;
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

  /** Shared WHERE builder for {@link search} / empty-query ranked totals. */
  private buildSearchWhere(
    query: string,
    filter?: {
      kind?: SymbolKind | undefined;
      lang?: SymbolLang | undefined;
      file?: string | undefined;
      lspKind?: number | undefined;
    },
  ): { where: string; values: unknown[] } | null {
    const conditions: string[] = [];
    const values: unknown[] = [];

    let effectiveKind: SymbolKind | undefined = filter?.kind;
    if (filter?.lspKind !== undefined) {
      const mapped = lspKindToInternalKind(filter.lspKind);
      if (mapped !== null) {
        effectiveKind = mapped;
      } else {
        // LSP kind was explicitly provided but has no internal mapping → no results
        return null;
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
      conditions.push("replace(file, '\\', '/') LIKE ? ESCAPE '\\'");
      values.push(`%${escapeLike(filter.file.replace(/\\/g, '/'))}%`);
    }
    if (query.trim()) {
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const tokenConds = tokens.map(() => 'text LIKE ?');
      conditions.push(`(${tokenConds.join(' OR ')})`);
      for (const t of tokens) values.push(`%${t}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return { where, values };
  }

  private countSearch(
    query: string,
    filter?: {
      kind?: SymbolKind | undefined;
      lang?: SymbolLang | undefined;
      file?: string | undefined;
      lspKind?: number | undefined;
    },
  ): number {
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
    filter:
      | {
          kind?: SymbolKind | undefined;
          lang?: SymbolLang | undefined;
          file?: string | undefined;
          lspKind?: number | undefined;
        }
      | undefined,
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
      )
      .all(...values) as { n: number }[];
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
      )
      .all(...values, query.trim(), `${escapeLike(query.trim())}%`, safeLimit) as {
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
    filter:
      | {
          kind?: SymbolKind | undefined;
          lang?: SymbolLang | undefined;
          file?: string | undefined;
          lspKind?: number | undefined;
        }
      | undefined,
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
    return (
      this.stmt('SELECT id, text FROM symbols').all() as { id: number; text: string }[]
    ).map(({ id, text }) => ({ id, text }));
  }

  /**
   * Largest symbol id currently in the table (0 when empty). New ids must be
   * allocated from this, NOT from `COUNT(*)`: incremental reindexes delete a
   * changed file's rows, so the row count drops below the max id and a
   * count-based id would collide with a surviving row (UNIQUE constraint on
   * `symbols.id`). Ids may have gaps — that is fine.
   */
  getMaxSymbolId(): number {
    const rows = this.stmt('SELECT MAX(id) AS m FROM symbols').all() as {
      m: number | null;
    }[];
    return rows[0]?.m ?? 0;
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  getStats(): IndexStats {
    const sizeBytes = this.sizeBytes();

    const lastRows = this.stmt("SELECT value FROM metadata WHERE key = 'last_indexed'")
      .all() as { value: string }[];
    const lastIndexed = lastRows.length ? Number(lastRows[0]?.value) : null;

    const totalRows = this.stmt('SELECT COUNT(*) FROM symbols').all() as {
      'COUNT(*)': number;
    }[];
    const totalSymbols = totalRows[0] ? Number(totalRows[0]['COUNT(*)']) : 0;

    const fileRows = this.stmt('SELECT COUNT(*) FROM files').all() as {
      'COUNT(*)': number;
    }[];
    const totalFiles = fileRows[0] ? Number(fileRows[0]['COUNT(*)']) : 0;

    const langRows = this.stmt('SELECT lang, COUNT(*) FROM symbols GROUP BY lang').all() as {
      lang: string;
      'COUNT(*)': number;
    }[];
    const byLang = {} as Record<SymbolLang, number>;
    for (const row of langRows) byLang[row.lang as SymbolLang] = Number(row['COUNT(*)']);

    const kindRows = this.stmt('SELECT kind, COUNT(*) FROM symbols GROUP BY kind').all() as {
      kind: string;
      'COUNT(*)': number;
    }[];
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
      this.stmt("INSERT OR REPLACE INTO metadata(key, value) VALUES('last_indexed', ?)")
        .run(String(ts));
    });
  }

  getMetadata(key: string): string | undefined {
    const rows = this.stmt('SELECT value FROM metadata WHERE key = ?').all(key) as {
      value: string;
    }[];
    return rows[0]?.value;
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
      this.bulkInsertRefs(refs.map((ref) => ({ ...ref, fromId })));
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
      this.bulkInsertRefs(refs);
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
        // 1) Clear stale refs+symbols for any files being re-indexed.
        if (options.deleteForFiles && options.deleteForFiles.length > 0) {
          const placeholders = options.deleteForFiles.map(() => '?').join(',');
          if (this.ftsAvailable) {
            this.stmt(
                `DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file IN (${placeholders}))`,
              )
              .run(...options.deleteForFiles);
          }
          // Refs first (FK direction: refs.from_id → symbols.id).
          this.stmt(
              `DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file IN (${placeholders}))`,
            )
            .run(...options.deleteForFiles);
          this.stmt(`DELETE FROM symbols WHERE file IN (${placeholders})`)
            .run(...options.deleteForFiles);
        }

        // 2) Assign ids + multi-row insert symbols (+ FTS).
        const totalSymbols = entries.reduce((n, e) => n + e.symbols.length, 0);
        let nextId = this.allocateSymbolIds(totalSymbols);

        const allInserted: IndexSymbol[] = [];
        const refsToInsert: Ref[] = [];
        const bulkSyms: Array<{
          id: number;
          lang: string;
          kind: string;
          name: string;
          file: string;
          line: number;
          col: number;
          signature: string;
          docComment: string;
          scope: string;
          text: string;
        }> = [];
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

        this.bulkInsertSymbols(bulkSyms);
        this.bulkInsertFts(ftsRows);

        // 3) Multi-row insert all refs.
        this.bulkInsertRefs(refsToInsert);

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
      this.stmt('DELETE FROM refs WHERE from_id IN (SELECT id FROM symbols WHERE file = ?)')
        .run(file);
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

  /**
   * Clear symbols/refs for a file and mark it as indexed with zero symbols.
   * Used by the indexer for empty-parse results so three writes share one txn.
   */
  replaceEmptyFile(meta: FileMeta): void {
    this.invalidateBm25();
    this.runWithRetry(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
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
   * Find all references TO a given symbol (who calls / uses this symbol?).
   */
  findRefsTo(symbolId: number): Ref[] {
    return (
      this.stmt(
          'SELECT id, from_id, to_name, to_id, call_type, line FROM refs WHERE to_id = ? OR to_name = (SELECT name FROM symbols WHERE id = ?)',
        )
        .all(symbolId, symbolId) as {
        id: number;
        from_id: number;
        to_name: string;
        to_id: number | null;
        call_type: string;
        line: number;
      }[]
    ).map((r) => ({
      id: r.id,
      fromId: r.from_id,
      toName: r.to_name,
      toId: r.to_id ?? undefined,
      callType: r.call_type as Ref['callType'],
      line: r.line,
    }));
  }

  /**
   * Find all references FROM a given symbol (what does this symbol call/use?).
   */
  findRefsFrom(symbolId: number): Ref[] {
    return (
      this.stmt('SELECT id, from_id, to_name, to_id, call_type, line FROM refs WHERE from_id = ?')
        .all(symbolId) as {
        id: number;
        from_id: number;
        to_name: string;
        to_id: number | null;
        call_type: string;
        line: number;
      }[]
    ).map((r) => ({
      id: r.id,
      fromId: r.from_id,
      toName: r.to_name,
      toId: r.to_id ?? undefined,
      callType: r.call_type as Ref['callType'],
      line: r.line,
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

  // ─── CodeMap graph aggregation ──────────────────────────────────────────────

  /**
   * Derive a monorepo package name from an absolute file path.
   * Handles both `packages/<name>/...` (workspace) and `src/<name>/...` layouts.
   * Returns `undefined` for files outside any recognisable package structure.
   */
  private static derivePackage(filePath: string): string | undefined {
    // Normalise backslashes (Windows) to forward slashes.
    const f = filePath.replace(/\\/g, '/');
    const pkgsIdx = f.indexOf('/packages/');
    if (pkgsIdx !== -1) {
      const rest = f.slice(pkgsIdx + '/packages/'.length);
      const seg = rest.split('/')[0];
      return seg ? `@wrongstack/${seg}` : undefined;
    }
    const appsIdx = f.indexOf('/apps/');
    if (appsIdx !== -1) {
      const rest = f.slice(appsIdx + '/apps/'.length);
      const seg = rest.split('/')[0];
      return seg ? `app:${seg}` : undefined;
    }
    return undefined;
  }

  private static packageFromImport(moduleName: string): string | undefined {
    if (!moduleName.startsWith('@wrongstack/')) return undefined;
    const parts = moduleName.split('/');
    return parts[1] ? `@wrongstack/${parts[1]}` : undefined;
  }

  private static resolveRelativeImport(
    fromFile: string,
    moduleName: string,
    indexedFiles: Set<string>,
  ): string | undefined {
    if (!moduleName.startsWith('.')) return undefined;
    const normalizedFrom = fromFile.replace(/\\/g, '/');
    const absolute = path.posix.normalize(
      path.posix.join(path.posix.dirname(normalizedFrom), moduleName),
    );
    const extension = path.posix.extname(absolute);
    const base = extension ? absolute.slice(0, -extension.length) : absolute;
    const candidates = [
      absolute,
      ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].map((ext) => `${base}${ext}`),
      ...['.ts', '.tsx', '.js', '.jsx'].map((ext) => path.posix.join(absolute, `index${ext}`)),
      ...['.ts', '.tsx', '.js', '.jsx'].map((ext) => path.posix.join(base, `index${ext}`)),
    ];
    const indexedByPortablePath = new Map(
      [...indexedFiles].map((file) => [file.replace(/\\/g, '/').toLocaleLowerCase(), file]),
    );
    for (const candidate of candidates) {
      const indexed = indexedByPortablePath.get(candidate.toLocaleLowerCase());
      if (indexed) return indexed;
    }
    return undefined;
  }

  /**
   * Package-level graph: each workspace package is a node; edges are derived
   * from cross-package symbol references (a symbol in package A references a
   * symbol resolved in package B). Node metadata includes symbol/file counts.
   */
  getPackageGraph(): CodeMapGraph {
    // Aggregate symbol counts per file in SQL — avoids shipping every symbol id
    // into JS just to count them (5k–50k rows on large monorepos).
    const fileCounts = this.stmt(
      'SELECT file, COUNT(*) AS n FROM symbols GROUP BY file',
    ).all() as Array<{ file: string; n: number }>;

    const pkgNodes = new Map<string, GraphNode>();
    const fileToPkg = new Map<string, string>();

    for (const { file, n } of fileCounts) {
      const pkg = IndexStore.derivePackage(file) ?? '(root)';
      fileToPkg.set(file, pkg);
      const node = pkgNodes.get(pkg);
      if (node) {
        node.symbolCount = (node.symbolCount ?? 0) + n;
      } else {
        pkgNodes.set(pkg, {
          id: `pkg:${pkg}`,
          label: pkg,
          kind: 'package' as const,
          package: pkg,
          symbolCount: n,
          fileCount: 0,
        });
      }
    }

    // File counts per package
    const files = this.stmt('SELECT DISTINCT file FROM files').all() as { file: string }[];
    for (const { file } of files) {
      const pkg = IndexStore.derivePackage(file) ?? '(root)';
      fileToPkg.set(file, pkg);
      const node = pkgNodes.get(pkg);
      if (node) node.fileCount = (node.fileCount ?? 0) + 1;
      else {
        pkgNodes.set(pkg, {
          id: `pkg:${pkg}`,
          label: pkg,
          kind: 'package' as const,
          package: pkg,
          symbolCount: 0,
          fileCount: 1,
        });
      }
    }

    // Cross-package edges: aggregate in SQL first (file×file×type) so monorepos
    // with tens of thousands of symbol refs ship far fewer rows into JS.
    const refRows = this.stmt(
      `SELECT r.call_type, sf.file AS from_file, st.file AS to_file, COUNT(*) AS n
       FROM refs r
       JOIN symbols sf ON sf.id = r.from_id
       JOIN symbols st ON st.id = r.to_id
       WHERE r.to_id IS NOT NULL AND r.call_type != 'import'
       GROUP BY r.call_type, sf.file, st.file`,
    ).all() as Array<{ call_type: string; from_file: string; to_file: string; n: number }>;

    const edgeMap = new Map<string, { weight: number; types: Map<string, number> }>();
    for (const r of refRows) {
      const fromPkg = fileToPkg.get(r.from_file) ?? IndexStore.derivePackage(r.from_file) ?? '(root)';
      const toPkg = fileToPkg.get(r.to_file) ?? IndexStore.derivePackage(r.to_file) ?? '(root)';
      if (fromPkg === toPkg) continue;
      const key = `${fromPkg}\u0000${toPkg}`;
      let e = edgeMap.get(key);
      if (!e) {
        e = { weight: 0, types: new Map() };
        edgeMap.set(key, e);
      }
      const n = Number(r.n) || 0;
      e.weight += n;
      e.types.set(r.call_type, (e.types.get(r.call_type) ?? 0) + n);
    }

    // Module imports are path/package references, not symbol names. They must
    // bypass symbol resolution or aliases/barrels leave the architecture with
    // isolated boxes even though source imports are explicit.
    const importRows = this.stmt(
      `SELECT r.to_name, s.file AS from_file, COUNT(*) AS n
       FROM refs r
       JOIN symbols s ON s.id = r.from_id
       WHERE r.call_type = 'import'
       GROUP BY r.to_name, s.file`,
    ).all() as Array<{ to_name: string; from_file: string; n: number }>;
    for (const r of importRows) {
      const fromPkg = fileToPkg.get(r.from_file) ?? IndexStore.derivePackage(r.from_file) ?? '(root)';
      const toPkg = IndexStore.packageFromImport(r.to_name);
      if (!fromPkg || !toPkg || fromPkg === toPkg || !pkgNodes.has(toPkg)) continue;
      const key = `${fromPkg}\u0000${toPkg}`;
      let edge = edgeMap.get(key);
      if (!edge) {
        edge = { weight: 0, types: new Map() };
        edgeMap.set(key, edge);
      }
      const n = Number(r.n) || 0;
      edge.weight += n;
      edge.types.set('import', (edge.types.get('import') ?? 0) + n);
    }

    const edges: GraphEdge[] = [];
    for (const [key, e] of edgeMap) {
      const [source, target] = key.split('\u0000');
      // Dominant ref type = most frequent
      let bestType = 'call';
      let bestCount = 0;
      for (const [t, c] of e.types) {
        if (c > bestCount) {
          bestType = t;
          bestCount = c;
        }
      }
      edges.push({
        source: `pkg:${source}`,
        target: `pkg:${target}`,
        weight: e.weight,
        refType: bestType as CallType,
      });
    }

    return { nodes: [...pkgNodes.values()], edges };
  }

  /**
   * File-level graph for a single package: each file is a node; edges are
   * derived from cross-file symbol references within the package.
   */
  getFileGraph(packageFilter: string): CodeMapGraph {
    type SymRow = {
      file: string;
      id: number;
      name: string;
      kind: string;
      lang: string;
      line: number;
    };

    // Phase 1: Discover which files belong to the target package. Instead of
    // loading every symbol row (5500+) and filtering in JS, scan just the
    // distinct file paths — a much smaller result set.
    const allFiles = this.stmt('SELECT DISTINCT file FROM symbols')
      .all() as { file: string }[];
    const pkgFilePaths = allFiles
      .filter((f) => (IndexStore.derivePackage(f.file) ?? '(root)') === packageFilter)
      .map((f) => f.file);
    const localFiles = new Set(pkgFilePaths);
    if (localFiles.size === 0) return { nodes: [], edges: [] };

    // Phase 2: Query symbols only for files in this package.
    const filePlaceholders = [...localFiles].map(() => '?').join(',');
    const pkgSyms = this.stmt(
        `SELECT file, id, name, kind, lang, line FROM symbols WHERE file IN (${filePlaceholders}) ORDER BY id`,
      )
      .all(...pkgFilePaths) as SymRow[];

    const fileNodes = new Map<string, GraphNode>();
    const symToFile = new Map<number, string>();
    const fileStats = new Map<string, { count: number; lang: SymbolLang }>();
    for (const s of pkgSyms) {
      symToFile.set(s.id, s.file);
      const current = fileStats.get(s.file);
      fileStats.set(s.file, {
        count: (current?.count ?? 0) + 1,
        lang: (current?.lang ?? s.lang) as SymbolLang,
      });
    }

    const ensureFileNode = (file: string): void => {
      if (fileNodes.has(file)) return;
      const stats = fileStats.get(file);
      fileNodes.set(file, {
        id: `file:${file}`,
        label: file.replace(/\\/g, '/').split('/').pop() ?? file,
        kind: 'file' as const,
        package: IndexStore.derivePackage(file) ?? '(root)',
        file,
        symbolCount: stats?.count ?? 0,
        lang: stats?.lang,
        external: !localFiles.has(file),
      });
    };
    for (const file of localFiles) {
      ensureFileNode(file);
    }

    // Build indexed-files set for import resolution — cheap DISTINCT query
    // on file paths only (no full symbol rows).
    const indexedFiles = new Set(allFiles.map((f) => f.file));

    // Phase 3: Restrict refs to those involving the target package's symbols
    // and aggregate identical edges in SQL before shipping to JS.
    const refRows = this.stmt(
        `SELECT r.from_id, r.to_id, r.call_type, COUNT(*) AS n
       FROM refs r
       WHERE (r.from_id IN (SELECT id FROM symbols WHERE file IN (${filePlaceholders}))
           OR r.to_id IN (SELECT id FROM symbols WHERE file IN (${filePlaceholders})))
         AND r.to_id IS NOT NULL
       GROUP BY r.from_id, r.to_id, r.call_type`,
      )
      .all(...pkgFilePaths, ...pkgFilePaths) as {
      from_id: number;
      to_id: number;
      call_type: string;
      n: number;
    }[];

    // Collect symbol ids referenced across packages for lazy fetch
    const knownSymIds = new Set(pkgSyms.map((s) => s.id));
    const crossRefIds = new Set<number>();
    for (const r of refRows) {
      if (!knownSymIds.has(r.from_id)) crossRefIds.add(r.from_id);
      if (!knownSymIds.has(r.to_id)) crossRefIds.add(r.to_id);
    }
    if (crossRefIds.size > 0) {
      const crossPlaceholders = [...crossRefIds].map(() => '?').join(',');
      const extras = this.stmt(
          `SELECT id, file FROM symbols WHERE id IN (${crossPlaceholders})`,
        )
        .all(...crossRefIds) as { id: number; file: string }[];
      for (const x of extras) {
        symToFile.set(x.id, x.file);
        if (!fileStats.has(x.file)) {
          fileStats.set(x.file, { count: 0, lang: 'ts' as SymbolLang });
        }
      }
    }

    const edgeMap = new Map<string, { weight: number; types: Map<string, number> }>();
    for (const r of refRows) {
      if (r.call_type === 'import') continue;
      const fromFile = symToFile.get(r.from_id);
      const toFile = symToFile.get(r.to_id);
      if (!fromFile || !toFile || fromFile === toFile) continue;
      if (!localFiles.has(fromFile) && !localFiles.has(toFile)) continue;
      ensureFileNode(fromFile);
      ensureFileNode(toFile);
      const key = `${fromFile}\u0000${toFile}`;
      let e = edgeMap.get(key);
      if (!e) {
        e = { weight: 0, types: new Map() };
        edgeMap.set(key, e);
      }
      const n = Number(r.n) || 0;
      e.weight += n;
      e.types.set(r.call_type, (e.types.get(r.call_type) ?? 0) + n);
    }

    const importRows = this.stmt(
        `SELECT r.from_id, r.to_name, COUNT(*) AS n
       FROM refs r
       WHERE r.call_type = 'import'
         AND r.from_id IN (SELECT id FROM symbols WHERE file IN (${filePlaceholders}))
       GROUP BY r.from_id, r.to_name`,
      )
      .all(...pkgFilePaths) as { from_id: number; to_name: string; n: number }[];
    for (const r of importRows) {
      const fromFile = symToFile.get(r.from_id);
      if (!fromFile || !localFiles.has(fromFile)) continue;
      const toFile = IndexStore.resolveRelativeImport(fromFile, r.to_name, indexedFiles);
      if (!toFile || fromFile === toFile) continue;
      ensureFileNode(fromFile);
      ensureFileNode(toFile);
      const key = `${fromFile}\u0000${toFile}`;
      let edge = edgeMap.get(key);
      if (!edge) {
        edge = { weight: 0, types: new Map() };
        edgeMap.set(key, edge);
      }
      const n = Number(r.n) || 0;
      edge.weight += n;
      edge.types.set('import', (edge.types.get('import') ?? 0) + n);
    }

    const edges: GraphEdge[] = [];
    for (const [key, e] of edgeMap) {
      const [source, target] = key.split('\u0000');
      let bestType = 'call';
      let bestCount = 0;
      for (const [t, c] of e.types) {
        if (c > bestCount) {
          bestType = t;
          bestCount = c;
        }
      }
      edges.push({
        source: `file:${source}`,
        target: `file:${target}`,
        weight: e.weight,
        refType: bestType as CallType,
      });
    }

    return { nodes: [...fileNodes.values()], edges };
  }

  /**
   * Symbol-level graph for a single file: each symbol is a node; edges are
   * derived from intra-file and cross-file symbol references (who calls whom).
   */
  getSymbolGraph(fileFilter: string): CodeMapGraph {
    type SymRow = {
      id: number;
      name: string;
      kind: string;
      lang: string;
      file: string;
      line: number;
      signature: string;
      scope: string;
    };
    // Query ONLY symbols from the target file — avoids loading the entire
    // project's symbol table (5500+ rows) just to render one file's graph.
    // Cross-file symbols referenced via refs are fetched lazily below.
    const syms = this.stmt(
        'SELECT id, name, kind, lang, file, line, signature, scope FROM symbols WHERE file = ? ORDER BY line, id',
      )
      .all(fileFilter) as SymRow[];

    if (syms.length === 0) return { nodes: [], edges: [] };

    const symById = new Map(syms.map((symbol) => [symbol.id, symbol]));
    const relatedIds = new Set(syms.map((symbol) => symbol.id));

    const toGraphNode = (s: SymRow): GraphNode => ({
      id: `sym:${s.id}`,
      label: s.name,
      kind: 'symbol' as const,
      symbolId: s.id,
      symbolKind: s.kind as SymbolKind,
      file: s.file,
      package: IndexStore.derivePackage(s.file) ?? '(root)',
      lang: s.lang as SymbolLang,
      line: s.line,
      signature: s.signature,
      scope: s.scope,
      external: s.file !== fileFilter,
    });

    // Collect refs FROM symbols in this file (outgoing) and TO symbols in this
    // file (incoming), so the graph shows both callers and callees.
    //
    // Two index-friendly JOINs are UNIONed (dedup on the physical ref tuple),
    // then aggregated by (from_id, to_id, call_type) so dense call graphs
    // ship far fewer rows into JS. The outer COUNT preserves the same edge
    // weights as walking every raw ref row.
    // Each JOIN drives off `idx_s_file` (symbols.file) and probes `refs` via
    // `idx_r_from` / `idx_r_to_id`. Avoid `from_id IN (…) OR to_id IN (…)` —
    // that form cannot be flattened by the SQLite planner and degenerates to
    // a sequential scan over `refs` for every graph render.
    const refRows = this.stmt(
        `SELECT from_id, to_id, call_type, COUNT(*) AS n
       FROM (
         SELECT r.from_id, r.to_id, r.to_name, r.call_type, r.line
         FROM refs r
         JOIN symbols s ON s.id = r.from_id
         WHERE s.file = ?
         UNION
         SELECT r.from_id, r.to_id, r.to_name, r.call_type, r.line
         FROM refs r
         JOIN symbols s ON s.id = r.to_id
         WHERE s.file = ?
       )
       WHERE to_id IS NOT NULL
       GROUP BY from_id, to_id, call_type`,
      )
      .all(fileFilter, fileFilter) as {
      from_id: number;
      to_id: number;
      call_type: string;
      n: number;
    }[];

    const edgeMap = new Map<string, { weight: number; types: Map<string, number> }>();
    for (const r of refRows) {
      // Aggregated query only returns resolved endpoints; still guard.
      if (r.to_id == null) continue;
      relatedIds.add(r.from_id);
      relatedIds.add(r.to_id);
      const key = `${r.from_id}\u0000${r.to_id}`;
      let e = edgeMap.get(key);
      if (!e) {
        e = { weight: 0, types: new Map() };
        edgeMap.set(key, e);
      }
      const n = Number(r.n) || 0;
      e.weight += n;
      e.types.set(r.call_type, (e.types.get(r.call_type) ?? 0) + n);
    }

    const edges: GraphEdge[] = [];
    for (const [key, e] of edgeMap) {
      const [fromId, toId] = key.split('\u0000').map(Number);
      let bestType = 'call';
      let bestCount = 0;
      for (const [t, c] of e.types) {
        if (c > bestCount) {
          bestType = t;
          bestCount = c;
        }
      }
      edges.push({
        source: `sym:${fromId}`,
        target: `sym:${toId}`,
        weight: e.weight,
        refType: bestType as CallType,
      });
    }

    // Lazily fetch referenced symbols from other files that aren't already
    // loaded (discovered via refs above) instead of loading the entire project
    // symbol table. For a typical file, this saves loading 5000+ irrelevant rows.
    const loadedIds = new Set(syms.map((s) => s.id));
    const missingIds = [...relatedIds].filter((id) => !loadedIds.has(id));
    if (missingIds.length > 0) {
      const placeholders = missingIds.map(() => '?').join(',');
      const extras = this.stmt(
          `SELECT id, name, kind, lang, file, line, signature, scope FROM symbols WHERE id IN (${placeholders})`,
        )
        .all(...missingIds) as SymRow[];
      for (const s of extras) symById.set(s.id, s);
    }

    // Include direct callers/callees from other files. Previously their edges
    // pointed at missing React Flow nodes, which made cross-file relations
    // invisible exactly where users expected to inspect them.
    const nodes = [...relatedIds]
      .map((id) => symById.get(id))
      .filter((symbol): symbol is SymRow => symbol !== undefined)
      .sort((a, b) => {
        const aExternal = a.file === fileFilter ? 0 : 1;
        const bExternal = b.file === fileFilter ? 0 : 1;
        return (
          aExternal - bExternal || a.file.localeCompare(b.file) || a.line - b.line || a.id - b.id
        );
      })
      .map(toGraphNode);

    return { nodes, edges };
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
