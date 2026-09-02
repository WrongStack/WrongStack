import type { DatabaseSync } from 'node:sqlite';
import { withFileLock } from '@wrongstack/core/utils';

function runImmediateTransaction<T>(
  db: DatabaseSync,
  work: () => T,
  signal?: AbortSignal | undefined,
): T {
  // Pre-transaction abort check: if the caller already cancelled, skip
  // the transaction entirely instead of acquiring the write lock and
  // committing a stale result that the caller has stopped listening for.
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    // `work` must be synchronous. If it returns a thenable, the COMMIT below
    // would land before the work finished — committing an empty or partial
    // transaction and reporting success. `runCounter` forbids this at the type
    // level; `runMutation`'s `() => T` does not, so enforce it here where the
    // damage would otherwise be silent.
    if (typeof (result as { then?: unknown } | undefined)?.then === 'function') {
      throw new TypeError(
        'runImmediateTransaction: work() returned a thenable — transaction work must be synchronous',
      );
    }
    // Pre-commit abort check: the work between BEGIN and COMMIT may have
    // taken significant time (hygiene over hundreds of memories, JSONL
    // migration of thousands of rows). If the caller cancelled during that
    // window, roll back instead of committing a result the caller has stopped
    // listening for. This has to sit *after* work() to mean anything — placed
    // before it, no event-loop turn separates it from the pre-BEGIN check
    // above, so it could never observe a different value.
    if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
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

  runLocked<T>(opts: {
    db: DatabaseSync;
    lockPath: string;
    work: () => T;
    signal?: AbortSignal | undefined;
  }): Promise<T> {
    // Serialize on the previous chain head. Swallow prior rejection so a
    // failed mutation never permanently bricks the queue — the next caller
    // still gets a clean shot at the lock.
    const run = this.mutationChain
      .catch(() => undefined)
      .then(() =>
        withFileLock(
          opts.lockPath,
          async () => runImmediateTransaction(opts.db, opts.work, opts.signal),
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
    await Promise.all([this.mutationChain, this.counterChain].map((p) => p.catch(() => undefined)));
  }
}

/** Drop fulfilled/rejected payloads so the serial chain only holds ordering. */
function settleVoid(run: Promise<unknown>): Promise<void> {
  return run.then(
    () => undefined,
    () => undefined,
  );
}
