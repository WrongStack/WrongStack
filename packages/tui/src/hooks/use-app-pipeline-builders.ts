import type { AppProps } from '../app-props.js';
import type {
  AppExecutionPipelineArgs,
  KeyHandlerParams,
  RunBlocksParams,
  SubmitParams,
} from './use-app-execution-pipeline.js';

// Bag params are typed by their CONSUMER: every field below is forwarded into
// exactly one of the three controller param objects assembled in the body, so
// each type is an indexed access of that destination. The aliases track the
// controllers automatically when their param interfaces change.
type K = KeyHandlerParams;
type R = RunBlocksParams;
type S = SubmitParams;

export function buildAppPipelineArgs(params: {
  props: AppProps;
  state: K['state'];
  dispatch: K['dispatch'];
  historyScrollRef: K['historyScrollRef'];
  onHistoryScrollActivity: K['onHistoryScrollActivity'];
  runInterruptLadder: K['runInterruptLadder'];
  enhanceCancelledRef: K['enhanceCancelledRef'];
  enhanceAbortRef: K['enhanceAbortRef'];
  enhanceOriginalRef: S['refs']['enhanceOriginal'];
  enhanceEnabledRef: S['refs']['enhanceEnabled'];
  inputGateRef: K['inputGateRef'];
  lastEscAtRef: K['lastEscAtRef'];
  dismissedEscAtRef: K['dismissedEscAtRef'];
  streamingTextRef: K['streamingTextRef'];
  streamSegmentsRef: R['refs']['streamSegments'];
  pendingDeltaRef: R['refs']['pendingDelta'];
  flushTimerRef: R['refs']['flushTimer'];
  sessionGenerationRef: R['refs']['sessionGeneration'];
  activeRunGenerationRef: R['refs']['activeRunGeneration'];
  activeRunSettledRef: R['refs']['activeRunSettled'];
  assistantCommittedThisRunRef: R['refs']['assistantCommitted'];
  confirmExitRef: K['confirmExitRef'];
  chimeRef: R['refs']['chime'];
  activeCtrlRef: K['activeCtrlRef'];
  clearPendingConfirms: K['clearPendingConfirms'];
  liveDirector: K['liveDirector'];
  openProjectPicker: K['openProjectPicker'];
  loadLiveSessions: K['loadLiveSessions'];
  openStatuslinePicker: K['openStatuslinePicker'];
  statuslineHiddenItems: K['statuslineHiddenItems'];
  lastEnterAtRef: K['lastEnterAtRef'];
  draftRef: K['draftRef'];
  setDraft: K['setDraft'];
  clearDraft: S['actions']['clearDraft'];
  mouseMode: K['mouseMode'];
  nativeMouse: S['live']['nativeMouse'];
  termRows: K['termRows'];
  terminalColumns: K['terminalColumns'];
  terminalRows: K['terminalRows'];
  mainColumnWidth: K['mainColumnWidth'];
  overlayOpen: K['overlayOpen'];
  effectiveSwarmOnSidebar: K['effectiveSwarmOnSidebar'];
  sidebarTwinRowCount: K['sidebarTwinRowCount'];
  statusBarWrapRef: K['statusBarWrapRef'];
  belowStatusBarRef: K['belowStatusBarRef'];
  statusBarClickMapRef: K['statusBarClickMapRef'];
  openModelPicker: K['openModelPicker'];
  nextStepsAutoSubmitTimerRef: K['nextStepsAutoSubmitTimerRef'];
  nextStepsAutoSubmitSuggestionRef: K['nextStepsAutoSubmitSuggestionRef'];
  nextStepsAutoSubmitLabel: K['nextStepsAutoSubmitLabel'];
  setNextStepsAutoSubmitCountdown: K['setNextStepsAutoSubmitCountdown'];
  setNextStepsAutoSubmitLabel: K['setNextStepsAutoSubmitLabel'];
  cancelNextStepsCountdown: K['cancelNextStepsCountdown'];
  pasteClipboardText: K['pasteClipboardText'];
  pasteClipboardImage: K['pasteClipboardImage'];
  onHistoryCopy: K['onHistoryCopy'];
  tryPickerKey: K['tryPickerKey'];
  pasteAccumRef: K['pasteAccumRef'];
  pasteFlushTimerRef: K['pasteFlushTimerRef'];
  commitPaste: K['commitPaste'];
  builderRef: S['refs']['builder'];
  tokenPreviewsRef: S['refs']['tokenPreviews'];
  interruptsSyncRef: R['refs']['interrupts'];
  stateRef: R['refs']['state'];
  runBlocksRef: AppExecutionPipelineArgs['runBlocksRef'];
  submitRef: AppExecutionPipelineArgs['submitRef'];
  liveModel: S['live']['model'];
  liveProvider: S['live']['provider'];
  activeMaxContext: S['live']['maxContext'];
  yoloLive: S['live']['yolo'];
  autonomyLive: S['live']['autonomy'];
  liveModeLabel: S['live']['modeLabel'];
  setMouseMode: S['live']['setMouseMode'];
  setNativeMouse: S['live']['setNativeMouse'];
  setLiveModel: S['live']['setModel'];
  setLiveProvider: S['live']['setProvider'];
  setActiveMaxContext: S['live']['setMaxContext'];
  setYoloLive: S['live']['setYolo'];
  setAutonomyLive: S['live']['setAutonomy'];
  setLiveModeLabel: S['live']['setModeLabel'];
  setLiveToolCount: S['live']['setToolCount'];
  autoSubmitStreakRef: S['refs']['autoSubmitStreak'];
  autoSubmitCapWarnedRef: S['refs']['autoSubmitCapWarned'];
  autoSubmitLoopGuardRef: S['refs']['autoSubmitLoopGuard'];
  runEternalLoopRef: S['refs']['eternalLoop'];
  runParallelLoopRef: S['refs']['parallelLoop'];
  midRunSendPickerRef: S['refs']['midRunSendPicker'];
  openPromptPicker: S['actions']['openPromptPicker'];
  refreshGoalSummary: S['actions']['refreshGoalSummary'];
  exit: S['actions']['exit'];
  setMemoryContextMonitor: S['actions']['setMemoryContextMonitor'];
  runSteerSequence: S['actions']['runSteerSequence'];
  setEnhanceStartedAt: S['actions']['setEnhanceStartedAt'];
  setEnhanceDurationMs: S['actions']['setEnhanceDuration'];
  setRefineProviderId: S['actions']['setRefineProvider'];
  setRefineModel: S['actions']['setRefineModel'];
  onBugHuntStarted: S['actions']['onBugHuntStarted'];
  consumeBugHuntReplay: S['actions']['consumeBugHuntReplay'];
  onBugHuntRunFinished: R['capabilities']['onRunFinished'];
  shouldSuppressBugHuntNextSteps: () => boolean;
}): AppExecutionPipelineArgs {
  const {
    props,
    state,
    dispatch,
    historyScrollRef,
    onHistoryScrollActivity,
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
    terminalColumns,
    terminalRows,
    mainColumnWidth,
    overlayOpen,
    effectiveSwarmOnSidebar,
    sidebarTwinRowCount,
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
    onBugHuntStarted,
    consumeBugHuntReplay,
    onBugHuntRunFinished,
    shouldSuppressBugHuntNextSteps,
  } = params;

  return {
    keyHandlerParams: {
      state,
      dispatch,
      historyScrollRef,
      onHistoryScrollActivity,
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
      getSddRun: props.getSddRun,
      onSddLifecycle: props.onSddLifecycle,
      getSettings: props.getSettings,
      saveSettings: props.saveSettings,
      lastEnterAtRef,
      draftRef,
      setDraft,
      submit: () => submitRef.current(),
      mouseMode,
      termRows,
      terminalColumns,
      terminalRows,
      mainColumnWidth,
      overlayOpen,
      effectiveSwarmOnSidebar,
      sidebarTwinRowCount,
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
      slashRegistry: props.slashRegistry,
      agent: props.agent,
      onHistoryCopy,
    },
    runBlocksParams: {
      capabilities: {
        agent: props.agent,
        tokenCounter: props.tokenCounter,
        supportsVision: props.supportsVision,
        visionAdapters: props.visionAdapters,
        onSDDOutput: props.onSDDOutput,
        onSuggestionsParsed: props.onSuggestionsParsed,
        predictNext: props.predictNext,
        shouldSuppressNextSteps: shouldSuppressBugHuntNextSteps,
        onRunFinished: onBugHuntRunFinished,
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
    },
    submitParams: {
      capabilities: {
        agent: props.agent,
        slashRegistry: props.slashRegistry,
        tokenCounter: props.tokenCounter,
        getSettings: props.getSettings,
        saveSettings: props.saveSettings,
        getYolo: props.getYolo,
        getAutonomy: props.getAutonomy,
        getEternalEngine: props.getEternalEngine,
        getParallelEngine: props.getParallelEngine,
        getModeLabel: props.getModeLabel,
        getToolsItems: props.getToolsItems,
        onExit: props.onExit,
        clearTerminal: props.clearTerminal,
        onClearHistory: props.onClearHistory,
        getSuggestions: props.getSuggestions,
        getSDDContext: props.getSDDContext,
        switchAutonomy: props.switchAutonomy,
        memoryStore: props.memoryStore,
        getEnhancerReasoning: props.getEnhancerReasoning,
        buildEnhancerProvider: props.buildEnhancerProvider,
        getEnhanceFallbackRef: props.getEnhanceFallbackRef,
        getConfiguredRefinerRef: props.getConfiguredRefinerRef,
        getPickableProviders: props.getPickableProviders,
      },
      state,
      live: {
        mouseMode,
        nativeMouse,
        model: liveModel,
        provider: liveProvider,
        maxContext: activeMaxContext,
        yolo: yoloLive,
        autonomy: autonomyLive,
        modeLabel: liveModeLabel,
        setMouseMode,
        setNativeMouse,
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
        attachments: props.attachments,
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
        runBlocks: (blocks: Parameters<S['actions']['runBlocks']>[0]) =>
          runBlocksRef.current(blocks),
        liveDirector,
        setMemoryContextMonitor,
        runSteerSequence,
        setEnhanceStartedAt,
        setEnhanceDuration: setEnhanceDurationMs,
        setRefineProvider: setRefineProviderId,
        setRefineModel,
        onBugHuntStarted,
        consumeBugHuntReplay,
        onAfterClear: () => {
          pasteAccumRef.current = null;
          if (pasteFlushTimerRef.current) {
            clearTimeout(pasteFlushTimerRef.current);
            pasteFlushTimerRef.current = null;
          }
          nextStepsAutoSubmitSuggestionRef.current = null;
          cancelNextStepsCountdown();
          if (props.attachments) {
            void props.attachments.clear()?.catch?.(() => undefined);
          }
          if (builderRef.current) {
            builderRef.current.reset();
          }
        },
      },
    },
    runBlocksRef,
    submitRef,
  };
}
