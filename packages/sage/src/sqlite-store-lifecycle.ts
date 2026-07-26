import type { DatabaseSync } from 'node:sqlite';
import type { SqliteMutationQueue } from './sqlite-store-mutation-queue.js';
import type { SqliteStatementCache } from './sqlite-store-statement-cache.js';

export async function drainSqliteStoreMutations(queue: SqliteMutationQueue): Promise<void> {
  await queue.drain();
}

/**
 * Synchronously close the database handle and release prepared statements.
 * Callers that need production teardown should drain first, then close.
 */
export function closeSqliteStore(
  stmtCache: SqliteStatementCache,
  db: DatabaseSync | undefined,
): void {
  stmtCache.clear();
  if (!db) return;
  try {
    db.close();
  } catch {
    // Already closed — idempotent.
  }
}
