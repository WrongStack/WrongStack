import type { TerminalLifecycle } from '@wrongstack/core/utils';
import { getProcessRegistry } from '@wrongstack/tools';
import { ALT_SCREEN_OFF, MOUSE_OFF } from './mouse.js';
import type { RunTuiOptions } from './run-tui-options.js';
import { setupTuiSession } from './run-tui-session.js';
import { createDurableTeardown } from './run-tui-teardown.js';
import { BRACKETED_PASTE_OFF } from './terminal-modes.js';
import { unsilenceTerminal } from './terminal-silence.js';

/** Everything runTui needs from the exit wiring after handing it over. */
export interface ExitOrchestrator {
  /** Resolves the run promise through the durable-close budget. */
  settle: (code: number) => void;
  /** Clean project-switch exit: unmount, then a 5s hard-exit fallback. */
  requestExit: (code: number) => void;
  /** Raw-stdin Ctrl+C watcher — pass to mountInkApp (armed after render). */
  onRawCtrlC: (data: Buffer | string) => void;
  /** Exit code last recorded by a signal/exit path (0 until then). */
  getRunExitCode: () => number;
  /** Records an exit code reported outside the orchestrator (App prop). */
  recordExitCode: (code: number) => void;
  /** Signal handlers unmount through this — set after mountInkApp returns. */
  setInkInstance: (instance: { unmount: () => void }) => void;
  /** Called by runTui's executor: wires the deferred run promise resolve. */
  attachResolve: (resolve: (code: number) => void) => void;
  /** The render try flips this when the alternate buffer is entered. */
  markAlternateScreenActive: () => void;
}

export interface ExitOrchestratorDeps {
  opts: RunTuiOptions;
  stdout: NodeJS.WriteStream;
  inkStdin: NodeJS.ReadStream;
  lifecycle: TerminalLifecycle;
  stopTitle: () => void;
  /** No-op-when-null wrapper over runTui's trace-tee restore handle. */
  restoreTrace: () => void;
}

/**
 * Single owner for the six exit paths through idempotent cleanup — moved
 * verbatim from runTui() (decomposition Phase 1 R4, docs/decomposition-plan.md):
 * natural settle, SIGTERM/SIGHUP/SIGBREAK, SIGINT rapid-press, the raw-stdin
 * Ctrl+C watcher, the process 'exit' listener, and requestExit. Builds on
 * createDurableTeardown (salvage + bounded close on every path) and composes
 * setupTuiSession for the client registration lifecycle.
 *
 * Ownership transferred from runTui: the `cleaned` and alternate-screen flags,
 * the client registration handle, the ink instance reference, and the deferred
 * resolve (attachResolve from the run promise's executor).
 */
