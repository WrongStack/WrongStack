import { createWriteStream, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalLifecycle, writeErr } from '@wrongstack/core/utils';
import React from 'react';
import { App } from './app.js';
import { ALT_SCREEN_ON } from './mouse.js';
import { createExitOrchestrator } from './run-tui-exits.js';
import { resolveTuiLaunchPlan } from './run-tui-launch.js';
import { mountInkApp } from './run-tui-mount.js';
import type { RunTuiOptions } from './run-tui-options.js';
import { createRunTuiTitleController } from './run-tui-title-controller.js';
import { BRACKETED_PASTE_ON } from './terminal-modes.js';

// Re-export autonomy stage types from core for backward compatibility
export type { AutonomyStage } from '@wrongstack/core/types';
export type { RunTuiOptions } from './run-tui-options.js';
export { silenceTerminal, unsilenceTerminal } from './terminal-silence.js';

export async function runTui(opts: RunTuiOptions): Promise<number> {
  const stdout = process.stdout;
  const stdin = process.stdin;

  // Launch-prep (TTY guard, capability probe, mouse-mode opt-in, terminal
  // silence) lives in resolveTuiLaunchPlan — moved verbatim there in
  // decomposition Phase 1 R1 (docs/decomposition-plan.md). The lifecycle
  // manager stays local: raw-mode acquisition/release spans the session,
  // and cleanup must still close opts.agent.ctx.session on every path.
  const launch = resolveTuiLaunchPlan(opts);
  if (!launch.ok) return launch.exitCode;
  const { capability, mouseEnabled } = launch;

  // Acquire and release raw mode through the lifecycle manager. This guarantees
  // exactly one setRawMode(true) at startup and exactly one setRawMode(false)
  // on any exit path (normal return, signal, uncaught exception, force-exit).
  const lifecycle = new TerminalLifecycle();

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

  // Exit orchestration (idempotent cleanup, durable teardown, the six exit
  // paths, registration lifecycle) moved verbatim into createExitOrchestrator
  // (decomposition Phase 1 R4 — docs/decomposition-plan.md). The cleaned and
  // alternate-screen flags and the registration handle live there now;
  // accessors cross the boundary both ways.
  const exits = createExitOrchestrator({
    opts,
    stdout,
    inkStdin,
    lifecycle,
    stopTitle,
    restoreTrace: () => {
      restoreTrace?.();
    },
  });

  // ── Durable teardown, rapid-Ctrl+C force-exit, signal/exit handlers, the
  // raw-stdin Ctrl+C watcher, and their detach path all moved verbatim into
  // createExitOrchestrator (Phase 1 R4).

  return new Promise<number>((resolve) => {
    exits.attachResolve(resolve);
    // Ink mount handle — hoisted so the waitUntilExit wiring below (outside
    // the try) can reach it. Assigned by mountInkApp inside the try.
    let mount: ReturnType<typeof mountInkApp>;

    // Physically clear the visible screen + scrollback on `/clear`.
    // Notably we do NOT call the Ink Instance's clear() and do NOT emit \x1b[H.
    //
    // Ink's Instance.clear() calls logUpdate.clear() (which erases Ink's
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
      exits.markAlternateScreenActive();
      stdout.write(BRACKETED_PASTE_ON);
      stdout.write('\x1b[2J\x1b[H');

      // Acquire raw mode through the lifecycle manager. This is the last
      // setRawMode call before Ink takes over stdin, closing the Windows ConPTY
      // readline→Ink handoff race (acquire is idempotent).
      lifecycle.acquire(stdin);
      const appElement = React.createElement(App, {
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
        onExit: exits.recordExitCode,
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
        subagentModelsHost: opts.subagentModelsHost,
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
      });
      // Render + inkStdin wiring + raw-Ctrl+C arming + resize erase moved
      // verbatim into mountInkApp (decomposition Phase 1 R3 —
      // docs/decomposition-plan.md). Its internal catch reports through
      // onStartupFailure and returns null; the catch below stays as a
      // last-resort safety net for this try's terminal-mode setup.
      mount = mountInkApp({
        appElement,
        inkStdin,
        stdout,
        onRawCtrlC: exits.onRawCtrlC,
        onStartupFailure: (err) => {
          writeErr(
            `wstack: TUI failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          void opts.agent.ctx.session
            .close()
            .catch(() => undefined)
            .finally(() => exits.settle(1));
        },
      });
      if (!mount) return;
      // Wire the hoisted reference so signal handlers can unmount Ink.
      exits.setInkInstance(mount.instance);
    } catch (err) {
      // Safety net for the terminal-mode setup above — mountInkApp reports
      // its own mount failures through onStartupFailure and returns null.
      writeErr(
        `wstack: TUI failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      void opts.agent.ctx.session
        .close()
        .catch(() => undefined)
        .finally(() => exits.settle(1));
      return;
    }
    mount.instance
      .waitUntilExit()
      .then(() => {
        mount.detachResize();
        exits.settle(exits.getRunExitCode());
      })
      .catch(() => {
        mount.detachResize();
        exits.settle(1);
      });
  });
}
