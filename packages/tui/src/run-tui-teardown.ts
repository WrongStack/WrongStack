/**
 * Durable teardown primitives for the TUI host.
 *
 * Extracted from run-tui.ts so the kill-safety semantics are unit-testable
 * without an Ink render loop.
 *
 * Why both a sync and an async step exist:
 *   - `flushSync()` drains the writer's in-memory buffer with blocking
 *     writes. That data survives ANY concurrent hard exit (the host's
 *     500ms exit-grace timer, a second Ctrl+C, a supervisor SIGKILL racing
 *     us) because by the time it returns, the bytes are already handed to
 *     the OS.
 *   - `close()` additionally drains the async write chain, `datasync()`s
 *     the handle, and writes the `.summary.json` sidecar + `_index.jsonl`
 *     row. That work is async, cannot be forced synchronous, and therefore
 *     gets a bounded budget instead of being trusted to outlive the loop.
 *
 * Ordering contract of `shutdownViaSignal`:
 *   1. killChildren   — stop tool subprocesses from producing new events.
 *   2. salvageSync    — buffered events are durably on disk from here on.
 *   3. cleanup        — terminal restore; also kicks off close() (idempotent).
 *   4. await close    — bounded by closeBudgetMs; never hangs shutdown.
 *   5. salvageSync    — catch anything close() re-buffered while failing.
 *   6. exit           — caller-supplied exit function.
 */

/** Structural subset of SessionWriter the teardown needs. */
export interface TeardownSession {
  /** Durable drain: buffer → disk → datasync → sidecar/index. Idempotent. */
  close(): Promise<void>;
  /** Last-gasp synchronous drain of whatever is still in memory. */
  flushSync?(): void;
}

export interface DurableTeardownOptions {
  /** Reads the CURRENT writer so swaps (e.g. /resume) stay covered. */
  getSession: () => TeardownSession | undefined;
  /** Foreground child cleanup (process registry killAll). Best-effort. */
  killChildren?: (() => void) | undefined;
  /** Terminal restore + client unregister. Idempotent. */
  cleanup: () => void;
  /** Hard ceiling for awaiting close(). Default 1500ms. */
  closeBudgetMs?: number;
  /** Exit function — injectable so tests don't need process.exit. */
  exit: (code: number) => void;
}

export interface DurableTeardown {
  /**
   * Signal-driven shutdown (SIGTERM/SIGHUP/Ctrl+C): full ordered sequence,
   * ends by calling exit(). Safe to fire concurrently from several handlers
   * — every step is idempotent and exit wins once.
   */
  shutdownViaSignal(exitCode: number): Promise<void>;
  /**
   * Awaited close WITHOUT exiting — used by the natural exit path (settle)
   * so the host continues only after durability, and project-switch respawns
   * keep working.
   */
  awaitDurableClose(): Promise<void>;
  /** Sync-only last-chance drain for 'exit' listeners / process.exit contexts. */
  salvageSync(): void;
}

const DEFAULT_CLOSE_BUDGET_MS = 1_500;

export function createDurableTeardown(opts: DurableTeardownOptions): DurableTeardown {
  const closeBudgetMs = opts.closeBudgetMs ?? DEFAULT_CLOSE_BUDGET_MS;

  const salvageSync = (): void => {
    try {
      opts.getSession()?.flushSync?.();
    } catch {
      // best-effort — dying anyway
    }
  };

  const awaitCloseBounded = async (): Promise<void> => {
    await Promise.race([
      (async () => {
        try {
          await opts.getSession()?.close();
        } catch {
          // A failed durable drain must not block the exit path; the final
          // salvageSync below still drains whatever stayed buffered.
        }
      })(),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, closeBudgetMs);
        // Unref'd: if everything else drains first, Node may exit naturally
        // before the budget elapses — that is fine, salvageSync already ran.
        t.unref();
      }),
    ]);
  };

  const awaitDurableClose = async (): Promise<void> => {
    // Salvage before kicking off the async chain: from this point on the
    // buffer contents survive any concurrent hard exit.
    salvageSync();
    try {
      opts.cleanup();
    } catch {
      // Terminal may already be detached mid-shutdown — ignore.
    }
    await awaitCloseBounded();
    // Anything re-buffered while close() failed gets one last sync chance.
    salvageSync();
  };

  const shutdownViaSignal = async (exitCode: number): Promise<void> => {
    try {
      opts.killChildren?.();
    } catch {
      // best-effort — exiting either way
    }
    await awaitDurableClose();
    opts.exit(exitCode);
  };

  return { shutdownViaSignal, awaitDurableClose, salvageSync };
}
