import { useCallback } from 'react';
import type { AppProps } from './app-props.js';
import { effectivePanelPositions } from './app-ui-state.js';
import { deriveAppViewState } from './app-view-state.js';
import { leaderTimelineFromEntries } from './components/agents-monitor.js';
import { usePendingUserInput } from './components/user-input-prompt.js';
import { resolveControllerProps } from './controller-props.js';
import { useAppRefSpine } from './hooks/use-app-ref-spine.js';
import { useFileSearch } from './hooks/use-file-search.js';
import { useHistoryArchive } from './hooks/use-history-archive.js';
import { useHistoryCopyNotice } from './hooks/use-history-copy-notice.js';
import { useInputHistoryPersistence } from './hooks/use-input-history-persistence.js';
import { useKanbanBoardFocus } from './hooks/use-kanban-board-focus.js';
import { useNextStepsAutoSubmit } from './hooks/use-next-steps-auto-submit.js';
import { usePasteHandling } from './hooks/use-paste-handling.js';
import { useProviderWarmup } from './hooks/use-provider-warmup.js';
import { useQueueManager } from './hooks/use-queue-manager.js';
import { useSessionRewind } from './hooks/use-session-rewind.js';
import { useSkillMentionPicker } from './hooks/use-skill-mention-picker.js';
import { useSlashPicker } from './hooks/use-slash-picker.js';
import { useStatusbarViewModel } from './hooks/use-statusbar-view-model.js';
import { useThemePickerHandler } from './hooks/use-theme-picker-handler.js';
import { useTokenCounterRefresh } from './hooks/use-token-counter-refresh.js';
import { useApp, useStdout } from './ink.js';
import { useControllerAppState } from './use-controller-app-state.js';
import { useControllerAutoPrompts } from './use-controller-auto-prompts.js';
import { useControllerCommands } from './use-controller-commands.js';
import { useControllerConfirmAuth } from './use-controller-confirm-auth.js';
import { useControllerEnvironment } from './use-controller-environment.js';
import { useControllerInputWiring } from './use-controller-input-wiring.js';
import { useControllerPanelHooks } from './use-controller-panel-hooks.js';
import { useControllerSessionBridges } from './use-controller-session-bridges.js';
import { useControllerStatuslinePicker } from './use-controller-statusline-picker.js';
import { useControllerThemeEventWiring } from './use-controller-theme-wiring.js';
export function useAppController(props: AppProps) {
  const controllerProps = resolveControllerProps(props);
  const { getDirector } = controllerProps;
  const secretInputController = controllerProps.secretInputController;
  const pendingUserInput = usePendingUserInput(controllerProps.events);
  const { exit } = useApp();
  const { stdout } = useStdout();

  const projectRoot = controllerProps.agent.ctx.projectRoot;

  // Decomposition Phase 4 A1 (docs/decomposition-a0-app-map.md): state
  // facade + ref spine extracted; call order fixed + unconditional
  // (behavior contract §0.3).
  const { state, dispatch, layoutStore, liveTodos } = useControllerAppState({
    controllerProps,
  });
  const spine = useAppRefSpine({
    attachments: controllerProps.attachments,
    state,
    midRunSendPicker: controllerProps.midRunSendPicker,
  });
  const {
    builderRef,
    activeCtrlRef,
    tokenPreviewsRef,
    sessionGenerationRef,
    stateRef,
    draftRef,
    runBlocksRef,
    dismissedEscAtRef,
    submitRef,
    historyScrollRef,
    statusBarClickMapRef,
    inspectOverlayHeaderRef,
    midRunSendPickerRef,
    enhanceOriginalRef,
    enhanceCountdown,
    setEnhanceCountdown,
    enhanceStartedAt,
    enhanceDurationMs,
    refineProviderId,
    refineModel,
  } = spine;
  const onScrollInfo = useCallback(
    (info: { scrolled: boolean }) =>
      dispatch({ type: 'setHistoryScrolled', scrolled: info.scrolled }),
    [dispatch],
  );
  const { onRequestOlderEntries } = useHistoryArchive({
    entries: state.entries,
    dispatch,
    sessionsDir: controllerProps.sessionsDir,
    sessionId: controllerProps.agent.ctx.session?.id,
  });
  const onHistoryCopy = useHistoryCopyNotice(dispatch);
  const { focusedBoardId, setFocusedBoardId, boardFocusRef } = useKanbanBoardFocus();

  useInputHistoryPersistence({
    projectRoot,
    inputHistory: state.inputHistory,
    dispatch,
  });
  const panelHooks = useControllerPanelHooks({
    projectRoot,
    dispatch,
    getModes: controllerProps.getModes,
    getPickableProviders: controllerProps.getPickableProviders,
    state,
    getBrainData: controllerProps.getBrainData,
    brainPanelHost: controllerProps.brainPanelHost,
    onBrainRiskLevel: controllerProps.onBrainRiskLevel,
    getShadowData: controllerProps.getShadowData,
    onShadowStart: controllerProps.onShadowStart,
    onShadowStop: controllerProps.onShadowStop,
    subagentModelsHost: controllerProps.subagentModelsHost,
    slashRegistry: controllerProps.slashRegistry,
    subscribeCoordinatorEvents: controllerProps.subscribeCoordinatorEvents,
    submitRef,
    events: controllerProps.events,
  });
  const { mailbox } = panelHooks;

  // Decomposition Phase 4 A2 (docs/decomposition-a0-app-map.md): environment
  // facade — theme, env state, live settings, activity, layout, mouse,
  // viewport, autonomy drivers, status syncs, settings auto-save. Call order
  // fixed + unconditional (behavior contract §0.3); runs after the mailbox
  // VM (consumes mailboxPanelOpen).
  const envResult = useControllerEnvironment({
    controllerProps,
    state,
    dispatch,
    mailbox,
    stdout,
    props,
    spine,
  });
  const {
    environment,
    activity,
    projectName,
    workingDirChip,
    liveSettings,
    liveStatuslineMode,
    liveAnimationStyle,
    sidebarLayout,
    mouseMode,
    bottomRegionRef,
    statusBarWrapRef,
    belowStatusBarRef,
    termRows,
    statusBarRows,
    gitInfo,
    hiddenItems,
  } = envResult;
  const { liveModel, liveProvider, activeMaxContext, autonomyLive } = environment;
  const { displayThinkingWord } = activity;

  const { liveDirector, clearPendingConfirms, authPanelController } = useControllerConfirmAuth({
    getDirector,
    controllerProps,
    dispatch,
    state,
    secretInputController,
    spine,
  });

  const { statuslineHiddenForPicker, openStatuslinePicker } = useControllerStatuslinePicker({
    dispatch,
    spine,
    envResult,
  });

  const { handleRewindTo, handleRewindRedo } = useSessionRewind({
    agent: controllerProps.agent,
    sessionsDir: controllerProps.sessionsDir,
    interruptController: controllerProps.interruptController,
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

  const tokenRefresh = useTokenCounterRefresh(
    controllerProps.tokenCounter,
    controllerProps.events,
    controllerProps.agent.ctx.session?.id,
  );

  const statusbar = useStatusbarViewModel({
    agent: controllerProps.agent,
    tokenCounter: controllerProps.tokenCounter,
    activeMaxContext,
    effectiveMaxContext: controllerProps.effectiveMaxContext,
    liveProvider,
    liveModel,
    liveTodos,
    sidebarVisible: sidebarLayout.sidebarWidth > 0,
    hiddenItems,
    state,
    ...(tokenRefresh ? { tokenRefresh } : {}),
  });
  const { fleetCounts } = statusbar;

  useSkillMentionPicker(state, props.skillLoader, dispatch);

  const acceptSlashPickerSelection = useSlashPicker({
    state,
    slashRegistry: controllerProps.slashRegistry,
    dispatch,
    setDraft,
  });

  const { panelControllers, getCronJobs, runSteerSequence } = useControllerCommands({
    controllerProps,
    boardFocusRef,
    setFocusedBoardId,
    stdout,
    clearPendingConfirms,
    dispatch,
    liveDirector,
    handleRewindTo,
    handleRewindRedo,
    state,
    openStatuslinePicker,
    authPanelController,
    props,
    spine,
    envResult,
    panelHooks,
  });
  const { openModelPicker, openProjectPicker, openFKeyPicker, loadLiveSessions, openSettings } =
    panelControllers;

  const nextStepsAuto = useNextStepsAutoSubmit({
    state,
    autonomyLive,
    agent: controllerProps.agent,
    getAutonomy: controllerProps.getAutonomy,
    getSettings: controllerProps.getSettings,
    getSuggestions: controllerProps.getSuggestions,
    getAutoSuggestions: controllerProps.getAutoSuggestions,
    getYolo: props.getYolo,
    setSuggestions: controllerProps.setSuggestions,
    autonomyNextPrompt: controllerProps.autonomyNextPrompt,
    dispatch,
    clearDraft,
    runBlocksRef,
  });
  const { nextStepsAutoSubmitCountdown, nextStepsAutoSubmitLabel, nextStepsAutoSubmitDeadlineMs } =
    nextStepsAuto;
  useControllerThemeEventWiring({
    dispatch,
    controllerProps,
    props,
    openModelPicker,
    openFKeyPicker,
    projectRoot,
    openSettings,
    state,
    openStatuslinePicker,
    spine,
    envResult,
    panelHooks,
  });

  const paste = usePasteHandling({
    builderRef,
    dispatch,
    draftRef,
    setDraft,
    tokenPreviewsRef,
  });

  const queueManager = useQueueManager({
    queueStore: controllerProps.queueStore,
    queueStoreFor: controllerProps.queueStoreFor,
    onQueueChange: controllerProps.onQueueChange,
    slashRegistry: controllerProps.slashRegistry,
    stateRef,
    dispatch,
    getSettings: controllerProps.getSettings,
    saveSettings: controllerProps.saveSettings,
    midRunSendPickerRef,
  });

  useProviderWarmup(controllerProps.agent, state.buffer, state.status);

  const getActiveSessionId = useCallback(
    () => controllerProps.agent.ctx.session.id,
    [controllerProps.agent],
  );

  const getLeaderTranscript = useCallback(
    () => leaderTimelineFromEntries(stateRef.current.entries),
    [stateRef],
  );

  useControllerSessionBridges({
    controllerProps,
    dispatch,
    getActiveSessionId,
    state,
    clearPendingConfirms,
    liveDirector,
    spine,
    envResult,
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

  const { onThemePickerEnter, onThemePickerUndo } = useThemePickerHandler({
    configStore: controllerProps.configStore,
    saveThemePreset: props.saveThemePreset,
    dispatch,
    selectedIndex: state.themePicker.selected,
    filter: state.themePicker.filter,
    previous: state.themePicker.previous,
  });

  const { runInterruptLadder, stableOnKey } = useControllerInputWiring({
    spine,
    panelHooks,
    envResult,
    nextStepsAuto,
    paste,
    controllerProps,
    queueManager,
    props,
    state,
    dispatch,
    statusbar,
    panelControllers,
    authPanelController,
    setDraft,
    acceptSlashPickerSelection,
    statuslineHiddenForPicker,
    onPickerEnter,
    onThemePickerEnter,
    onThemePickerUndo,
    liveDirector,
    exit,
    clearPendingConfirms,
    openProjectPicker,
    loadLiveSessions,
    openStatuslinePicker,
    clearDraft,
    stdout,
    openModelPicker,
    onHistoryCopy,
    runSteerSequence,
  });

  useControllerAutoPrompts({
    props,
    controllerProps,
    dispatch,
    spine,
  });

  const viewState = deriveAppViewState({
    state,
    terminalColumns: stdout?.columns ?? 80,
    displayThinkingWord,
    fleetRunning: fleetCounts?.running ?? 0,
    liveAnimationStyle,
    panelPositions: effectivePanelPositions(state, liveSettings),
  });
  return {
    pendingUserInput,
    runInterruptLadder,
    props,
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
    inspectOverlayHeaderRef,
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
    nextStepsAutoSubmitDeadlineMs,
    setDraft,
    focusedBoardId,
    getCronJobs,
    getLeaderTranscript,
    coordinatorRunning: controllerProps.coordinatorRunning,
    enhanceDelayMs: controllerProps.enhanceDelayMs,
    layoutStore,
  };
}
