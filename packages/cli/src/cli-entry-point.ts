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
 *      grace window is durability-aware: it extends in 500ms steps while a
 *      fs write stream is still active (hard 5s ceiling), grants sockets one
 *      extra window (idle keep-alives must not stall exit), and every forced
 *      exit is reported via a structured `exit.forced` warning. The
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

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installCrashShield, runFatalSalvageSync, writeErr } from '@wrongstack/core/utils';

function isCliMain(moduleUrl: string, argvEntry = process.argv[1]): boolean {
  if (!argvEntry) return false;
  try {
    if (moduleUrl === pathToFileURL(resolve(argvEntry)).href) return true;
  } catch {
    // Keep the historical suffix fallback for unusual launchers/URL-like argv values.
  }
  return argvEntry.endsWith('/cli/dist/index.js') || argvEntry.endsWith('\\cli\\dist\\index.js');
}

const isMain = isCliMain(import.meta.url);

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

// ── Forced-exit scheduling ────────────────────────────────────────────────
//
// After main() resolves, the process should exit with its code. Node drains
// pending async handles naturally; the unref'd timer below is the backstop
// for handles that never close (leaked plugin/MCP servers). Two refinements
// over a fixed 500ms kill:
//
//   • Durability-aware grace: while handles that can carry unflushed writes
//     are still active, the window extends in 500ms steps up to a hard 5s
//     ceiling. The ceiling keeps the original anti-hang guarantee — a leaked
//     handle delays exit by at most 5s, never forever.
//   • Observability: an exit that HAD to be forced emits a structured
//     `exit.forced` warning naming the surviving handles, so field reports
//     can distinguish "clean drain" from "work was truncated". A natural
//     drain (the overwhelmingly common case) prints nothing.
//
// The hints are evidence-tuned to what process.getActiveResourcesInfo() can
// actually tell us: libuv OWNER CONSTRUCTOR NAMES only. It cannot distinguish
// an idle keep-alive socket from one mid-flush, and TLS connections report as
// 'TCPSocketWrap' (there is no 'TLSSocket' value — do not re-add that entry).
// So each resource type earns a different amount of waiting:
//   • 'WriteStream' is fs-backed (redirected output, log files, session
//     JSONL) — unflushed bytes are real, so it may extend repeatedly up to
//     the hard ceiling.
//   • 'TCPSocketWrap' may equally be an idle undici keep-alive or HQ/MCP
//     sidecar socket, so it earns at most ONE extra window — enough for a
//     socket mid-flush, without making every HTTP-touching invocation pay
//     the full ceiling at exit.
const EXIT_GRACE_MS = 500;
const EXIT_GRACE_MAX_MS = 5_000;
const MAX_SOCKET_GRACE_EXTENSIONS = 1;

interface ForcedExitDeps {
  readonly getActiveResources?: () => readonly string[];
  readonly exit?: ((code: number) => void) | undefined;
}

export function scheduleForcedExit(code: number, deps: ForcedExitDeps = {}): void {
  const getActiveResources =
    deps.getActiveResources ?? (() => process.getActiveResourcesInfo?.() ?? []);
  const exit = deps.exit ?? ((exitCode: number) => process.exit(exitCode));
  const startedAt = Date.now();
  let extensions = 0;
  let socketExtensions = 0;

  const check = (): void => {
    const active = getActiveResources();
    const waitedMs = Date.now() - startedAt;
    const hasWriteStream = active.includes('WriteStream');
    const hasSocket = active.includes('TCPSocketWrap');
    const canFlush =
      waitedMs < EXIT_GRACE_MAX_MS &&
      (hasWriteStream || (hasSocket && socketExtensions < MAX_SOCKET_GRACE_EXTENSIONS));
    if (canFlush) {
      extensions += 1;
      // A fs stream justifies the wait on its own; only count the extension
      // against the socket budget when a socket is the sole justification.
      if (!hasWriteStream) socketExtensions += 1;
      const timer = setTimeout(check, Math.min(EXIT_GRACE_MS, EXIT_GRACE_MAX_MS - waitedMs));
      timer.unref();
      return;
    }
    if (active.length > 0) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'exit.forced',
          message: `Forcing exit after ${waitedMs}ms grace; ${active.length} active handle(s) remained`,
          exitCode: code,
          waitedMs,
          extensions,
          activeResources: active,
          timestamp: new Date().toISOString(),
        }),
      );
    }
    exit(code);
  };

  const first = setTimeout(check, EXIT_GRACE_MS);
  first.unref();
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
      // flushes) naturally. Force-exit after the durability-aware grace
      // window so we don't hang if a plugin or MCP server leaks. Avoids
      // libuv UV_HANDLE_CLOSING assertions seen on Windows when
      // process.exit() races with handle teardown.
      process.exitCode = c;
      scheduleForcedExit(c);
    },
    (err) => {
      // Salvage durability-critical state synchronously before reporting —
      // the unref'd force-exit below gives only a bounded drain window,
      // which a datasync or sidecar write can exceed on slow disks. The
      // window now extends while write-capable handles are still active,
      // up to the hard ceiling in scheduleForcedExit.
      runFatalSalvageSync();
      writeErr((err instanceof Error ? err.stack : String(err)) + '\n');
      process.exitCode = 1;
      scheduleForcedExit(1);
    },
  );
}
