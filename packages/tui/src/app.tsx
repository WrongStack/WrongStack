import * as path from 'node:path';
import type { Director } from '@wrongstack/core/coordination';
import { applyRewindToConversation, DefaultSessionRewinder } from '@wrongstack/core/storage';
import React, { useCallback, useEffect, useRef } from 'react';
import {
  effectivePanelPositions,
  mergeStatuslineHiddenItems,
  resolveAppSidebarLayout,
} from './app-ui-state.js';
import { AppView } from './app-view.js';
import { deriveAppViewState } from './app-view-state.js';
import { leaderTimelineFromEntries } from './components/agents-monitor.js';
import type { HistoryScrollController } from './components/scrollable-history.js';
import type { StatusBarClickMap } from './components/status-bar-types.js';
import type { StatuslineItem } from './components/statusline-picker.js';
import { useActiveTheme } from './hooks/use-active-theme.js';
import { useAppPickerKeys } from './hooks/use-app-picker-keys.js';
import { useAppRuntimeRefs } from './hooks/use-app-runtime-refs.js';
import { useAppSessionState } from './hooks/use-app-session-state.js';
import { useAuthPanel } from './hooks/use-auth-panel.js';
import { useAutonomousCoordinator } from './hooks/use-autonomous-coordinator.js';
import { useAutonomyDrivers } from './hooks/use-autonomy-drivers.js';
import { useBrainPanel } from './hooks/use-brain-panel.js';
import { useBrainRiskSync } from './hooks/use-brain-risk-sync.js';
import { useClientTelemetry } from './hooks/use-client-telemetry.js';
import { useCoreTuiCommands } from './hooks/use-core-tui-commands.js';
import { useDirectorFleetBridge } from './hooks/use-director-fleet-bridge.js';
import { useEnhanceRuntimeState } from './hooks/use-enhance-runtime-state.js';
import { useExitCommand } from './hooks/use-exit-command.js';
import { useFileSearch } from './hooks/use-file-search.js';
import { useGitSessionStatus } from './hooks/use-git-session-status.js';
import { useHelpPanel } from './hooks/use-help-panel.js';
import { useHistoryCopyNotice } from './hooks/use-history-copy-notice.js';
import { useHistoryViewportSync } from './hooks/use-history-viewport-sync.js';
import { useInitialPrompt } from './hooks/use-initial-prompt.js';
import { useInputHistoryPersistence } from './hooks/use-input-history-persistence.js';
import { useInterruptLadder } from './hooks/use-interrupt-ladder.js';
import { useKanbanBoardFocus } from './hooks/use-kanban-board-focus.js';
import { useLiveSettingsState } from './hooks/use-live-settings-state.js';
import { useLiveTodos } from './hooks/use-live-todos.js';
import { useMailboxViewModel } from './hooks/use-mailbox-view-model.js';
import { useModePicker } from './hooks/use-mode-picker.js';
import { useModelPickRequest } from './hooks/use-model-pick.js';
import { useMouseTracking } from './hooks/use-mouse-tracking.js';
import { useNextStepsAutoSubmit } from './hooks/use-next-steps-auto-submit.js';
import { usePanelControllers } from './hooks/use-panel-controllers.js';
import { usePasteHandling } from './hooks/use-paste-handling.js';
import { usePromptPicker } from './hooks/use-prompt-picker.js';
import { useProviderEventBridge } from './hooks/use-provider-event-bridge.js';
import { useQueueManager } from './hooks/use-queue-manager.js';
import { useSessionInterruptController } from './hooks/use-session-interrupt-controller.js';
import { useSettingsAutoSave } from './hooks/use-settings-auto-save.js';
import { useShadowPanel } from './hooks/use-shadow-panel.js';
import { useSlashPicker } from './hooks/use-slash-picker.js';
import { useStableKeyHandler } from './hooks/use-stable-key-handler.js';
import { useStatusbarViewModel } from './hooks/use-statusbar-view-model.js';
import { useStatuslineHiddenSync } from './hooks/use-statusline-hidden-sync.js';
import { useStreamChipExpiration } from './hooks/use-stream-chip-expiration.js';
import { useThemeState } from './hooks/use-theme-state.js';
import { useTuiActivity } from './hooks/use-tui-activity.js';
import { useTuiControllers } from './hooks/use-tui-controllers.js';
import { useTuiEnvironmentState } from './hooks/use-tui-environment-state.js';
import { useTuiEventBridge } from './hooks/use-tui-event-bridge.js';
import { useTuiSlashCommands } from './hooks/use-tui-slash-commands.js';
import { useWorkingDirChip } from './hooks/use-working-dir-chip.js';
import { useApp, useStdout } from './ink.js';
import { createRunBlocksController } from './run-blocks-controller.js';
import { createSubmitController } from './submit-controller.js';
import { getActiveThemeName, setActiveTheme, THEME_OPTIONS, type ThemeName } from './theme.js';

export {
  type Action,
  type FleetEntry,
  type QueueItem,
  type ResumeSessionEntry,
  reducer,
  type Settings,
  type SlashCommandMatch,
  type State,
} from './app-reducer.js';
// Re-exported so existing imports from '../src/app.js' keep working. The
// composer key controller consumes the implementation directly from
// input-key-router.ts.
export { nextInputWordStart, previousInputWordStart } from './input-editing.js';
export { renderRunningTools } from './running-tools.js';
export { selectedSlashCommandLine } from './slash-command-search.js';

