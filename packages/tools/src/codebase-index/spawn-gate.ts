/**
 * Global concurrency gate for external parser processes (Python / Go / cargo).
 *
 * Spawning many AST helpers in parallel burns CPU and thrash the OS process
 * table on Windows. Serializing native toolchains is correctness-preserving:
 * each file still gets the same parse result, just not all at once.
 */

import { recordParserGateWait } from './perf-metrics.js';

let chain: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` exclusively with respect to other {@link withSpawnGate} callers
 * in this process. Errors propagate to the caller and do not break the queue.
 */
export function withSpawnGate<T>(fn: () => Promise<T>): Promise<T> {
  const queuedAt = performance.now();
  const run = chain.then(
    () => {
      recordParserGateWait(performance.now() - queuedAt);
      return fn();
    },
    () => {
      recordParserGateWait(performance.now() - queuedAt);
      return fn();
    },
  );
  // Keep the chain alive even when `fn` rejects.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Test helper — reset queue between cases. */
export function resetSpawnGateForTests(): void {
  chain = Promise.resolve();
}
