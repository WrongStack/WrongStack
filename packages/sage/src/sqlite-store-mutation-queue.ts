import type { DatabaseSync } from 'node:sqlite';
import { withFileLock } from '@wrongstack/core/utils';

function runImmediateTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No open transaction (e.g. BEGIN itself failed).
    }
    throw err;
  }
}

export class SqliteMutationQueue {
  private mutationChain: Promise<unknown> = Promise.resolve();
  private counterChain: Promise<unknown> = Promise.resolve();

  runLocked<T>(opts: { db: DatabaseSync; lockPath: string; work: () => T }): Promise<T> {
    const next = this.mutationChain
      .catch(() => undefined)
      .then(() =>
        withFileLock(
          opts.lockPath,
          async () => runImmediateTransaction(opts.db, opts.work),
          {
            timeoutMs: 60_000,
            staleMs: 30 * 60_000,
          },
        ),
      );
    this.mutationChain = next;
    return next as Promise<T>;
  }

  runCounter<T>(db: DatabaseSync, work: () => T extends Promise<unknown> ? never : T): Promise<T> {
    const next = this.counterChain
      .catch(() => undefined)
      .then(() => runImmediateTransaction(db, work));
    this.counterChain = next;
    return next as Promise<T>;
  }

  async drain(): Promise<void> {
    await Promise.all(
      [this.mutationChain, this.counterChain].map((p) => p.catch(() => undefined)),
    );
  }
}
