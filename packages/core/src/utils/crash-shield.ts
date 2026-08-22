import { writeErr } from './term.js';

/**
 * Last-resort process crash shield.
 *
 * Without a process-level handler, ONE escaped rejection anywhere (a void'ed
 * promise in a timer, watcher, or socket callback) kills the whole host —
 * TUI, WebUI server, HQ, fleet, everything. Individual call sites are still
 * expected to catch their own failures (the shield logs loudly so escapes
 * stay visible and get fixed), but a background hiccup must never take down
 * an interactive session.
 *
 * Storm guard: if errors keep firing, the process is likely wedged in a
 * broken hot loop where "keep running" only produces garbage — exit then.
 */
const CRASH_STORM_WINDOW_MS = 60_000;
const CRASH_STORM_LIMIT = 20;

// ── Fatal-path salvage hooks ────────────────────────────────────────────────
//
// Registered by hosts that hold durability-critical state (e.g. the CLI
// registers its active session writer). Invoked synchronously right before a
// fatal exit decided by this shield (error-storm shutdown), and exported for
// the other owners of fatal paths (top-level main rejection, 'exit'
// listeners) so every death path shares ONE salvage sequence. Hooks must be
// synchronous and best-effort — no async work can complete during process
// death, which is exactly why they exist.

const fatalSalvageHooks: Array<() => void> = [];

/** Register a synchronous salvage hook. Returns an unregister function. */
export function addFatalSalvageHook(hook: () => void): () => void {
  fatalSalvageHooks.push(hook);
  return () => {
    const idx = fatalSalvageHooks.indexOf(hook);
    if (idx >= 0) fatalSalvageHooks.splice(idx, 1);
  };
}

/**
 * Run every registered salvage hook once. Swallows individual hook failures
 * so one broken hook cannot skip the remaining ones. Safe to call multiple
 * times — hooks are expected to be idempotent (a drained buffer stays
 * drained).
 */
export function runFatalSalvageSync(): void {
  for (const hook of [...fatalSalvageHooks]) {
    try {
      hook();
    } catch {
      // best-effort — dying anyway
    }
  }
}

interface CrashShieldTarget {
  on(
    event: 'unhandledRejection' | 'uncaughtException',
    listener: (reason: unknown) => void,
  ): unknown;
  off(
    event: 'unhandledRejection' | 'uncaughtException',
    listener: (reason: unknown) => void,
  ): unknown;
}

export interface CrashShieldOptions {
  target?: CrashShieldTarget | undefined;
  exit?: ((code: number) => void) | undefined;
  write?: ((s: string) => void) | undefined;
}

function isBrokenOutputConsumer(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ECONNABORTED';
}

export function installCrashShield(options: CrashShieldOptions = {}): () => void {
  const target = options.target ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const write = options.write ?? ((s: string) => void writeErr(s));
  const recent: number[] = [];
  const isStorming = (): boolean => {
    const now = Date.now();
    recent.push(now);
    while (recent.length > 0 && now - (recent[0] as number) > CRASH_STORM_WINDOW_MS) {
      recent.shift();
    }
    return recent.length > CRASH_STORM_LIMIT;
  };
  const report = (kind: string, reason: unknown): void => {
    try {
      const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
      write(`[wrongstack] ${kind} (recovered — please report): ${detail}\n`);
    } catch {
      // stderr itself is broken; nothing useful left to do.
    }
  };
  const guard =
    (kind: string) =>
    (reason: unknown): void => {
      // EPIPE/ECONNRESET mean the output consumer went away; the host's
      // broken-pipe handler owns that path and turns it into a clean exit.
      if (isBrokenOutputConsumer(reason)) return;
      report(kind, reason);
      if (isStorming()) {
        report(
          kind,
          new Error(
            `error storm: >${CRASH_STORM_LIMIT} in ${CRASH_STORM_WINDOW_MS / 1000}s — exiting`,
          ),
        );
        // Salvage durability-critical state synchronously before dying.
        runFatalSalvageSync();
        exit(1);
      }
    };

  const onRejection = guard('unhandled promise rejection');
  const onException = guard('uncaught exception');
  target.on('unhandledRejection', onRejection);
  target.on('uncaughtException', onException);
  return () => {
    target.off('unhandledRejection', onRejection);
    target.off('uncaughtException', onException);
  };
}
