import { CircuitOpenError, indexCircuitBreaker } from './circuit-breaker.js';
import { isIndexablePath } from './languages.js';

// ─── Watchdog timeouts ───────────────────────────────────────────────────────

/**
 * Watchdog timeout for a full (startup / manual) index run.
 *
 * Bumped from 120s → 240s in 0.284.x: large monorepos (WrongStack itself
 * has ~3k TS files) regularly exceed 120s on the first run on cold SSD +
 * Windows Defender real-time scanning. The watchdog only fires when the
 * worker is truly stuck — it does not slow down the happy path.
 */
export const DEFAULT_FULL_INDEX_TIMEOUT_MS = 240_000;

/** Watchdog timeout for one incremental reindex batch. */
export const DEFAULT_INCREMENTAL_TIMEOUT_MS = 60_000;

/**
 * Watchdog timeout for read operations (search / stats).
 *
 * Reads normally finish quickly, but a cold or contended SQLite index can take
 * longer than the former 8s budget, especially on large Windows workspaces.
 * Keep this below the outer tool timeout so callers receive the structured
 * IndexTimeoutError when the worker is genuinely wedged.
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

/**
 * The error read tools gate on, from this process's own runs and the shared
 * project server's activity.
 *
 * `remote?.lastError ?? local` let a stale local failure outlive the server's
 * later successful generation (`null ?? local` is `local`), so search,
 * incoming/outgoing calls and impact analysis kept refusing with "Index build
 * failed" against a healthy index. The newer report wins; a tie trusts the
 * server, which owns the index.
 */
export function resolveLastError(
  remote: { lastError: string | null; updatedAt: number | null } | null | undefined,
  local: string | null,
  localAt: number,
): string | null {
  if (!remote) return local;
  if (local !== null && localAt > (remote.updatedAt ?? 0)) return local;
  return remote.lastError;
}

/** Build the fail-fast error thrown while the circuit is open. */
export function circuitOpenError(): CircuitOpenError {
  const c = indexCircuitBreaker.snapshot();
  return new CircuitOpenError(
    'Codebase indexing is temporarily paused after repeated failures' +
      (c.lastFailure ? ` (last: ${c.lastFailure})` : '') +
      (c.cooldownRemainingMs > 0
        ? `; auto-retry in ${Math.ceil(c.cooldownRemainingMs / 1000)}s`
        : '') +
      '. Use /codebase-reindex to retry now.',
  );
}

// ─── Debounce ────────────────────────────────────────────────────────────────
export const DEFAULT_DEBOUNCE_MS = 400;

/**
 * Per-project trailing coalescing window. After a file's debounce timer fires
 * and enters a ready batch, the batch stays open for this long before flushing.
 * Any file whose debounce timer fires within the window joins the same batch
 * and resets the timer (sliding window). This turns staggered bursts — a
 * formatter-on-save touching several files over ~10-50ms — into one index run
 * instead of N.
 *
 * Set to 0 to restore the old setImmediate behavior (files only coalesce when
 * their debounce timers fire in the exact same event-loop turn).
 */
export const DEFAULT_COALESCE_WINDOW_MS = 50;

export type ReindexCompletion = { resolve: () => void; reject: (err: unknown) => void };

export function debounceKey(
  projectRoot: string,
  indexDir: string | undefined,
  file: string,
): string {
  return JSON.stringify([projectRoot, indexDir ?? '', file]);
}

export function reindexBatchKey(projectRoot: string, indexDir: string | undefined): string {
  return JSON.stringify([projectRoot, indexDir ?? '']);
}

export function settleReindexCompletions(
  completions: Set<{ resolve: () => void; reject: (err: unknown) => void }>,
  _error?: unknown,
): void {
  for (const completion of completions) {
    // Incremental reindexing is background work. Errors are delivered through
    // onError, but the completion promise must settle successfully so callers
    // that intentionally ignore the fire-and-forget return value cannot create
    // an unhandled rejection.
    completion.resolve();
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** True when the file's extension maps to a language the indexer can parse. */
export function isIndexableFile(filePath: string): boolean {
  return isIndexablePath(filePath);
}

/**
 * Run a full-project scan and await it. Used at session start and by the manual
 * `/codebase-reindex` command. Incremental by default (unchanged files skipped
 * via mtime, so repeat runs are cheap); pass `force` to clear and rebuild.
 *
 * Sets the global `_ready` flag on completion so downstream tools know the
 * index is usable.
 */
/** Pattern matching SQLite constraint failures caused by a stale/corrupt index DB. */
export function isRecoverableConstraintError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('unique constraint') || msg.includes('constraint failed');
  }
  return false;
}
