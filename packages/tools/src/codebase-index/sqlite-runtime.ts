import type { DatabaseSync } from 'node:sqlite';
import { toErrorMessage } from '@wrongstack/core/utils';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import { LockError } from './circuit-breaker.js';

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
 * Load the active runtime's synchronous SQLite implementation lazily. Keeping this off writer.ts top
 * level lets codebase-index tools register at CLI boot without eagerly loading
 * SQLite. Runtimes without `node:sqlite` or `bun:sqlite` fail only when the index is used.
 */
export function loadDatabaseSync(): typeof DatabaseSync {
  if (DatabaseSyncCtor) return DatabaseSyncCtor;
  silenceSqliteExperimentalWarning();
  try {
    DatabaseSyncCtor = loadRuntimeDatabaseSync();
  } catch (err) {
    throw new Error(
      'The codebase index needs node:sqlite (Node >= 22.5) or bun:sqlite. ' +
        `This runtime doesn't provide it: ${toErrorMessage(err)}`,
    );
  }
  return DatabaseSyncCtor;
}

/** Maximum retry attempts for a lock-conflict error. */
const MAX_LOCK_RETRIES = 3;
/** Base delay (ms) before the first retry after a lock error. */
const LOCK_RETRY_BASE_DELAY_MS = 50;
/** Cap on the per-retry delay so we never sleep for more than this. */
const LOCK_RETRY_MAX_DELAY_MS = 500;

function isLockError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as { code?: unknown; sqliteCode?: unknown };
  const code = e.code ?? e.sqliteCode;
  if (typeof code === 'string' && /SQLITE_(BUSY|LOCKED)/.test(code)) return true;
  if (typeof code === 'number' && (code === 5 || code === 6)) return true;
  return /SQLITE_(BUSY|LOCKED)/.test(err.message);
}

let SLEEP_BUFFER: Int32Array | undefined;

function sleepSync(ms: number): void {
  try {
    if (!SLEEP_BUFFER) {
      SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
    }
    Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
  } catch {
    // busy_timeout already handled the bulk wait; retry immediately if
    // Atomics.wait is unavailable in this runtime.
  }
}

export function runSqliteWithRetry<T>(fn: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_LOCK_RETRIES; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
      if (!isLockError(err)) throw err;
      if (attempt === MAX_LOCK_RETRIES) {
        const msg = lastError instanceof Error ? lastError.message : String(lastError);
        throw new LockError(`SQLite lock conflict after ${MAX_LOCK_RETRIES} retries: ${msg}`);
      }
      const delay = Math.min(LOCK_RETRY_BASE_DELAY_MS * 2 ** attempt, LOCK_RETRY_MAX_DELAY_MS);
      sleepSync(delay);
    }
  }
  throw lastError;
}
