/**
 * Main indexing orchestrator.
 *
 * Given a project root and a list of files:
 * 1. Parse each file with the appropriate parser (TS, Go, Python, Rust, JSON, YAML)
 * 2. Delete old symbols for changed/deleted files
 * 3. Insert new symbols
 * 4. Update file metadata
 * 5. Return index statistics
 */

// Phase 5 parser worker pool infrastructure lives in parser-worker-pool.ts and
// parser-worker-script.ts. The indexer integration (post-batch pool delegation)
// is deferred — see the comment at the parse call site below for why pool
// delegation cannot happen inside the Promise.allSettled callback.

/** Yield the event loop every N files so the main thread stays responsive. */
export const YIELD_EVERY_N = 50;

export function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Cooperatively abort if the signal is set. Throws with the signal's reason
 * (or a descriptive Error) so callers know *why* the operation was cancelled.
 * Called at yield points — never after a Promise resolve (that would be a
 * microtask that the signal check could miss).
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === 'string' ? signal.reason : 'Indexing cancelled');
}
