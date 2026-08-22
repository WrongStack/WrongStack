/**
 * Detect whether this module was loaded as the CLI's main entry point
 * (vs imported as a library) and, if so, run the supplied `main` function
 * with the current process argv.
 *
 * Why a helper:
 *   1. **isMain detection in one place** — the `import.meta.url` /
 *      `process.argv[1]` comparison has both POSIX (`/`) and Windows (`\`)
 *      path forms; centralising it stops the pattern from drifting.
 *   2. **Bounded exit on both success and failure** — Node will normally
 *      drain async handles (undici TLS, log flushes) on its own, but a
 *      leaking plugin or MCP server can hang the process indefinitely.
 *      A 500ms `setTimeout(exit)` with `.unref()` lets the natural drain
 *      finish first, then forces exit if anything is still pending. The
 *      `.unref()` is critical: it prevents the timer itself from keeping
 *      the event loop alive.
 *   3. **Stack-trace on rejection** — a top-level `main().catch(...)` that
 *      logs `err.stack` (not just the message) makes crash dumps from
 *      end-user bug reports actually debuggable.
 */

// ── Permanent SQLite ExperimentalWarning suppressor ───────────────────────
//
// Node 22.5+'s built-in node:sqlite emits a one-line ExperimentalWarning the
// first time the module is loaded, via process.emitWarning(message, type).
// Three lazy loaders (sage, techstack, codebase-index) already suppress it
// locally, but any code path that loads node:sqlite BEFORE those suppressors
// are instantiated fires the warning to stderr.
//
// By replacing process.emitWarning at this module's evaluation time (before
// any downstream dynamic import or lazy require), this catches the FIRST
// node:sqlite access regardless of which module triggers it. Static imports
// in transitive dependencies are NOT covered (ESM hoists them before this
// runs), but every node:sqlite access in this project is through dynamic
// lazy loaders, so this intercepts all production paths. Later suppressors
// capture the already-filtered function as their "original", which is
// harmless — double-filtering is a no-op.
//
// ⚠️ process.emitWarning(warning: string, type?: string, ...): when warning
// is a plain string (two-arg form used by Node's internal emitExperimentalWarning),
// the type is in rest[0] — NOT warning.name (which is undefined for strings).
const SQLITE_WARNING_RE = /sqlite is an experimental feature/i;

function installSqliteWarningFilter(): void {
  const originalEmit = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
    const msg = typeof warning === 'string' ? warning : ((warning as Error)?.message ?? '');
    // Node's emitWarning overloads:
    //   (warning: string, type?: string, code?: string)
    //   (warning: Error,   options?: { type?: string; code?: string })
    // When warning is a string the type lives in rest[0]; when it's an Error
    // the type is warning.name.
    const type =
      typeof warning === 'string' ? String(rest[0] ?? '') : ((warning as Error).name ?? '');
    if (type === 'ExperimentalWarning' && SQLITE_WARNING_RE.test(msg)) {
      return; // suppressed — node:sqlite has been stable since Node 22.5
    }
    (originalEmit as (w: unknown, ...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

installSqliteWarningFilter();

import { installCrashShield, runFatalSalvageSync, writeErr } from '@wrongstack/core/utils';

const isMain =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('/cli/dist/index.js') ||
  process.argv[1]?.endsWith('\\cli\\dist\\index.js');

interface ErrorEventStream {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  off(event: 'error', listener: (error: unknown) => void): unknown;
}

interface BrokenPipeHandlerOptions {
  streams?: readonly ErrorEventStream[] | undefined;
  exit?: ((code: number) => void) | undefined;
}

function isBrokenOutputConsumer(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ECONNABORTED';
}

/**
 * Treat a closed stdout/stderr consumer as a normal CLI shutdown.
 *
 * A failed `write()` is reported asynchronously through the destination
 * stream's `error` event, so wrapping individual writes in `try/catch` cannot
 * prevent Node's unhandled-event crash. Windows can report the same closed
 * consumer as ECONNRESET rather than EPIPE, so handle both at the process entry
 * boundary and rethrow other stream failures so genuine faults remain visible.
 */
export function installBrokenPipeHandlers(options: BrokenPipeHandlerOptions = {}): () => void {
  const streams = options.streams ?? [process.stdout, process.stderr];
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let handled = false;

  const onError = (error: unknown): void => {
    if (!isBrokenOutputConsumer(error)) throw error;
    if (handled) return;
    handled = true;
    runFatalSalvageSync();
    exit(0);
  };

  for (const stream of streams) stream.on('error', onError);
  return () => {
    for (const stream of streams) stream.off('error', onError);
  };
}

export function runAsMain(mainFn: (argv: string[]) => Promise<number>): void {
  if (!isMain) return;
  installBrokenPipeHandlers();
  // Last-resort shield: one escaped rejection in a timer, watcher, or socket
  // callback otherwise kills the whole in-process host — TUI, WebUI, HQ, fleet.
  // Must come after installBrokenPipeHandlers so EPIPE stays that handler's
  // job; the shield deliberately ignores broken-consumer errors. This call was
  // present, regressed to zero call sites, and is re-armed here (WS-076).
  installCrashShield();
  // Every process.exit / natural drain hits this; hooks are sync and idempotent.
  process.on('exit', () => {
    runFatalSalvageSync();
  });
  mainFn(process.argv.slice(2)).then(
    (c) => {
      // Set exitCode and let Node drain async handles (undici TLS, log file
      // flushes) naturally. Force-exit after a brief grace period so we don't
      // hang if a plugin or MCP server leaks. Avoids libuv UV_HANDLE_CLOSING
      // assertions seen on Windows when process.exit() races with handle teardown.
      process.exitCode = c;
      // 500ms grace: let undici TLS, log flushes, and plugin teardown complete.
      // The unref() prevents this timer from keeping the event loop alive
      // if everything else finishes first.
      setTimeout(() => process.exit(c), 500).unref();
    },
    (err) => {
      // Salvage durability-critical state synchronously before reporting —
      // the unref'd force-exit below gives only ~500ms of drain, which a
      // datasync or sidecar write can exceed on slow disks.
      runFatalSalvageSync();
      writeErr((err instanceof Error ? err.stack : String(err)) + '\n');
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 500).unref();
    },
  );
}