import { createAppKeyHandler } from './app-key-handler.js';
// The host<->TUI props contract lives in app-props.ts (app.tsx is line-capped
// by the hotspot guardrail). Re-exported here so consumers importing AppProps
// from '@wrongstack/tui' / '../src/app.js' keep working.
import type { AppProps } from './app-props.js';

// `buildGoalPreamble` was relocated to @wrongstack/core so headless and
// WebUI callers (which depend on @wrongstack/cli but not @wrongstack/tui)
// can issue `/goal set` without dragging the TUI package in. Re-exported
// from this module for backward compatibility with consumers still
// importing from @wrongstack/tui; also used locally within this file
// where `/goal …` is wired into the chat-input handler.
export { buildGoalPreamble } from '@wrongstack/core/execution';
export type { AppProps } from './app-props.js';
// Re-exported for backward compatibility with tests importing from '../src/app.js'.
// Actual implementation lives in ./steering-preamble.ts.
export { buildSteeringPreamble } from './steering-preamble.js';

export function App(props: AppProps): React.ReactElement {
  const {
    agent,
    slashRegistry,
    secretInputController,
    attachments,
    events,
    tokenCounter,
    visionAdapters = [],
    supportsVision,
    model,
    banner = true,
    queueStore,
    onQueueChange,
    yolo = false,
    chime = false,
    confirmExit = true,
    titleController,
    mouse = false,
    capability,
    enhanceEnabled = true,
    enhanceController,
    midRunSendPicker = true,
    enhanceDelayMs = 15_000,
    getEnhancerReasoning,
    buildEnhancerProvider,
    getEnhanceFallbackRef,
    getConfiguredRefinerRef,
    getYolo,
    getAutonomy,
    getEternalEngine,
    getParallelEngine,
    getSddRun,
    onSddLifecycle,
    subscribeEternalIteration,
    subscribeEternalStage,
    subscribeGoal,
    getSDDContext,
    onSDDOutput,
    appVersion,
    provider,
    family,
    keyTail,
    profile,
    profileConfigPath,
    autonomyAgents,
    toolCount,
    getPickableProviders,
    switchProviderAndModel,
    getSettings,
    saveSettings,
    getPluginItems,
    onPluginToggle,
    getMcpServers,
    onMcpToggle,
    onMcpRestart,
    getToolsItems,
    onToolToggle,
    getBrainData,
    onBrainRiskLevel,
    brainPanelHost,
    getShadowData,
    onShadowStart,
    onShadowStop,
    authHost,
    predictNext,
    onSuggestionsParsed,
    getSuggestions,
    getAutoSuggestions,
    autonomyNextPrompt,
    setSuggestions,
    switchAutonomy,
    effectiveMaxContext,
    onExit,
    director,
    getDirector,
    onClearHistory,
    clearTerminal,
    listSessions,
    fleetStreamController,
    interruptController,
    statuslineHiddenItems,
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    agentsMonitorController,
    initialGoal,
    initialAsk,
    sessionsDir,
    modeLabel,
    getModeLabel,
    getModes,
    registerDebugStreamCallback,
    restoreDebugStreamCallback,
    restoredMessages,
    restoredToolCalls,
    restoredEvents,
    getProjectPickerItems,
    getLiveSessions,
    initialAgentsMonitorOpen,
    onPanelOpen,
    subscribeCoordinatorEvents,
    onCoordinatorTasks: _onCoordinatorTasks,
    onCoordinatorClaim: _onCoordinatorClaim,
    coordinatorRunning = false,
    clientId,
    memoryStore,
    configStore,
  } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  // Subscribe to theme changes so this App tree re-renders whenever
  // `setActiveTheme()` mutates the global palette. Children read `theme`
  // directly via destructuring, so a single root re-render propagates the
  // new palette into the whole subtree (matches the autonomyPicker /
  // modePicker pattern that drives every other live state surface).
  useActiveTheme();
  // Boot-time: apply `config.themePreset` once on mount, then keep the
  // live palette in sync with config writes (REPL `/theme <preset>`,
  // future settings UI, hot-reload). Both empty and undefined store
  // values are no-ops, so legacy configs without `themePreset` keep the
  // catppuccin default.
  useThemeState({ configStore });
  const environment = useTuiEnvironmentState({
    events,
    memoryStore,
    model,
    provider,
    effectiveMaxContext,
    yolo,
    getAutonomy,
    modeLabel,
    statuslineHiddenItems,
    toolCount,
    getSettings,
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
  });
  const {
    liveModel,
    setLiveModel,
    liveProvider,
    setLiveProvider,
    activeMaxContext,
    setActiveMaxContext,
    yoloLive,
    setYoloLive,
    autonomyLive,
    setAutonomyLive,
    liveModeLabel,
    setLiveModeLabel,
    hiddenItems,
    setHiddenItems,
    setSessionCount,
    hiddenItemsRef,
    setMemoryContextMonitor,
    memoryContextMonitorRef,
    memoryRecordTotalRef,
    setLiveToolCount,
  } = environment;

  const projectRoot = agent.ctx.projectRoot;
  const liveTodos = useLiveTodos(agent.ctx);
  const { state, dispatch, layoutStore } = useAppSessionState({
    agent,
    banner,
    appVersion,
    provider,
    model,
    family,
    keyTail,
    profile,
    profileConfigPath,
    autonomyAgents,
    restoredMessages,
    restoredToolCalls,
    restoredEvents,
    enhanceEnabled,
    initialAgentsMonitorOpen,
    initialFleetChat: fleetStreamController?.mode,
    sessionsDir,
  });
  const historyScrollRef = useRef<HistoryScrollController | null>(null);
  const onScrollInfo = useCallback(
    (info: { scrolled: boolean }) =>
      dispatch({ type: 'setHistoryScrolled', scrolled: info.scrolled }),
    [dispatch],
  );
  const onRequestOlderEntries = useCallback(() => {
    // Toggle loading state and load from archive. Currently loads nothing
    // since the HistoryArchive is not yet wired from the run-tui startup.
    // Future: create archive, call archive.loadRange(), dispatch results.
    dispatch({ type: 'startArchiveLoad' });
    // Fire-and-forget: the actual archive load will be wired when the
    // HistoryArchive is created in app startup.
    setTimeout(() => dispatch({ type: 'archiveLoaded', entries: [] }), 0);
  }, [dispatch]);
  const onHistoryCopy = useHistoryCopyNotice(dispatch);
  const { focusedBoardId, setFocusedBoardId, boardFocusRef } = useKanbanBoardFocus();

  useInputHistoryPersistence({
    projectRoot,
    inputHistory: state.inputHistory,
    dispatch,
  });

  const { openPromptPicker } = usePromptPicker({ projectRoot, dispatch });

  const { openModePicker } = useModePicker({ dispatch, getModes });

  // ── Brain panel + shared /model overlay in generic 'pick' mode ─
  const { requestModelPick, handleModelPicked } = useModelPickRequest({
    dispatch,
    getPickableProviders,
    pickerOpen: state.modelPicker.open,
  });
  const brainCtl = useBrainPanel({ dispatch, getBrainData, brainPanelHost, requestModelPick });
  const openBrainPanel = brainCtl.openBrainPanel;
  const { changeBrainRisk } = useBrainRiskSync({
    dispatch,
    riskLevel: state.brainPanel.riskLevel,
    brainPanelOpen: state.brainPanel.open,
    onBrainRiskLevel,
  });

  // ── Shadow Agent panel ─────────────────────────────────────────
  const { openShadowPanel, handleShadowStart, handleShadowStop } = useShadowPanel(dispatch, {
    getShadowData,
    onShadowStart,
    onShadowStop,
  });

  // ── Help panel ──────────────────────────────────────────────────
  const { openHelpPanel } = useHelpPanel(dispatch, slashRegistry);

  useStatuslineHiddenSync({
    pickerOpen: state.statuslinePicker.open,
    pickerHidden: state.statuslinePicker.hiddenItems,
    hiddenItems,
    setHiddenItems: (items) => setHiddenItems(items as typeof hiddenItems),
  });

  useStreamChipExpiration({
    brainPrompt: state.brainPrompt,
    enhance: state.enhance,
    visibleChips: state.statuslinePicker.visibleChips,
    dispatch,
  });

  useAutonomousCoordinator(subscribeCoordinatorEvents, dispatch);

  const {
    promptUsageRef,
    builderRef,
    activeCtrlRef,
    eternalLoopRunningRef,
    parallelLoopRunningRef,
    activeRunSettledRef,
    exitRequestedRef,
    inputGateRef,
    lastEnterAtRef,
    tokenPreviewsRef,
    streamingTextRef,
    streamSegmentsRef,
    pendingDeltaRef,
    flushTimerRef,
    sessionGenerationRef,
    activeRunGenerationRef,
    assistantCommittedThisRunRef,
    stateRef,
    draftRef,
    runBlocksRef,
    lastEscAtRef,
    dismissedEscAtRef,
    submitRef,
  } = useAppRuntimeRefs(attachments, state);
  const projectName = React.useMemo(() => {
    const base = path.basename(projectRoot);
    return base && base !== path.sep ? base : undefined;
  }, [projectRoot]);

  const workingDirChip = useWorkingDirChip(agent.ctx, projectRoot);

  const {
    liveSettings,
    liveStatuslineMode,
    liveAnimationStyle,
    liveThinkingWord,
    chimeRef,
    confirmExitRef,
  } = useLiveSettingsState({ getSettings, titleController, chime, confirmExit });

  const mailbox = useMailboxViewModel(events);
  const { setMailboxPanelOpen } = mailbox;

  // Single-authority sidebar layout: the same wrapper the renderer
  // (`app-view.tsx`) calls, so the dispatcher and the renderer can never
  // drift on panel routing again. Notably this means the dispatcher now
  // sees the settings picker's draft panelPositions while the picker is
  // open, matching what the renderer mounts.
  const sidebarLayout = resolveAppSidebarLayout(
    state,
    stdout?.columns ?? 80,
    liveSettings,
    mailbox.mailboxPanelOpen,
  );

  // Push live model changes to the terminal title controller so the
  // window/tab title reflects the active model after /model or /setmodel.
  useEffect(() => {
    titleController?.setModel(liveModel);
  }, [titleController, liveModel]);

  const activity = useTuiActivity({
    status: state.status,
    fleet: state.fleet,
    enhanceBusy: state.enhanceBusy,
    thinkingWord: liveThinkingWord,
    projectRoot,
    stateRef,
    agentContext: agent.ctx,
    dispatch,
    attachments,
    builderRef,
  });
  const { displayThinkingWord, refreshGoalSummary } = activity;

  const liveDirector = useCallback(
    (): Director | null => getDirector?.() ?? director,
    [getDirector, director],
  );

  const clearPendingConfirms = useCallback(() => {
    const queue = stateRef.current.confirmQueue;
    if (queue.length === 0) return;
    for (const c of queue) {
      try {
        c.resolve('no');
      } catch {
        /* already settled */
      }
    }
    dispatch({ type: 'confirmClearAll' });
  }, [dispatch]);

  // Interactive /auth panel controller — owns provider/key mutations, the
  // flow runner (catalog/custom/local adds, OAuth sign-in) and its modal
  // prompt plumbing. All side effects go through the CLI-provided authHost.
  const authPanelController = useAuthPanel({
    authHost,
    stateRef,
    dispatch,
    open: state.authPanel.open,
  });

  useEffect(() => {
    if (!secretInputController) return;
    const previousSecret = secretInputController.readSecret;
    const previousText = secretInputController.readText;
    secretInputController.readSecret = authPanelController.readSecret;
    secretInputController.readText = authPanelController.readText;
    return () => {
      secretInputController.readSecret = previousSecret;
      if (previousText) secretInputController.readText = previousText;
      else delete secretInputController.readText;
    };
  }, [secretInputController, authPanelController.readSecret, authPanelController.readText]);

  const statuslineHiddenForPicker = useCallback((): StatuslineItem[] => {
    return mergeStatuslineHiddenItems(
      hiddenItemsRef.current,
      stateRef.current.statuslinePicker.hiddenItems,
    );
  }, []);

  const openStatuslinePicker = useCallback(
    (field?: number) => {
      if (field !== undefined) {
        dispatch({ type: 'statuslineFieldSet', field });
      }
      dispatch({ type: 'statuslineOpen', hiddenItems: statuslineHiddenForPicker() });
    },
    [statuslineHiddenForPicker],
  );

  // Live mirror of the full-session pointer opt-in. The managed history always
  // owns wheel input because virtualized rows do not exist in native terminal
  // scrollback. Track clicks work in managed mode; full mode additionally
  // enables pointer drag and clickable app chrome. Use the same routing-aware
  // overlay decision as AppView so sidebar-routed panels keep mouse hit-testing
  // aligned with the visible main-column width.
  const { mouseMode, setMouseMode } = useMouseTracking({
    initialMouseMode: mouse,
    overlayOpen: sidebarLayout.overlayOpen,
    protocol: capability?.mouseProtocol,
    stdout,
  });

  const { bottomRegionRef, statusBarWrapRef, belowStatusBarRef, termRows } = useHistoryViewportSync(
    {
      stdoutRows: stdout?.rows,
      viewportRows: state.viewportRows,
      setViewportRows: (rows) => dispatch({ type: 'setViewportRows', rows }),
    },
  );
  // Chip click map: written by StatusBar on every render, read by the mouse
  // hit-test in app-key-handler. See StatusBarClickMap.
  const statusBarClickMapRef = React.useRef<StatusBarClickMap | null>(null);
  // handleRewindTo must be declared before the /rewind useEffect (line 1803)
  // so the closure can capture it. It is intentionally NOT in useCallback
  // — each call needs a fresh rewinder referencing the current sessionsDir.
  const handleRewindTo = React.useCallback(
    async (checkpointIndex: number) => {
      const sessionId = agent.ctx.session.id;
      if (!sessionId) return;

      // Invalidate late output before stopping every producer that can mutate
      // the session: the foreground leader, autonomy/SDD drivers, and fleet.
      sessionGenerationRef.current++;
      interruptController?.abortLeader();

      const cleanup: Promise<unknown>[] = [];
      if (interruptController?.waitForIdle) {
        cleanup.push(interruptController.waitForIdle().catch(() => undefined));
      }
      const rewindDir = liveDirector();
      if (rewindDir) cleanup.push(rewindDir.terminateAll().catch(() => undefined));

      if (cleanup.length > 0) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const cap = new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 1500);
          timeout.unref?.();
        });
        try {
          await Promise.race([Promise.allSettled(cleanup).then(() => undefined), cap]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }

      const rewinder = new DefaultSessionRewinder(
        sessionsDir ?? '',
        agent.ctx.projectRoot ?? agent.ctx.cwd,
      );
      // Revert file system changes first (read-only, safe to do eagerly).
      const reverted = await rewinder.rewindToCheckpoint(sessionId, checkpointIndex);
      // Then cut BOTH the JSONL and the live conversation back to the
      // checkpoint. Truncating the log alone would leave the model answering
      // the next prompt against the rewound turns it still holds in memory.
      // This fires session.rewound on the EventBus, which the useEffect at
      // line 2212 listens to and dispatches sessionRewound + clearHistory.
      await applyRewindToConversation({
        session: agent.ctx.session,
        state: agent.ctx.state,
        sessionsDir: sessionsDir ?? '',
        promptIndex: checkpointIndex,
        revertedFiles: reverted.revertedFiles,
      });
    },
    [
      agent.ctx.session,
      sessionsDir,
      agent.ctx.projectRoot,
      agent.ctx.cwd,
      interruptController,
      liveDirector,
      sessionGenerationRef,
    ],
  );

  const setDraft = (buffer: string, cursor: number): void => {
    draftRef.current = { buffer, cursor };
    dispatch({ type: 'setBuffer', buffer, cursor });
  };

  const clearDraft = (): void => {
    draftRef.current = { buffer: '', cursor: 0 };
    dispatch({ type: 'clearInput' });
  };

  // ── Consolidated 2s tick: autonomy/yolo/mode/model/provider sync ──
  const staleGuardRef = useRef(JSON.stringify({ a: '', y: false, m: '', model: '', provider: '' }));
  useEffect(() => {
    const poll = () => {
      // ── Status-bar live sync (autonomy, yolo, mode, model, provider) ──
      const a = getAutonomy?.() ?? 'off';
      const y = getYolo?.() ?? false;
      const m = getModeLabel?.() ?? '';
      const curModel = agent.ctx.model;
      const curProvider = (agent.ctx.provider as { id?: string | undefined } | undefined)?.id ?? '';
      const snap = JSON.stringify({ a, y, m, model: curModel, provider: curProvider });
      if (snap !== staleGuardRef.current) {
        staleGuardRef.current = snap;
        if (a !== autonomyLive) setAutonomyLive(a);
        if (y !== yoloLive) setYoloLive(y);
        if (m !== liveModeLabel) setLiveModeLabel(m);
        if (curModel !== liveModel) setLiveModel(curModel);
        if (curProvider !== liveProvider) setLiveProvider(curProvider);
        if (a === 'eternal' && getEternalEngine) void runEternalLoopRef.current();
        if (a === 'eternal-parallel' && getParallelEngine) void runParallelLoopRef.current();
      }
    };
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [
    getAutonomy,
    getYolo,
    getModeLabel,
    getEternalEngine,
    getParallelEngine,
    autonomyLive,
    yoloLive,
    liveModeLabel,
    liveModel,
    liveProvider,
    agent.ctx.model,
    agent.ctx.provider,
  ]);

  const gitInfo = useGitSessionStatus({ agent, getLiveSessions, setSessionCount, hiddenItems });

  const statusbar = useStatusbarViewModel({
    agent,
    tokenCounter,
    activeMaxContext,
    effectiveMaxContext,
    liveProvider,
    liveModel,
    liveTodos,
    sidebarVisible: sidebarLayout.sidebarWidth > 0,
    hiddenItems,
    state,
  });
  const { fleetCounts } = statusbar;

  const acceptSlashPickerSelection = useSlashPicker({
    state,
    slashRegistry,
    dispatch,
    setDraft,
  });

  const { getCronJobs, runSteerSequence } = useCoreTuiCommands({
    agent,
    slashRegistry,
    memoryStore,
    onPanelOpen,
    memoryContextMonitorRef,
    memoryRecordTotalRef,
    stateRef,
    boardFocusRef,
    setFocusedBoardId,
    terminalWidth: stdout.columns ?? 80,
    getModeLabel,
    activeCtrlRef,
    clearPendingConfirms,
    dispatch,
    liveDirector,
    streamingTextRef,
    director,
    handleRewindTo,
  });

  // `/goal` is registered as a CLI builtin (packages/cli/src/slash-commands/
  // goal.ts) which handles both the preamble lock-in (the former TUI
  // behavior) and goal.json persistence for /autonomy eternal. The TUI
  // does NOT register its own /goal here — that would collide with the
  // builtin and throw "already registered" on mount.

  const panelControllers = usePanelControllers({
    state,
    stateRef,
    dispatch,
    getPickableProviders,
    getProjectPickerItems,
    getLiveSessions,
    onPanelOpen,
    openStatuslinePicker,
    openAuthPanel: authPanelController.openAuthPanel,
    openModePicker,
    openBrainPanel,
    openShadowPanel,
    openHelpPanel,
    getSettings,
    getPluginItems,
    onPluginToggle,
    getMcpServers,
    onMcpToggle,
    onMcpRestart,
    getToolsItems,
    onToolToggle,
    setLiveToolCount,
  });
  const { openModelPicker, openProjectPicker, openFKeyPicker, loadLiveSessions, openSettings } =
    panelControllers;

  // NOTE: there is deliberately NO local "auto-proceed countdown" timer here.
  // The StatusBar's "⏳ auto in Ns" chip is driven exclusively by real
  // `countdown.tick` events (state.countdown) emitted while an actual
  // auto-proceed cooldown runs. A previous display-only local timer started
  // the moment autonomy flipped to 'auto' — with no suggestions and nothing
  // pending it showed a phantom 45s countdown on an idle, empty session,
  // then silently vanished. The real TUI-side countdown (with execution) is
  // the next-steps auto-submit below.

  const {
    nextStepsAutoSubmitCountdown,
    nextStepsAutoSubmitLabel,
    setNextStepsAutoSubmitCountdown,
    setNextStepsAutoSubmitLabel,
    nextStepsAutoSubmitSuggestionRef,
    nextStepsAutoSubmitTimerRef,
    autoSubmitStreakRef,
    autoSubmitCapWarnedRef,
    autoSubmitLoopGuardRef,
    cancelNextStepsCountdown,
  } = useNextStepsAutoSubmit({
    state,
    autonomyLive,
    agent,
    getAutonomy,
    getSettings,
    getSuggestions,
    getAutoSuggestions,
    getYolo,
    setSuggestions,
    autonomyNextPrompt,
    dispatch,
    clearDraft,
    runBlocksRef,
  });

  useSettingsAutoSave(state, saveSettings, dispatch);

  useTuiSlashCommands({
    slashRegistry,
    getPickableProviders,
    switchProviderAndModel,
    openModelPicker,
    openFKeyPicker,
    projectRoot,
    agent,
    dispatch,
    getSettings,
    saveSettings,
    openSettings,
    state,
    openStatuslinePicker,
    setHiddenItems,
    hiddenItemsRef,
    setMailboxPanelOpen,
    switchAutonomy,
    listSessions,
  });

  useProviderEventBridge({
    events,
    agent,
    dispatch,
    streamingTextRef,
    streamSegmentsRef,
    pendingDeltaRef,
    flushTimerRef,
    sessionGenerationRef,
    activeRunGenerationRef,
    assistantCommittedThisRunRef,
    setMemoryContextMonitor,
  });

  useClientTelemetry({
    events,
    clientId,
    tokenCounter,
    getAutonomy,
    agent,
    registerDebugStreamCallback,
    restoreDebugStreamCallback,
    dispatch,
  });

  const {
    enhanceEnabledRef,
    midRunSendPickerRef,
    enhanceAbortRef,
    enhanceCancelledRef,
    enhanceOriginalRef,
    enhanceCountdown,
    setEnhanceCountdown,
    enhanceStartedAt,
    setEnhanceStartedAt,
    enhanceDurationMs,
    setEnhanceDurationMs,
    refineProviderId,
    setRefineProviderId,
    refineModel,
    setRefineModel,
  } = useEnhanceRuntimeState({
    enhanceEnabled: state.enhanceEnabled,
    midRunSendPicker,
  });

  // ── Paste handling ──────────────────────────────────────────────────
  const {
    pasteAccumRef,
    pasteFlushTimerRef,
    commitPaste,
    pasteClipboardImage,
    pasteClipboardText,
  } = usePasteHandling({
    builderRef,
    dispatch,
    draftRef,
    setDraft,
    tokenPreviewsRef,
  });

  // ── Queue lifecycle ─────────────────────────────────────────────────
  useQueueManager({
    queueStore,
    onQueueChange,
    slashRegistry,
    stateRef,
    dispatch,
    getSettings,
    saveSettings,
    midRunSendPickerRef,
  });

  const getActiveSessionId = useCallback(() => agent.ctx.session.id, [agent]);

  // LEADER's own history for the F3 per-agent transcript view: the main
  // chat entries WITHOUT subagent lines. Read through stateRef at call
  // time (the monitor polls on its 1s tick) so this callback stays stable.
  const getLeaderTranscript = useCallback(
    () => leaderTimelineFromEntries(stateRef.current.entries),
    [stateRef],
  );

  useTuiEventBridge({
    events,
    dispatch,
    stateRef,
    setActiveMaxContext,
    getSessionId: getActiveSessionId,
    subscribeGoal,
    onClearHistory,
    sessionGenerationRef,
  });

  useTuiControllers({
    dispatch,
    fleetChat: state.fleetChat,
    enhanceEnabled: state.enhanceEnabled,
    agentsMonitorOpen: state.agentsMonitorOpen,
    fleetStreamController,
    enhanceController,
    agentsMonitorController,
  });

  useSessionInterruptController({
    interruptController,
    dispatch,
    stateRef,
    activeCtrlRef,
    activeRunSettledRef,
    sessionGenerationRef,
    streamingTextRef,
    streamSegmentsRef,
    pendingDeltaRef,
    assistantCommittedThisRunRef,
    flushTimerRef,
    eternalLoopRunningRef,
    parallelLoopRunningRef,
    tokenPreviewsRef,
    clearPendingConfirms,
    getEternalEngine,
    getParallelEngine,
    getSddRun,
    switchAutonomy,
  });

  // `/exit` confirmation bridge. Mirrors the `/clear` invariant: while a
  // leader run or any subagent is still active, `/exit` must not
  // terminate the TUI silently. The hook registers the slash command,
  // opens an `exitConfirm` panel when needed, then uses the shared interrupt
  // lifecycle to abort the leader/background drivers and await leader-idle plus
  // fleet teardown (capped at 1500 ms) before Ink is allowed to unmount.
  useExitCommand({
    slashRegistry,
    dispatch,
    exitConfirm: state.exitConfirm,
    stateRef,
    sessionGenerationRef,
    interruptController,
    getDirector: liveDirector,
  });

  useDirectorFleetBridge({
    director,
    dispatch,
    stateRef,
    chatMode: state.fleetChat,
    sessionGenerationRef,
  });

  // ── File search (@-token detection + picker selection) ───────────
  const { onPickerEnter } = useFileSearch({
    state,
    dispatch,
    projectRoot,
    builderRef,
    draftRef,
    setDraft,
    tokenPreviewsRef,
  });

  // Enter-handler for the /theme picker: apply the highlighted preset,
  // persist to configStore, then close the picker. The persistence write
  // is best-effort — if ConfigStore.update throws (e.g. transient disk
  // failure) the picker still closes and the visual palette reflects the
  // user's pick; the next session will fall back to whatever's on disk.
  const onThemePickerEnter = useCallback(() => {
    const preset = THEME_OPTIONS[Math.max(0, state.themePicker.selected)];
    const presetName: ThemeName | undefined = preset?.id;
    if (!presetName) return;
    setActiveTheme(presetName);
    try {
      configStore?.update({ themePreset: presetName });
      void props.saveThemePreset?.(presetName).catch((err) => {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'warn',
            text: `Theme applied in-memory but could not persist to disk: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      });
    } catch {
      /* best-effort — see comment above */
    }
    dispatch({
      type: 'addEntry',
      entry: {
        kind: 'info',
        text: `Theme preset switched to "${presetName}"${
          getActiveThemeName() === presetName ? '' : ` (fallback applied: ${getActiveThemeName()})`
        }.`,
      },
    });
    dispatch({ type: 'themePickerClose' });
  }, [configStore, dispatch, state.themePicker.selected]);

  const tryPickerKey = useAppPickerKeys({
    host: props,
    state,
    dispatch,
    environment,
    statusbar,
    panelControllers,
    authPanelController,
    brainController: brainCtl,
    lastEnterAtRef,
    inputGateRef,
    submitRef,
    promptUsageRef,
    setDraft,
    acceptSlashPickerSelection,
    changeBrainRisk,
    handleModelPicked,
    handleShadowStart,
    handleShadowStop,
    statuslineHiddenForPicker,
    onPickerEnter,
    onThemePickerEnter,
  });
  const { interruptsSyncRef, runInterruptLadder } = useInterruptLadder({
    stateRef,
    exitRequestedRef,
    agent,
    liveDirector,
    onExit,
    exit,
    dispatch,
    activeCtrlRef,
    clearPendingConfirms,
    getEternalEngine,
    getParallelEngine,
    eternalLoopRunningRef,
    parallelLoopRunningRef,
    switchAutonomy,
    getSddRun,
    confirmExitRef,
  });

  const handleKey = createAppKeyHandler({
    state,
    dispatch,
    historyScrollRef,
    runInterruptLadder,
    enhanceCancelledRef,
    enhanceAbortRef,
    inputGateRef,
    lastEscAtRef,
    pasteAccumRef,
    pasteFlushTimerRef,
    commitPaste,
    tryPickerKey,
    dismissedEscAtRef,
    streamingTextRef,
    confirmExitRef,
    activeCtrlRef,
    clearPendingConfirms,
    liveDirector,
    openProjectPicker,
    loadLiveSessions,
    openStatuslinePicker,
    statuslineHiddenItems,
    getSddRun,
    onSddLifecycle,
    getSettings,
    saveSettings,
    lastEnterAtRef,
    draftRef,
    setDraft,
    submit: () => submitRef.current(),
    mouseMode,
    termRows,
    terminalColumns: stdout?.columns ?? 80,
    terminalRows: stdout?.rows ?? 24,
    mainColumnWidth: sidebarLayout.mainColumnWidth,
    // The authoritative value — the same one `useMouseTracking` already gets.
    overlayOpen: sidebarLayout.overlayOpen,
    effectiveSwarmOnSidebar: sidebarLayout.effectiveSwarmOnSidebar,
    sidebarTwinRowCount: sidebarLayout.sidebarTwinRowCount,
    statusBarWrapRef,
    belowStatusBarRef,
    statusBarClickMapRef,
    openModelPicker,
    nextStepsAutoSubmitTimerRef,
    nextStepsAutoSubmitSuggestionRef,
    nextStepsAutoSubmitLabel,
    setNextStepsAutoSubmitCountdown,
    setNextStepsAutoSubmitLabel,
    cancelNextStepsCountdown,
    pasteClipboardText,
    pasteClipboardImage,
    slashRegistry,
    agent,
    onHistoryCopy,
  });

  /**
   * Drive a single iteration: run the agent against `blocks`, render the
   * result into history, then if any messages were typed while we were
   * busy, pull the head of the queue and recurse. Recursion terminates
   * when the queue is empty (status stays idle).
   */
  const runBlocks = createRunBlocksController({
    capabilities: {
      agent,
      tokenCounter,
      supportsVision,
      visionAdapters,
      onSDDOutput,
      onSuggestionsParsed,
      predictNext,
    },
    refs: {
      sessionGeneration: sessionGenerationRef,
      activeRunGeneration: activeRunGenerationRef,
      activeRunSettled: activeRunSettledRef,
      activeController: activeCtrlRef,
      interrupts: interruptsSyncRef,
      assistantCommitted: assistantCommittedThisRunRef,
      streamingText: streamingTextRef,
      streamSegments: streamSegmentsRef,
      pendingDelta: pendingDeltaRef,
      flushTimer: flushTimerRef,
      chime: chimeRef,
      state: stateRef,
    },
    dispatch,
  });
  runBlocksRef.current = runBlocks;

  const { runEternalLoopRef, runParallelLoopRef } = useAutonomyDrivers({
    getEternalEngine,
    getParallelEngine,
    getAutonomy,
    switchAutonomy,
    subscribeEternalIteration,
    subscribeEternalStage,
    refreshGoalSummary,
    autonomyLive,
    setAutonomyLive,
    dispatch,
    eternalLoopRunningRef,
    parallelLoopRunningRef,
  });

  const submit = createSubmitController({
    capabilities: {
      agent,
      slashRegistry,
      tokenCounter,
      getSettings,
      saveSettings,
      getYolo,
      getAutonomy,
      getEternalEngine,
      getParallelEngine,
      getModeLabel,
      getToolsItems,
      onExit,
      clearTerminal,
      onClearHistory,
      getSuggestions,
      getSDDContext,
      switchAutonomy,
      memoryStore,
      getEnhancerReasoning,
      buildEnhancerProvider,
      getEnhanceFallbackRef,
      getConfiguredRefinerRef,
      getPickableProviders,
    },
    state,
    live: {
      mouseMode,
      model: liveModel,
      provider: liveProvider,
      maxContext: activeMaxContext,
      yolo: yoloLive,
      autonomy: autonomyLive,
      modeLabel: liveModeLabel,
      setMouseMode,
      setModel: setLiveModel,
      setProvider: setLiveProvider,
      setMaxContext: setActiveMaxContext,
      setYolo: setYoloLive,
      setAutonomy: setAutonomyLive,
      setModeLabel: setLiveModeLabel,
      setToolCount: setLiveToolCount,
    },
    refs: {
      state: stateRef,
      interrupts: interruptsSyncRef,
      autoSubmitStreak: autoSubmitStreakRef,
      autoSubmitCapWarned: autoSubmitCapWarnedRef,
      autoSubmitLoopGuard: autoSubmitLoopGuardRef,
      tokenPreviews: tokenPreviewsRef,
      attachments,
      builder: builderRef,
      sessionGeneration: sessionGenerationRef,
      eternalLoop: runEternalLoopRef,
      parallelLoop: runParallelLoopRef,
      enhanceEnabled: enhanceEnabledRef,
      enhanceOriginal: enhanceOriginalRef,
      enhanceAbort: enhanceAbortRef,
      enhanceCancelled: enhanceCancelledRef,
      nextStepsTimer: nextStepsAutoSubmitTimerRef,
      midRunSendPicker: midRunSendPickerRef,
      historyScroll: historyScrollRef,
    },
    actions: {
      dispatch,
      clearDraft,
      setDraft,
      pasteClipboardImage,
      openPromptPicker,
      refreshGoalSummary,
      exit,
      runBlocks,
      liveDirector,
      setMemoryContextMonitor,
      runSteerSequence,
      setEnhanceStartedAt,
      setEnhanceDuration: setEnhanceDurationMs,
      setRefineProvider: setRefineProviderId,
      setRefineModel,
      onAfterClear: () => {
        // Clear paste accumulator and its flush timer.
        pasteAccumRef.current = null;
        if (pasteFlushTimerRef.current) {
          clearTimeout(pasteFlushTimerRef.current);
          pasteFlushTimerRef.current = null;
        }
        // Clear next-steps auto-submit suggestion so a stale prompt
        // from the old conversation can't fire.
        nextStepsAutoSubmitSuggestionRef.current = null;
        cancelNextStepsCountdown();
        // RAM retention fix: drop canonical attachment payloads AND
        // builder refs so `/clear` releases the cumulative paste/file/
        // image graphs. Without these two calls, `DefaultAttachmentStore`
        // and `InputBuilder.refs` keep every attachment of the old
        // conversation reachable for the lifetime of the process.
        // `attachments.clear()` is a no-op on test doubles and on stores
        // that already empty; safe to call unconditionally.
        if (attachments) {
          void attachments.clear()?.catch?.(() => undefined);
        }
        if (builderRef.current) {
          builderRef.current.reset();
        }
      },
    },
  });
  submitRef.current = submit;

  useInitialPrompt({ initialGoal, initialAsk, builderRef, runBlocksRef, dispatch });

  const stableOnKey = useStableKeyHandler(handleKey);

  const viewState = deriveAppViewState({
    state,
    terminalColumns: stdout?.columns ?? 80,
    displayThinkingWord,
    fleetRunning: fleetCounts?.running ?? 0,
    liveAnimationStyle,
    panelPositions: effectivePanelPositions(state, liveSettings),
  });
  return (
    <AppView
      host={props}
      runtime={{
        state,
        dispatch,
        historyScrollRef,
        onScrollInfo,
        onRequestOlderEntries,
        activity,
        environment,
        statusbar,
        mailbox,
        gitInfo,
        viewState,
        mouseMode,
        termRows,
        bottomRegionRef,
        statusBarWrapRef,
        belowStatusBarRef,
        statusBarClickMapRef,
        stableOnKey,
        liveTodos,
        liveSettings,
        liveAnimationStyle,
        liveStatuslineMode,
        projectName,
        workingDirChip,
        handleRewindTo,
        activeCtrlRef,
        clearPendingConfirms,
        liveDirector,
        dismissedEscAtRef,
        enhanceOriginalRef,
        enhanceStartedAt,
        enhanceDurationMs,
        refineProviderId,
        refineModel,
        setEnhanceCountdown,
        enhanceCountdown,
        nextStepsAutoSubmitCountdown,
        nextStepsAutoSubmitLabel,
        setDraft,
        focusedBoardId,
        getCronJobs,
        getLeaderTranscript,
        coordinatorRunning,
        enhanceDelayMs,
        layoutStore,
      }}
    />
  );
}
