import type { DatabaseSync } from 'node:sqlite';

export interface IndexTransactionHost {
  atomicIndexUpdateActive: boolean;
  runWithRetry<T>(fn: () => T): T;
  readonly db: DatabaseSync;
  invalidateBm25(): void;
  writeSavepointSequence: number;
  beginWriteTransaction(): string | null;
  commitWriteTransaction(savepoint: string | null): void;
  rollbackWriteTransaction(savepoint: string | null): void;
}

export async function runAtomicUpdate<T>(
  host: IndexTransactionHost,
  job: () => Promise<T>,
): Promise<T> {
  if (host.atomicIndexUpdateActive) return job();
  host.runWithRetry(() => host.db.exec('BEGIN IMMEDIATE'));
  host.atomicIndexUpdateActive = true;
  try {
    const result = await job();
    host.db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      host.db.exec('ROLLBACK');
    } catch {
      /* preserve the indexing failure */
    }
    // A BM25 corpus built mid-job read rows the rollback just discarded.
    host.invalidateBm25();
    throw error;
  } finally {
    host.atomicIndexUpdateActive = false;
  }
}

export function beginIndexWrite(host: IndexTransactionHost): string | null {
  if (host.atomicIndexUpdateActive) {
    const savepoint = `index_write_${++host.writeSavepointSequence}`;
    host.db.exec(`SAVEPOINT ${savepoint}`);
    return savepoint;
  }
  host.db.exec('BEGIN IMMEDIATE');
  return null;
}

export function commitIndexWrite(host: IndexTransactionHost, savepoint: string | null): void {
  if (savepoint) host.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
  else host.db.exec('COMMIT');
}

export function rollbackIndexWrite(host: IndexTransactionHost, savepoint: string | null): void {
  host.invalidateBm25();
  try {
    if (savepoint) {
      host.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      host.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } else {
      host.db.exec('ROLLBACK');
    }
  } catch {
    /* preserve the original failure */
  }
}

export function runIndexWrite<T>(host: IndexTransactionHost, operation: () => T): T {
  return host.runWithRetry(() => {
    const ownsTransaction = host.beginWriteTransaction();
    try {
      const result = operation();
      host.commitWriteTransaction(ownsTransaction);
      return result;
    } catch (error) {
      host.rollbackWriteTransaction(ownsTransaction);
      throw error;
    }
  });
}
