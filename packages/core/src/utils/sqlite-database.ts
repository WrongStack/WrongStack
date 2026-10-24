import type { DatabaseSync } from 'node:sqlite';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import { withSqliteExperimentalWarningSuppressed } from './sqlite-warning.js';

let DatabaseSyncCtor: typeof DatabaseSync | undefined;

/**
 * The runtime's `DatabaseSync` constructor (node:sqlite or bun:sqlite), loaded
 * once with the experimental-API warning suppressed. Shared by the mailbox and
 * session-catalog stores.
 */
export function loadDatabaseSync(): typeof DatabaseSync {
  if (DatabaseSyncCtor) return DatabaseSyncCtor;
  return withSqliteExperimentalWarningSuppressed(() => {
    DatabaseSyncCtor = loadRuntimeDatabaseSync();
    return DatabaseSyncCtor;
  });
}
