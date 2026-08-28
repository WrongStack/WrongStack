/**
 * Graceful shutdown for the CLI host process.
 *
 * Bug history: cli-main.ts used to call `process.exit(0)` immediately in its
 * SIGINT/SIGTERM handlers, after kicking off async cleanup with `void
 * cleanup()`. The async work (most importantly `registry.markClosing()`, an
 * awaited atomic disk write) was being cut off — leaving the cross-process
 * session registry thinking the host was still alive after Ctrl+C.
 *
 * This helper is the same pattern `webui-server/lifecycle.ts` uses
 * (`createWebuiShutdown`) and `cli-entry-point.ts` uses for its natural-exit
 * drain: idempotent guard, await the work, set `exitCode`, give the event
 * loop a bounded grace period, then force exit. A repeated signal that
 * somehow re-fires our handler (e.g. someone re-installs it, or the
 * `beforeExit` and a `SIGINT` race) short-circuits to immediate exit instead
 * of waiting for the cleanup to settle a second time.
 *
 * The cleanup function is responsible for whatever the caller needs to flush
 * — registry writes, unsubscribe, dispose, etc. The wrapper only handles the
 * process-exit handshake around it.
 */

interface ShutdownCleanup {
  /**
   * Async cleanup. Called exactly once across all signals. May throw — errors
   * are swallowed so a stuck cleanup can't wedge the exit path.
   */
  run: () => Promise<void>;
  /** Exit code to use on a clean shutdown (default 0). */
  exitCode?: number;
}

interface ShutdownHandle {
  /** Install SIGINT + SIGTERM + beforeExit listeners. Idempotent. */
  install: () => void;
  /** Uninstall listeners (for tests). */
  uninstall: () => void;
  /** True iff cleanup has been kicked off (by any signal). */
  get cleanupStarted(): boolean;
}

/**
 * Build a graceful-shutdown handle. Pass the cleanup function; the wrapper
 * installs signal handlers that call it once and let the event loop drain.
 */
export function createGracefulShutdown(cleanup: ShutdownCleanup): ShutdownHandle {
  const exitCode = cleanup.exitCode ?? 0;
  let started = false;
  let installed = false;

  const runOnce = (force: boolean): void => {
    if (started) {
      if (force) process.exit(exitCode);
      return;
    }
    started = true;
    void cleanup
      .run()
      .catch(() => {
        /* swallow — a stuck cleanup cannot wedge the exit path */
      })
      .finally(() => {
        if (force) {
          // SIGINT/SIGTERM path: set exitCode and let Node drain naturally,
          // then force exit after a 500ms grace. Matches cli-entry-point.ts.
          process.exitCode = exitCode;
          const t = setTimeout(() => process.exit(exitCode), 500);
          // Allow the timer to be cleared by Node's normal exit drain if the
          // loop empties before it fires. unref prevents it from holding the
          // loop open by itself.
          t.unref();
        }
        // beforeExit path: do nothing further — Node is already draining.
      });
  };

  const signalHandler = (): void => runOnce(true);
  const beforeExitHandler = (): void => runOnce(false);

  return {
    install() {
      if (installed) return;
      installed = true;
      process.once('SIGINT', signalHandler);
      process.once('SIGTERM', signalHandler);
      process.once('beforeExit', beforeExitHandler);
    },
    uninstall() {
      if (!installed) return;
      installed = false;
      process.removeListener('SIGINT', signalHandler);
      process.removeListener('SIGTERM', signalHandler);
      process.removeListener('beforeExit', beforeExitHandler);
    },
    get cleanupStarted() {
      return started;
    },
  };
}