export function createExitOrchestrator(deps: ExitOrchestratorDeps): ExitOrchestrator {
  const { opts, stdout, inkStdin, lifecycle, stopTitle, restoreTrace } = deps;

  // Take over EVERY keystroke. Raw mode (Ink turns this on when render
  // mounts) already disables ICANON/ECHO/ISIG/IXON on Linux+macOS, so
  // Ctrl+C/Z/\\/S/Q arrive as input bytes instead of generating
  // signals or being eaten by the terminal driver. Belt-and-suspenders:
  // install no-op handlers for the suspend/quit signals just in case
  // some shell or terminal still surfaces them — without these, a
  // stray Ctrl+Z could background the TUI mid-session.
  const swallowSignals: NodeJS.Signals[] = ['SIGTSTP', 'SIGQUIT', 'SIGTTIN', 'SIGTTOU'];
  const swallow = () => {};
  for (const s of swallowSignals) {
    try {
      process.on(s, swallow);
    } catch {
      // Signal not supported on this platform (Windows ignores most of
      // these). Safe to skip — there's nothing for the terminal to
      // deliver in the first place.
    }
  }

  // Track cleanup state so signal handlers don't double-disable.
  let cleaned = false;
  let alternateScreenActive = false;
  const tuiClientRegistration = setupTuiSession(opts, () => cleaned);

  // Hoisted Ink instance reference — signal handlers need to call unmount()
  // on external signals. Assigned via setInkInstance when mountInkApp runs.
  let inkInstance: { unmount: () => void } | null = null;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    tuiClientRegistration.unregister();
    void opts.agent.ctx.session.close().catch(() => undefined);
    try {
      stopTitle();
    } catch {
      // title controller already torn down — ignore.
    }
    try {
      stdout.write(BRACKETED_PASTE_OFF);
      // Disabling unset modes is a no-op, so this is safe even when mouse
      // tracking was never enabled — guarantees no leaked mouse reporting.
      stdout.write(MOUSE_OFF);
      // Release raw mode and reset SGR + cursor via the lifecycle manager.
      // release() calls setRawMode(false) and emits the reset sequence; it is
      // idempotent (safe to call even if raw mode was never acquired).
      lifecycle.release();
      if (alternateScreenActive) {
        // Restore the saved normal buffer only after every TUI-owned mode is
        // off. No printable output may follow this write or it would leak into
        // the user's shell screen.
        stdout.write(ALT_SCREEN_OFF);
        alternateScreenActive = false;
      }
      lifecycle.reset(stdout);
    } catch {
      // stdout may already be closed during shutdown — ignore.
    } finally {
      restoreTrace();
      unsilenceTerminal();
    }
  };

  // ── Durable teardown ─────────────────────────────────────────────────────
  // Single owner for kill-safety on every TUI exit path: synchronous
  // flushSync salvage first (survives any concurrent hard exit), bounded
  // await of the async close, then exit. Wired into the SIGINT/SIGTERM/
  // SIGHUP/SIGBREAK handlers, the rapid-Ctrl+C escape hatch, the 'exit'
  // listener, and the natural settle() path below.
  let resolveRun: ((code: number) => void) | undefined;
  let runExitCode = 0;
  let hardExitTimer: ReturnType<typeof setTimeout> | null = null;
  const onExit = (code: number): void => {
    runExitCode = code;
  };
  const finishRun = (code: number): void => {
    detachListeners();
    if (!resolveRun) return;
    const resolve = resolveRun;
    resolveRun = undefined;
    resolve(code);
  };

  const durableTeardown = createDurableTeardown({
    getSession: () => opts.agent.ctx.session,
    killChildren: () => getProcessRegistry().killAll({ force: true, preserveBackground: true }),
    cleanup,
    // Resolve the host instead of process.exit so CLI teardown (plugin
    // stop, Telegram lock.release, vector-memory close) still runs.
    // Rapid Ctrl+C and the hung-unmount timer still hard-exit.
    exit: (code) => finishRun(code),
  });

  // ── Rapid Ctrl+C force-exit ─────────────────────────────────────────────
  // Tracks consecutive SIGINT signals. When the user presses Ctrl+C twice
  // within RAPID_EXIT_WINDOW_MS, we force-exit immediately instead of going
  // through the normal cleanup + Ink unmount path. This is intentional: the
  // user explicitly wants to kill the app, and waiting for Ink to unmount
  // can take seconds. The counter resets after the window expires so a long
  // pause between presses doesn't count as "rapid".
  const RAPID_EXIT_WINDOW_MS = 2_000;
  const RAPID_EXIT_THRESHOLD = 2;
  let ctrlCPressTimestamps: number[] = [];

  const forceExitViaRapidCtrlC = (): void => {
    // Detach all listeners first so cleanup() doesn't race with process.exit()
    detachListeners();
    tuiClientRegistration.unregister();
    // Tree-kill foreground children before exiting. Explicit background jobs
    // are detached and intentionally preserved across the host shutdown.
    try {
      getProcessRegistry().killAll({ force: true, preserveBackground: true });
    } catch {
      // best-effort — exiting either way
    }
    // Hard exit skips every async teardown path, including the session
    // writer's buffered flush — drain it synchronously so the last events
    // of the aborted run survive on disk.
    durableTeardown.salvageSync();
    // Synchronous and idempotent: disables input modes, exits alternate screen,
    // restores raw mode/cursor/style, and unsilences terminal output.
    cleanup();
    process.exit(130);
  };

  // ── Signal / exit handlers ───────────────────────────────────────────────
  // If the process is killed externally (terminal closed, SIGTERM from a
  // supervisor) waitUntilExit's .then/.catch never runs. Register signal +
  // exit listeners so the terminal isn't left in bracketed-paste mode.
  //
  // Node.js default signal behavior is overridden once a listener is
  // registered. We MUST explicitly exit after cleanup — otherwise Ink's
  // event loop keeps running and the process appears to hang. The unmount
  // triggers settle() via waitUntilExit's resolution; the hard-exit timer
  // is a safety net for when Ink's unmount itself hangs.
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGINT'];
  const signalHandler = () => {
    runExitCode = 143;
    inkInstance?.unmount();
    // Durable teardown: salvage + bounded close, then resolve the host
    // (not process.exit) so CLI teardown still runs.
    void durableTeardown.shutdownViaSignal(143);
  };
  const exitHandler = () => {
    // 'exit' runs in a sync-only context — async close work can never finish
    // here, so only the synchronous drain counts.
    durableTeardown.salvageSync();
    cleanup();
  };

  // SIGINT (Ctrl+C) gets special treatment: track rapid presses.
  const sigintHandler = (): void => {
    const now = Date.now();
    // Prune timestamps outside the window
    ctrlCPressTimestamps = ctrlCPressTimestamps.filter((t) => now - t < RAPID_EXIT_WINDOW_MS);
    ctrlCPressTimestamps.push(now);

    if (ctrlCPressTimestamps.length >= RAPID_EXIT_THRESHOLD) {
      // 2+ rapid Ctrl+C — force exit immediately
      ctrlCPressTimestamps = [];
      forceExitViaRapidCtrlC();
      return;
    }
    // First or second press — clean shutdown via Ink unmount. The unmount
    // restores terminal state and resolves waitUntilExit(); the durable
    // teardown then salvages synchronously and awaits close under its own
    // bounded budget before exiting.
    runExitCode = 130;
    inkInstance?.unmount();
    void durableTeardown.shutdownViaSignal(130);
  };

  process.on('SIGINT', sigintHandler);
  // SIGBREAK = Ctrl+Break on Windows — an escape hatch users reach for when
  // Ctrl+C appears dead. Same clean-shutdown path as SIGTERM/SIGHUP.
  for (const s of ['SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(s as NodeJS.Signals, signalHandler);
    } catch {
      // Platform may not support this signal
    }
  }
  process.on('exit', exitHandler);

  // ── Last-resort raw Ctrl+C watcher ──────────────────────────────────────
  // In raw mode the terminal NEVER raises SIGINT for Ctrl+C — it arrives as
  // a 0x03 byte on stdin. The App's key router handles it (escalation
  // ladder: abort → exit → hard-exit), but that path depends on Ink's input
  // pipeline and a responsive React tree. This listener is independent of
  // both: it only OBSERVES the byte stream and force-exits after 3 rapid
  // presses, sharing the same timestamp window as the SIGINT path so mixed
  // delivery still counts. When the tree is healthy the App ladder also exits
  // on the 2nd press; when the tree is wedged, this independent watcher makes
  // those same two presses an unconditional escape hatch.
  const onRawCtrlC = (data: Buffer | string): void => {
    const hasCtrlC = typeof data === 'string' ? data.includes('\x03') : data.includes(0x03);
    if (!hasCtrlC) return;
    const now = Date.now();
    ctrlCPressTimestamps = ctrlCPressTimestamps.filter((t) => now - t < RAPID_EXIT_WINDOW_MS);
    ctrlCPressTimestamps.push(now);
    if (ctrlCPressTimestamps.length >= RAPID_EXIT_THRESHOLD) {
      ctrlCPressTimestamps = [];
      forceExitViaRapidCtrlC();
    }
  };
  // Attached AFTER Ink renders (see the mountInkApp call site) — a
  // 'data' listener flips stdin into flowing mode, and doing that before Ink
  // mounts would drop keystrokes typed during boot.

  const detachListeners = () => {
    process.off('SIGINT', sigintHandler);
    inkStdin.off('data', onRawCtrlC);
    for (const s of signals) process.off(s, signalHandler);
    try {
      process.off('SIGBREAK' as NodeJS.Signals, signalHandler);
    } catch {
      // ignore — see install site
    }
    for (const s of swallowSignals) {
      try {
        process.off(s, swallow);
      } catch {
        // ignore — see install site
      }
    }
    process.off('exit', exitHandler);
  };

  // Register immediately (fire-and-forget)
  void tuiClientRegistration.register();

  const settle = (code: number): void => {
    // The unmount completed normally — cancel the hang fallback. Leaving it
    // armed used to hard-kill the HOST ~400ms after a project switch,
    // racing the post-TUI respawn logic in execution.ts.
    if (hardExitTimer) {
      clearTimeout(hardExitTimer);
      hardExitTimer = null;
    }
    // Natural exit is durable too: salvage + bounded close BEFORE resolving,
    // so the host's post-TUI grace period never cuts the datasync/sidecar
    // write short. cleanup() runs inside awaitDurableClose (terminal state
    // is restored before resolve); resolve is deferred until durability.
    void durableTeardown.awaitDurableClose().then(
      () => finishRun(code),
      () => finishRun(code),
    );
  };

  const requestExit = (code: number): void => {
    onExit(code);
    // Trigger Ink's unmount — it restores terminal state (raw mode off,
    // cursor shown) and resolves waitUntilExit(). A bare process.exit()
    // would skip this and leave the terminal in a broken state.
    // Hard-exit ONLY if Ink's unmount hangs (settle() cancels this timer
    // on the normal path).
    inkInstance?.unmount();
    hardExitTimer = setTimeout(() => {
      durableTeardown.salvageSync();
      try {
        getProcessRegistry().killAll({ force: true, preserveBackground: true });
      } catch {
        // best-effort — exiting either way
      }
      process.exit(code);
    }, 5_000);
    hardExitTimer.unref();
  };

  // Wire requestExit to the options so the App can call it.
  opts.requestExit = requestExit;

  return {
    settle,
    requestExit,
    onRawCtrlC,
    getRunExitCode: () => runExitCode,
    recordExitCode: onExit,
    setInkInstance: (instance: { unmount: () => void }) => {
      inkInstance = instance;
    },
    attachResolve: (resolve: (code: number) => void) => {
      resolveRun = resolve;
    },
    markAlternateScreenActive: () => {
      alternateScreenActive = true;
    },
  };
}
