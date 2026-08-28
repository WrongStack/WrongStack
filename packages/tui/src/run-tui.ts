import { createWriteStream, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectTerminal, TerminalLifecycle, writeErr } from '@wrongstack/core/utils';
import { getProcessRegistry } from '@wrongstack/tools';
import { render } from 'ink';
import React from 'react';
import { App } from './app.js';
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, MOUSE_OFF } from './mouse.js';
import { createRunTuiClientRegistration } from './run-tui-client-registration.js';
import type { RunTuiOptions } from './run-tui-options.js';
import { createDurableTeardown } from './run-tui-teardown.js';
import { createRunTuiTitleController } from './run-tui-title-controller.js';
import { BRACKETED_PASTE_OFF, BRACKETED_PASTE_ON } from './terminal-modes.js';
import { silenceTerminal, unsilenceTerminal } from './terminal-silence.js';

// Re-export autonomy stage types from core for backward compatibility
export type { AutonomyStage } from '@wrongstack/core/types';
export type { RunTuiOptions } from './run-tui-options.js';
export { silenceTerminal, unsilenceTerminal };

export async function runTui(opts: RunTuiOptions): Promise<number> {
  const stdout = process.stdout;
  const stdin = process.stdin;

  // Ink requires a TTY on both stdin and stdout. Without this guard the
  // render call would fail with a terse internal Ink error; bail with a
  // clear message so a piped invocation (`echo hi | wstack --tui`) tells
  // the user what to do instead.
  if (!stdout.isTTY || !stdin.isTTY) {
    writeErr(
      'wstack: --tui requires an interactive terminal on both stdin and stdout.\n' +
        '       Drop the flag (use the plain REPL) or run wstack directly without piping.\n',
    );
    return 2;
  }

  // Acquire and release raw mode through the lifecycle manager. This guarantees
  // exactly one setRawMode(true) at startup and exactly one setRawMode(false)
  // on any exit path (normal return, signal, uncaught exception, force-exit).
  const lifecycle = new TerminalLifecycle();

  // Probe terminal capabilities once — color depth, mouse protocol, title support.
  // Locked in at startup so the profile is stable throughout the session.
  const capability = detectTerminal({ stdin, stdout });

  // Resolve the full pointer-mode opt-in before taking over the screen. A
  // settings adapter is allowed to throw; doing this first guarantees such an
  // error cannot strand the terminal inside the alternate buffer.
  const mouseEnabled =
    opts.mouse ?? opts.getSettings?.().mouseMode ?? process.env.WRONGSTACK_MOUSE === '1';

  // Silence all console / stderr / process-warning output so external
  // writes don't interleave with Ink's terminal control sequences. See
  // the block comment above `silenceTerminal` for the full rationale.
  silenceTerminal();

  // ── Optional raw stdout trace (WRONGSTACK_TUI_TRACE=1 | <path>) ─────────
  // Tees every byte written to the terminal into a file so rendering
  // artifacts (ghost/duplicated frames, scroll desyncs) can be diagnosed
  // from a byte-exact capture instead of guesswork. `1` picks a temp path;
  // any other non-empty value is used as the output path verbatim. The tee
  // sits below Ink and terminal-silence: it sees exactly what the terminal
  // sees. Restored (and the file flushed) on every cleanup path.
  const traceEnv = process.env['WRONGSTACK_TUI_TRACE'];
  let restoreTrace: (() => void) | null = null;
  if (traceEnv && traceEnv !== '0') {
    const tracePath =
      traceEnv === '1' ? join(tmpdir(), `wstack-tui-trace-${process.pid}.bin`) : traceEnv;
    try {
      const stream: WriteStream = createWriteStream(tracePath);
      const realWrite = stdout.write.bind(stdout);
      const teeWrite: typeof stdout.write = (chunk, encodingOrCb?, cb?) => {
        try {
          stream.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
        } catch {
          // Trace best-effort only — never interfere with the real write.
        }
        return realWrite(chunk as never, encodingOrCb as never, cb as never);
      };
      stdout.write = teeWrite;
      restoreTrace = () => {
        stdout.write = realWrite;
        try {
          stream.end();
        } catch {
          // Already closed — ignore.
        }
      };
    } catch {
      // Trace file could not be created — run without tracing.
    }
  }

  // Suppress the one-time maxTools warning on the provider — the StatusBar
  // surfaces the dropped-tool count as a visible chip instead, so a raw
  // process.emitWarning to stderr is redundant (and already swallowed by
  // silenceTerminal's process.on('warning') interceptor). This call is
  // explicit defense-in-depth: it documents intent and survives a future
  // change to silenceTerminal's warning interception.
  const provider = opts.agent.ctx.provider as unknown as
    | {
        suppressMaxToolsWarning?: (() => void) | undefined;
      }
    | undefined;
  if (provider?.suppressMaxToolsWarning) {
    provider.suppressMaxToolsWarning();
  }

  // Resolve the full pointer-mode opt-in. The App component owns the actual
  // lifecycle: managed history always captures wheel reports, while this flag
  // adds drag/clickable UI. cleanup() below sends MOUSE_OFF unconditionally so
  // the terminal is never left reporting mouse events after exit.

  const inkStdin: NodeJS.ReadStream = stdin;

  // Animated window/tab title: a braille spinner + live status (thinking /
  // running a tool) driven by the EventBus, scrolling the app name when idle.
  // Out-of-band OSC sequence, so it never touches Ink's render. Reset on
  // cleanup(). Disabled when WRONGSTACK_NO_TITLE=1 (handled inside
  // startTerminalTitle) or titleAnimation is false.
  //
  // Wrapped in a small start/stop controller (idempotent) so the TUI
  // `/settings` picker can toggle the title animation live without a restart.
  const {
    controller: titleController,
    start: startTitle,
    stop: stopTitle,
  } = createRunTuiTitleController({
    stdout,
    events: opts.events,
    model: opts.model,
    projectRoot: opts.projectRoot,
  });
  if (opts.titleAnimation !== false) startTitle();

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
  const tuiClientRegistration = createRunTuiClientRegistration({
    projectRoot: opts.projectRoot,
    events: opts.events,
    appConfig: opts.appConfig,
    hqTelemetryOwnedExternally: opts.hqTelemetryOwnedExternally,
    getSessionId: opts.getSessionId,
    getAgentId: () =>
      (opts.agent.ctx.meta['globalAgentId'] as string | undefined) ?? opts.agent.ctx.agentId,
    isCleaned: () => cleaned,
  });

  // Hoisted Ink instance reference — signal handlers (registered before the
  // Promise constructor where `instance` lives) need to call unmount() on
  // external signals. Assigned when render() runs.
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
      restoreTrace?.();
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
  const finishRun = (code: number): void => {
    detachListeners();
    if (!resolveRun) return;
    const resolve = resolveRun;
    resolveRun = undefined;
    resolve(code);
  };

  const durableTeardown = createDurableTeardown({
    getSession: () => opts.agent.ctx.session,
    killChildren: () =>
      getProcessRegistry().killAll({ force: true, preserveBackground: true }),
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
  // Attached AFTER Ink renders (see the `inkInstance = instance` site) — a
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

  return new Promise<number>((resolve) => {
    resolveRun = resolve;
    let hardExitTimer: ReturnType<typeof setTimeout> | null = null;
    const onExit = (code: number) => {
      runExitCode = code;
    };
    const settle = (code: number) => {
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

    /**
     * Request the TUI to exit with a specific code. This triggers Ink's unmount
     * (restoring terminal state) and resolves the runTui promise with the given code.
     * Used for clean exits when switching projects — the host CLI catches the exit
     * code and spawns a new wstack process in the target directory.
     */
    const requestExit = (code: number) => {
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

    // Wire requestExit to the options so the App can call it
    opts.requestExit = requestExit;

    let instance: ReturnType<typeof render>;

    // Physically clear the visible screen + scrollback on `/clear`.
    // Notably we do NOT call `instance?.clear()` and do NOT emit `\x1b[H`.
    //
    // Ink's `instance.clear()` calls logUpdate.clear() (which erases Ink's
    // output and resets the line tracker) then logUpdate.sync(oldOutput)
    // (which sets the tracker back to the OLD output dimensions).  Since
    // the terminal is already empty after the clear, logUpdate now thinks
    // N lines of phantom content are on screen.  When the subsequent render
    // produces fresh (short) output, logUpdate tries to `eraseLines(N)` from
    // cursor position (0,0) — the N cursor-up sequences overshoot the top
    // of the terminal and the output lands in the wrong place, producing
    // duplicated input lines and a garbled interface.
    //
    // Instead we only physically clear the screen (\x1b[2J) and scrollback
    // (\x1b[3J) — WITHOUT \x1b[H (cursor home) — and let Ink's natural
    // re-render (triggered by the state changes in onClearHistory) produce
    // the fresh output from the correct cursor position.  Ink and logUpdate
    // keep their pre-clear tracker values so the ANSI diff is calculated
    // relative to a cursor that still matches reality.
    const clearTerminal = () => {
      try {
        stdout.write('\x1b[2J\x1b[3J');
      } catch {
        // stdout may be closed mid-teardown — ignore.
      }
    };
    try {
      // A full-screen TUI must not share the normal buffer's scrollback. DECSET
      // 1049 saves the shell screen and enters a fresh alternate buffer;
      // terminals disable native scrollback/scrollbars for that buffer.
      stdout.write(ALT_SCREEN_ON);
      alternateScreenActive = true;
      stdout.write(BRACKETED_PASTE_ON);
      stdout.write('\x1b[2J\x1b[H');

      // Acquire raw mode through the lifecycle manager. This is the last
      // setRawMode call before Ink takes over stdin, closing the Windows ConPTY
      // readline→Ink handoff race (acquire is idempotent).
      lifecycle.acquire(stdin);
      instance = render(
        React.createElement(App, {
          agent: opts.agent,
          slashRegistry: opts.slashRegistry,
          skillLoader: opts.skillLoader,
          getResourceMenu: opts.getResourceMenu,
          secretInputController: opts.secretInputController,
          attachments: opts.attachments,
          events: opts.events,
          tokenCounter: opts.tokenCounter,
          visionAdapters: opts.visionAdapters,
          supportsVision: opts.supportsVision,
          model: opts.model,
          banner: opts.banner ?? true,
          queueStore: opts.queueStore,
          onQueueChange: opts.onQueueChange,
          yolo: opts.yolo,
          getYolo: opts.getYolo,
          onYolo: opts.onYolo,
          getAutonomy: opts.getAutonomy,
          getEternalEngine: opts.getEternalEngine,
          getParallelEngine: opts.getParallelEngine,
          getSddRun: opts.getSddRun,
          onSddLifecycle: opts.onSddLifecycle,
          subscribeEternalIteration: opts.subscribeEternalIteration,
          subscribeEternalStage: opts.subscribeEternalStage,
          subscribeGoal: opts.subscribeGoal,
          appVersion: opts.appVersion,
          provider: opts.provider,
          family: opts.family,
          keyTail: opts.keyTail,
          profile: opts.profile,
          profileConfigPath: opts.profileConfigPath,
          autonomyAgents: opts.autonomyAgents,
          latestVersion: opts.latestVersion,
          updateAvailable: opts.updateAvailable,
          getPickableProviders: opts.getPickableProviders,
          switchProviderAndModel: opts.switchProviderAndModel,
          switchAutonomy: opts.switchAutonomy,
          effectiveMaxContext: opts.effectiveMaxContext,
          onExit,
          director: opts.director ?? null,
          getDirector: opts.getDirector,
          fleetRoster: opts.fleetRoster,
          onClearHistory: opts.onClearHistory
            ? (dispatch) => opts.onClearHistory?.(dispatch)
            : undefined,
          clearTerminal,
          fleetStreamController: opts.fleetStreamController,
          agentTranscripts: opts.agentTranscripts,
          interruptController: opts.interruptController,
          enhanceController: opts.enhanceController,
          enhanceEnabled: opts.enhanceController?.enabled ?? true,
          getEnhancerReasoning: opts.getEnhancerReasoning,
          getActiveModelReasoningEffortLevels: opts.getActiveModelReasoningEffortLevels,
          buildEnhancerProvider: opts.buildEnhancerProvider,
          getEnhanceFallbackRef: opts.getEnhanceFallbackRef,
          getConfiguredRefinerRef: opts.getConfiguredRefinerRef,
          midRunSendPicker: opts.getSettings?.().midRunSendPicker ?? true,
          statuslineHiddenItems: opts.statuslineHiddenItems,
          setStatuslineHiddenItems: opts.setStatuslineHiddenItems,
          saveStatuslineHiddenItems: opts.saveStatuslineHiddenItems,
          agentsMonitorController: opts.agentsMonitorController,
          initialGoal: opts.initialGoal,
          initialAsk: opts.initialAsk,
          getSDDContext: opts.getSDDContext,
          onSDDOutput: opts.onSDDOutput,
          sessionsDir: opts.sessionsDir,
          projectRoot: opts.projectRoot,
          getSettings: opts.getSettings,
          saveSettings: opts.saveSettings,
          saveThemePreset: opts.saveThemePreset,
          configStore: opts.configStore,
          getPluginItems: opts.getPluginItems,
          onPluginToggle: opts.onPluginToggle,
          getMcpServers: opts.getMcpServers,
          onMcpToggle: opts.onMcpToggle,
          onMcpRestart: opts.onMcpRestart,
          getToolsItems: opts.getToolsItems,
          onToolToggle: opts.onToolToggle,
          getBrainData: opts.getBrainData,
          onBrainRiskLevel: opts.onBrainRiskLevel,
          brainPanelHost: opts.brainPanelHost,
          getShadowData: opts.getShadowData,
          onShadowStart: opts.onShadowStart,
          onShadowStop: opts.onShadowStop,
          authHost: opts.authHost,
          predictNext: opts.predictNext,
          onSuggestionsParsed: opts.onSuggestionsParsed,
          getSuggestions: opts.getSuggestions,
          getAutoSuggestions: opts.getAutoSuggestions,
          autonomyNextPrompt: opts.autonomyNextPrompt,
          setSuggestions: opts.setSuggestions,
          chime: opts.chime,
          confirmExit: opts.confirmExit,
          titleController,
          mouse: mouseEnabled,
          capability,
          modeLabel: opts.modeLabel,
          tokenSavingMode: opts.tokenSavingMode,
          toolCount: opts.toolCount,
          getModeLabel: opts.getModeLabel,
          getModes: opts.getModes,
          switchMode: opts.switchMode,
          registerDebugStreamCallback: opts.registerDebugStreamCallback,
          restoreDebugStreamCallback: opts.restoreDebugStreamCallback,
          restoredMessages: opts.restoredMessages,
          restoredToolCalls: opts.restoredToolCalls,
          restoredEvents: opts.restoredEvents,
          listSessions: opts.listSessions,
          onResumeSession: opts.onResumeSession,
          getProjectPickerItems: opts.getProjectPickerItems,
          onProjectSelect: opts.onProjectSelect,
          requestExit: opts.requestExit,
          getLiveSessions: opts.getLiveSessions,
          onSwitchToSession: opts.onSwitchToSession,
          initialAgentsMonitorOpen: opts.initialAgentsMonitorOpen,
          subscribeCoordinatorEvents: opts.subscribeCoordinatorEvents,
          onPanelOpen: opts.onPanelOpen,
          onCoordinatorStart: opts.onCoordinatorStart,
          onCoordinatorStop: opts.onCoordinatorStop,
          onCoordinatorTasks: opts.onCoordinatorTasks,
          onCoordinatorClaim: opts.onCoordinatorClaim,
          onCoordinatorComplete: opts.onCoordinatorComplete,
          onCoordinatorFail: opts.onCoordinatorFail,
          onCoordinatorStatus: opts.onCoordinatorStatus,
          memoryStore: opts.memoryStore,
        }),
        {
          exitOnCtrlC: false,
          stdin: inkStdin,
          // Bound reconciliation/tokenization work for large live histories
          // while preserving responsive streamed output.
          maxFps: 10,
        },
      );
      // Wire the hoisted reference so signal handlers can unmount Ink.
      inkInstance = instance;
      // Arm the last-resort raw Ctrl+C watcher now that Ink owns stdin —
      // attaching a 'data' listener earlier would flip the stream into
      // flowing mode before Ink mounts and drop boot-time keystrokes.
      inkStdin.on('data', onRawCtrlC);
    } catch (err) {
      writeErr(
        `wstack: TUI failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      void opts.agent.ctx.session
        .close()
        .catch(() => undefined)
        .finally(() => settle(1));
      return;
    }
    // Terminal reflows visible text on resize BEFORE Ink can react, which can
    // leave ghosts below the cursor. Erase from-cursor-to-end on every resize
    // to minimize artifacts. Ink immediately re-renders at the new width.
    let detachResize: (() => void) | null = null;
    const onResize = () => {
      try {
        // \x1b[J = erase from cursor to end of screen. Does NOT touch
        // anything above the cursor, so committed Static history in
        // scrollback is preserved. Ink's useStdout subscriber will
        // immediately re-render the live region at the new width.
        // Do NOT prefix with \x1b[H: homing to (0,0) erases the visible
        // committed output and repositions the live region (input + status
        // bar) at the top of the viewport instead of the bottom.
        stdout.write('\x1b[J');
      } catch {
        // stdout might be detached mid-shutdown — ignore.
      }
    };
    stdout.on('resize', onResize);
    detachResize = () => stdout.off('resize', onResize);

    instance
      .waitUntilExit()
      .then(() => {
        detachResize?.();
        settle(runExitCode);
      })
      .catch(() => {
        detachResize?.();
        settle(1);
      });
  });
}
