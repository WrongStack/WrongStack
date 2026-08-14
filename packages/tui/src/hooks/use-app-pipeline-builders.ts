import type { AppProps } from '../app-props.js';
import type { State } from '../app-reducer.js';
import type { AppExecutionPipelineArgs } from './use-app-execution-pipeline.js';

export function buildAppPipelineArgs(params: {
  props: AppProps;
  state: State;
  dispatch: any;
  historyScrollRef: any;
  runInterruptLadder: any;
  enhanceCancelledRef: any;
  enhanceAbortRef: any;
  enhanceOriginalRef: any;
  enhanceEnabledRef: any;
  inputGateRef: any;
  lastEscAtRef: any;
  dismissedEscAtRef: any;
  streamingTextRef: any;
  streamSegmentsRef: any;
  pendingDeltaRef: any;
  flushTimerRef: any;
  sessionGenerationRef: any;
  activeRunGenerationRef: any;
  activeRunSettledRef: any;
  assistantCommittedThisRunRef: any;
  confirmExitRef: any;
  chimeRef: any;
  activeCtrlRef: any;
  clearPendingConfirms: any;
  liveDirector: any;
  openProjectPicker: any;
  loadLiveSessions: any;
  openStatuslinePicker: any;
  statuslineHiddenItems: any;
  lastEnterAtRef: any;
  draftRef: any;
  setDraft: any;
  clearDraft: any;
  mouseMode: any;
  nativeMouse: any;
  termRows: any;
  terminalColumns: any;
  terminalRows: any;
  mainColumnWidth: any;
  overlayOpen: any;
  effectiveSwarmOnSidebar: any;
  sidebarTwinRowCount: any;
  statusBarWrapRef: any;
  belowStatusBarRef: any;
  statusBarClickMapRef: any;
  openModelPicker: any;
  nextStepsAutoSubmitTimerRef: any;
  nextStepsAutoSubmitSuggestionRef: any;
  nextStepsAutoSubmitLabel: any;
  setNextStepsAutoSubmitCountdown: any;
  setNextStepsAutoSubmitLabel: any;
  cancelNextStepsCountdown: any;
  pasteClipboardText: any;
  pasteClipboardImage: any;
  onHistoryCopy: any;
  tryPickerKey: any;
  pasteAccumRef: any;
  pasteFlushTimerRef: any;
  commitPaste: any;
  builderRef: any;
  tokenPreviewsRef: any;
  interruptsSyncRef: any;
  stateRef: any;
  runBlocksRef: any;
  submitRef: any;
  liveModel: any;
  liveProvider: any;
  activeMaxContext: any;
  yoloLive: any;
  autonomyLive: any;
  liveModeLabel: any;
  setMouseMode: any;
  setNativeMouse: any;
  setLiveModel: any;
  setLiveProvider: any;
  setActiveMaxContext: any;
  setYoloLive: any;
  setAutonomyLive: any;
  setLiveModeLabel: any;
  setLiveToolCount: any;
  autoSubmitStreakRef: any;
  autoSubmitCapWarnedRef: any;
  autoSubmitLoopGuardRef: any;
  runEternalLoopRef: any;
  runParallelLoopRef: any;
  midRunSendPickerRef: any;
  openPromptPicker: any;
  refreshGoalSummary: any;
  exit: any;
  setMemoryContextMonitor: any;
  runSteerSequence: any;
  setEnhanceStartedAt: any;
  setEnhanceDurationMs: any;
  setRefineProviderId: any;
  setRefineModel: any;
}): AppExecutionPipelineArgs {
  const {
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
  } = params;

  return {
    keyHandlerParams: {
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
    } as any,
    runBlocksParams: {
      capabilities: {
        agent: props.agent,
        tokenCounter: props.tokenCounter,
        supportsVision: props.supportsVision,
        visionAdapters: props.visionAdapters,
        onSDDOutput: props.onSDDOutput,
        onSuggestionsParsed: props.onSuggestionsParsed,
        predictNext: props.predictNext,
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
    } as any,
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
        runBlocks: (blocks: any) => runBlocksRef.current(blocks),
        liveDirector,
        setMemoryContextMonitor,
        runSteerSequence,
        setEnhanceStartedAt,
        setEnhanceDuration: setEnhanceDurationMs,
        setRefineProvider: setRefineProviderId,
        setRefineModel,
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
    } as any,
    runBlocksRef,
    submitRef,
  };
}
