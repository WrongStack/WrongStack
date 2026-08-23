import type { DatabaseSync } from 'node:sqlite';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';

/** Sentinel marking in-flight probe. Prevents re-entrant require(). */
export const DATABASE_SYNC_LOADING: unique symbol = Symbol('database_sync_loading');

let DatabaseSyncCtor: typeof DatabaseSync | undefined | null | typeof DATABASE_SYNC_LOADING;
// null = confirmed unavailable, undefined = not yet probed, DATABASE_SYNC_LOADING = probing in progress

export function probeSqliteAvailable(load?: () => typeof DatabaseSync): boolean {
  if (DatabaseSyncCtor === null) return false;
  // DATABASE_SYNC_LOADING is !== undefined, so it must be checked explicitly
  // before the broad `!== undefined` branch.
  if (DatabaseSyncCtor === DATABASE_SYNC_LOADING) return false;
  if (DatabaseSyncCtor !== undefined) return true;
  try {
    loadDatabaseSync(load);
    return true;
  } catch {
    DatabaseSyncCtor = null;
    return false;
  }
}

export function loadDatabaseSync(
  load: () => typeof DatabaseSync = loadRuntimeDatabaseSync,
): typeof DatabaseSync {
  if (DatabaseSyncCtor === DATABASE_SYNC_LOADING) {
    throw new Error('Re-entrant call to loadDatabaseSync — cycle detected.');
  }
  if (typeof DatabaseSyncCtor === 'function') return DatabaseSyncCtor;
  // Mark as loading before any side effects so a recursive call (should one
  // occur through a warning emission or module-graph cycle) is detected early.
  DatabaseSyncCtor = DATABASE_SYNC_LOADING;
  try {
    DatabaseSyncCtor = withSqliteExperimentalWarningSuppressed(load);
    return DatabaseSyncCtor;
  } catch (err) {
    DatabaseSyncCtor = null;
    throw new Error(
      'SAGE SQLite store needs node:sqlite (Node >= 22.5) or bun:sqlite. ' +
        `This runtime doesn't provide it: ${(err as Error).message}`,
    );
  }
}

/**
 * Suppress `node:sqlite` "ExperimentalWarning" emissions for the duration of
 * `run()`. The listener and its reentrancy flag are scoped to a single call.
 */
export function withSqliteExperimentalWarningSuppressed<T>(run: () => T): T {
  let reentering = false;
  const onWarning = (warning: Error, ...args: unknown[]) => {
    if (reentering) return;
    const msg = typeof warning === 'string' ? warning : (warning?.message ?? '');
    if (/sqlite/i.test(msg) && /experimental/i.test(msg)) return;
    reentering = true;
    process.off('warning', onWarning);
    process.emitWarning(
      warning,
      args[0] as string | undefined,
      args[1] as string | undefined,
      args[2] as (...args: unknown[]) => unknown | undefined,
    );
    process.on('warning', onWarning);
    reentering = false;
  };
  process.on('warning', onWarning);
  try {
    return run();
  } finally {
    // Always detach and reset state, regardless of success or failure.
    process.off('warning', onWarning);
    reentering = false;
  }
}

export function getDatabaseSyncCtor():
  | typeof DatabaseSync
  | undefined
  | null
  | typeof DATABASE_SYNC_LOADING {
  return DatabaseSyncCtor;
}

export function setDatabaseSyncCtor(
  value: typeof DatabaseSync | undefined | null | typeof DATABASE_SYNC_LOADING,
): void {
  DatabaseSyncCtor = value;
}
