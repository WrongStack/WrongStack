import * as path from 'node:path';
import type { Director } from '@wrongstack/core/coordination';
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
import { useAppExecutionPipeline } from './hooks/use-app-execution-pipeline.js';
import { useAppPickerKeys } from './hooks/use-app-picker-keys.js';
import { buildAppPipelineArgs } from './hooks/use-app-pipeline-builders.js';
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
import { useHistoryArchive } from './hooks/use-history-archive.js';
import { useHistoryCopyNotice } from './hooks/use-history-copy-notice.js';
import { useHistoryViewportSync } from './hooks/use-history-viewport-sync.js';
import { useInitialPrompt } from './hooks/use-initial-prompt.js';
import { useInputHistoryPersistence } from './hooks/use-input-history-persistence.js';
import { useInterruptLadder } from './hooks/use-interrupt-ladder.js';
import { useKanbanBoardFocus } from './hooks/use-kanban-board-focus.js';
import { useLiveSettingsState } from './hooks/use-live-settings-state.js';
import { useLiveTodos } from './hooks/use-live-todos.js';
import { todosForScreen } from './resume-load.js';
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
import { useSessionRewind } from './hooks/use-session-rewind.js';
import { useSettingsAutoSave } from './hooks/use-settings-auto-save.js';
import { useShadowPanel } from './hooks/use-shadow-panel.js';
import { useSlashPicker } from './hooks/use-slash-picker.js';
import { useStatusSyncInterval } from './hooks/use-status-sync-interval.js';
import { useStatusbarViewModel } from './hooks/use-statusbar-view-model.js';
import {
  useStatuslineHiddenSync,
  useStatuslineLayoutSync,
} from './hooks/use-statusline-hidden-sync.js';
import { useStreamChipExpiration } from './hooks/use-stream-chip-expiration.js';
import { useThemePickerHandler } from './hooks/use-theme-picker-handler.js';
import { useThemeState } from './hooks/use-theme-state.js';
import { useTokenCounterRefresh } from './hooks/use-token-counter-refresh.js';
import { useTuiActivity } from './hooks/use-tui-activity.js';
import { useTuiControllers } from './hooks/use-tui-controllers.js';
import { useTuiEnvironmentState } from './hooks/use-tui-environment-state.js';
import { useTuiEventBridge } from './hooks/use-tui-event-bridge.js';
import { useTuiSlashCommands } from './hooks/use-tui-slash-commands.js';
import { useWorkingDirChip } from './hooks/use-working-dir-chip.js';
import { useApp, useStdout } from './ink.js';

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
export { nextInputWordStart, previousInputWordStart } from './input-editing.js';
export { renderRunningTools } from './running-tools.js';
export { selectedSlashCommandLine } from './slash-command-search.js';
export { buildGoalPreamble } from '@wrongstack/core/execution';
export type { AppProps } from './app-props.js';
export { buildSteeringPreamble } from './steering-preamble.js';

import type { AppProps } from './app-props.js';

