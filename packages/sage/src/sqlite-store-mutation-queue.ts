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
    // Serialize on the previous chain head. Swallow prior rejection so a
    // failed mutation never permanently bricks the queue — the next caller
    // still gets a clean shot at the lock.
    const run = this.mutationChain
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
    // Keep only a void settlement on the serial chain. Without this, every
    // settled mutation result (full Sage rows from remember/update, large
    // hygiene reports, etc.) stays reachable from `mutationChain` until the
    // next enqueue — a process-lifetime retain for long-lived project servers.
    this.mutationChain = settleVoid(run);
    return run as Promise<T>;
  }

  runCounter<T>(db: DatabaseSync, work: () => T extends Promise<unknown> ? never : T): Promise<T> {
    const run = this.counterChain
      .catch(() => undefined)
      .then(() => runImmediateTransaction(db, work));
    this.counterChain = settleVoid(run);
    return run as Promise<T>;
  }

  async drain(): Promise<void> {
    await Promise.all(
      [this.mutationChain, this.counterChain].map((p) => p.catch(() => undefined)),
    );
  }
}

/** Drop fulfilled/rejected payloads so the serial chain only holds ordering. */
function settleVoid(run: Promise<unknown>): Promise<void> {
  return run.then(
    () => undefined,
    () => undefined,
  );
}