export function App(props: AppProps): React.ReactElement {
  const {
    agent,
    slashRegistry,
    secretInputController,
    attachments,
    events,
    tokenCounter,
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
    getAutonomy,
    getEternalEngine,
    getParallelEngine,
    getSddRun,
    subscribeGoal,
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
    listSessions,
    fleetStreamController,
    interruptController,
    statuslineHiddenItems,
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    statuslineLines,
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
    coordinatorRunning = false,
    clientId,
    memoryStore,
    configStore,
  } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();

  useActiveTheme();
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
    statuslineLines,
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
    lines,
    setLines,
    densities,
    setDensities,
    setSessionCount,
    hiddenItemsRef,
    setMemoryContextMonitor,
    memoryContextMonitorRef,
    memoryRecordTotalRef,
    setLiveToolCount,
  } = environment;

  // Latest layout, readable from the picker-open callback without making it
  // depend on (and re-create for) every layout keystroke.
  const linesRef = React.useRef(lines);
  linesRef.current = lines;
  const densitiesRef = React.useRef(densities);
  densitiesRef.current = densities;

  const projectRoot = agent.ctx.projectRoot;
  const sessionTodos = useLiveTodos(agent.ctx);
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
  // Blanked for the length of a `/resume` — see `todosForScreen`.
  const liveTodos = todosForScreen(sessionTodos, state.resumeLoad);
  const historyScrollRef = useRef<HistoryScrollController | null>(null);
  const onScrollInfo = useCallback(
    (info: { scrolled: boolean }) =>
      dispatch({ type: 'setHistoryScrolled', scrolled: info.scrolled }),
    [dispatch],
  );
  const { onRequestOlderEntries } = useHistoryArchive({
    entries: state.entries,
    dispatch,
    sessionsDir,
    sessionId: agent.ctx.session?.id,
  });
  const onHistoryCopy = useHistoryCopyNotice(dispatch);
  const { focusedBoardId, setFocusedBoardId, boardFocusRef } = useKanbanBoardFocus();

  useInputHistoryPersistence({
    projectRoot,
    inputHistory: state.inputHistory,
    dispatch,
  });

  const { openPromptPicker, setPromptFavorite } = usePromptPicker({ projectRoot, dispatch });
  const { openModePicker } = useModePicker({ dispatch, getModes });

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

  const { openShadowPanel, handleShadowStart, handleShadowStop } = useShadowPanel(dispatch, {
    getShadowData,
    onShadowStart,
    onShadowStop,
  });

  const { openHelpPanel } = useHelpPanel(dispatch, slashRegistry);

  useStatuslineHiddenSync({
    pickerOpen: state.statuslinePicker.open,
    pickerHidden: state.statuslinePicker.hiddenItems,
    hiddenItems,
    setHiddenItems: (items) => setHiddenItems(items as typeof hiddenItems),
  });

  useStatuslineLayoutSync({
    pickerOpen: state.statuslinePicker.open,
    layoutSeeded: state.statuslinePicker.layoutSeeded,
    pickerLines: state.statuslinePicker.lines,
    pickerDensities: state.statuslinePicker.densities,
    lines,
    densities,
    setLines,
    setDensities,
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

  const sidebarLayout = resolveAppSidebarLayout(
    state,
    stdout?.columns ?? 80,
    liveSettings,
    mailbox.mailboxPanelOpen,
  );

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
        // already settled
      }
    }
    dispatch({ type: 'confirmClearAll' });
  }, [dispatch, stateRef]);

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
  }, [hiddenItemsRef, stateRef]);

  const openStatuslinePicker = useCallback(
    (field?: number) => {
      if (field !== undefined) {
        dispatch({ type: 'statuslineFieldSet', field });
      }
      // Seed the editor from the live layout so the picker opens showing what
      // the bar is actually rendering, not the contract defaults.
      dispatch({
        type: 'statuslineOpen',
        hiddenItems: statuslineHiddenForPicker(),
        lines: linesRef.current,
        densities: densitiesRef.current,
      });
    },
    [dispatch, statuslineHiddenForPicker, linesRef, densitiesRef],
  );

  const { mouseMode, setMouseMode, nativeMouse, setNativeMouse } = useMouseTracking({
    initialMouseMode: mouse,
    initialNativeMouse: getSettings?.().mouseNative,
    overlayOpen: sidebarLayout.overlayOpen,
    protocol: capability?.mouseProtocol,
    stdout,
  });

  const { bottomRegionRef, statusBarWrapRef, belowStatusBarRef, termRows, statusBarRows } =
    useHistoryViewportSync({
      stdoutRows: stdout?.rows,
      viewportRows: state.viewportRows,
      setViewportRows: (rows) => dispatch({ type: 'setViewportRows', rows }),
    });

  const statusBarClickMapRef = React.useRef<StatusBarClickMap | null>(null);

  const { handleRewindTo } = useSessionRewind({
    agent,
    sessionsDir,
    interruptController,
    liveDirector,
    sessionGenerationRef,
  });

  const setDraft = (buffer: string, cursor: number): void => {
    draftRef.current = { buffer, cursor };
    dispatch({ type: 'setBuffer', buffer, cursor });
  };

  const clearDraft = (): void => {
    draftRef.current = { buffer: '', cursor: 0 };
    dispatch({ type: 'clearInput' });
  };

  const { runEternalLoopRef, runParallelLoopRef } = useAutonomyDrivers({
    getEternalEngine,
    getParallelEngine,
    getAutonomy,
    switchAutonomy,
    subscribeEternalIteration: props.subscribeEternalIteration,
    subscribeEternalStage: props.subscribeEternalStage,
    refreshGoalSummary,
    autonomyLive,
    setAutonomyLive,
    dispatch,
    eternalLoopRunningRef,
    parallelLoopRunningRef,
  });

  useStatusSyncInterval({
    getAutonomy,
    getYolo: props.getYolo,
    getModeLabel,
    getEternalEngine,
    getParallelEngine,
    agent,
    autonomyLive,
    yoloLive,
    liveModeLabel,
    liveModel,
    liveProvider,
    setAutonomyLive,
    setYoloLive,
    setLiveModeLabel,
    setLiveModel,
    setLiveProvider,
    runEternalLoopRef,
    runParallelLoopRef,
  });

  const gitInfo = useGitSessionStatus({ agent, getLiveSessions, setSessionCount, hiddenItems });

  const tokenRefresh = useTokenCounterRefresh(tokenCounter, events, agent.ctx.session?.id);

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
    ...(tokenRefresh ? { tokenRefresh } : {}),
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
    getActiveModelReasoningEffortLevels: props.getActiveModelReasoningEffortLevels,
  });
  const { openModelPicker, openProjectPicker, openFKeyPicker, loadLiveSessions, openSettings } =
    panelControllers;

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
    getYolo: props.getYolo,
    setSuggestions,
    autonomyNextPrompt,
    dispatch,
    clearDraft,
    runBlocksRef,
  });

  useSettingsAutoSave(state, saveSettings, dispatch);

  useTuiSlashCommands({
    slashRegistry,
    skillLoader: props.skillLoader,
    getResourceMenu: props.getResourceMenu,
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
    openPromptPicker,
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

  const { onPickerEnter } = useFileSearch({
    state,
    dispatch,
    projectRoot,
    builderRef,
    draftRef,
    setDraft,
    tokenPreviewsRef,
  });

  const { onThemePickerEnter } = useThemePickerHandler({
    configStore,
    saveThemePreset: props.saveThemePreset,
    dispatch,
    selectedIndex: state.themePicker.selected,
  });

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
    setPromptFavorite,
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

  const pipelineArgs = buildAppPipelineArgs({
    props,
    state,
    dispatch,
    historyScrollRef,
    runInterruptLadder,
    enhanceCancelledRef,
    enhanceAbortRef,
    enhanceOriginalRef,
    enhanceEnabledRef,
    inputGateRef,
    lastEscAtRef,
    dismissedEscAtRef,
    streamingTextRef,
    streamSegmentsRef,
    pendingDeltaRef,
    flushTimerRef,
    sessionGenerationRef,
    activeRunGenerationRef,
    activeRunSettledRef,
    assistantCommittedThisRunRef,
    confirmExitRef,
    chimeRef,
    activeCtrlRef,
    clearPendingConfirms,
    liveDirector,
    openProjectPicker,
    loadLiveSessions,
    openStatuslinePicker,
    statuslineHiddenItems,
    lastEnterAtRef,
    draftRef,
    setDraft,
    clearDraft,
    mouseMode,
    nativeMouse,
    termRows,
    terminalColumns: stdout?.columns ?? 80,
    terminalRows: stdout?.rows ?? 24,
    mainColumnWidth: sidebarLayout.mainColumnWidth,
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
    onHistoryCopy,
    tryPickerKey,
    pasteAccumRef,
    pasteFlushTimerRef,
    commitPaste,
    builderRef,
    tokenPreviewsRef,
    interruptsSyncRef,
    stateRef,
    runBlocksRef,
    submitRef,
    liveModel,
    liveProvider,
    activeMaxContext,
    yoloLive,
    autonomyLive,
    liveModeLabel,
    setMouseMode,
    setNativeMouse,
    setLiveModel,
    setLiveProvider,
    setActiveMaxContext,
    setYoloLive,
    setAutonomyLive,
    setLiveModeLabel,
    setLiveToolCount,
    autoSubmitStreakRef,
    autoSubmitCapWarnedRef,
    autoSubmitLoopGuardRef,
    runEternalLoopRef,
    runParallelLoopRef,
    midRunSendPickerRef,
    openPromptPicker,
    refreshGoalSummary,
    exit,
    setMemoryContextMonitor,
    runSteerSequence,
    setEnhanceStartedAt,
    setEnhanceDurationMs,
    setRefineProviderId,
    setRefineModel,
  });

  const { stableOnKey } = useAppExecutionPipeline(pipelineArgs);

  useInitialPrompt({ initialGoal, initialAsk, builderRef, runBlocksRef, dispatch });

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
        statusBarRows,
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
