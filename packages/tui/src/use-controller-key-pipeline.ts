import { useAppExecutionPipeline } from './hooks/use-app-execution-pipeline.js';

import { useAppPickerKeys } from './hooks/use-app-picker-keys.js';

import { buildAppPipelineArgs } from './hooks/use-app-pipeline-builders.js';

import { useInterruptLadder } from './hooks/use-interrupt-ladder.js';
import type { useStdout } from './ink.js';

export function useControllerKeyPipeline({
  sessionGenerationRef,
  switchQueueSession,
  props,
  state,
  dispatch,
  environment,
  statusbar,
  panelControllers,
  authPanelController,
  brainCtl,
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
  subagentModelsCtl,
  statuslineHiddenForPicker,
  onPickerEnter,
  onThemePickerEnter,
  onThemePickerUndo,
  setPromptFavorite,
  stateRef,
  exitRequestedRef,
  agent,
  liveDirector,
  onExit,
  exit,
  activeCtrlRef,
  clearPendingConfirms,
  getEternalEngine,
  getParallelEngine,
  eternalLoopRunningRef,
  parallelLoopRunningRef,
  switchAutonomy,
  getSddRun,
  confirmExitRef,
  historyScrollRef,
  onHistoryScrollActivity,
  enhanceCancelledRef,
  enhanceAbortRef,
  enhanceOriginalRef,
  enhanceEnabledRef,
  lastEscAtRef,
  dismissedEscAtRef,
  streamingTextRef,
  streamSegmentsRef,
  pendingDeltaRef,
  flushTimerRef,
  activeRunGenerationRef,
  activeRunSettledRef,
  assistantCommittedThisRunRef,
  chimeRef,
  openProjectPicker,
  loadLiveSessions,
  openStatuslinePicker,
  statuslineHiddenItems,
  draftRef,
  clearDraft,
  mouseMode,
  nativeMouse,
  termRows,
  stdout,
  sidebarLayout,
  statusBarWrapRef,
  belowStatusBarRef,
  statusBarClickMapRef,
  inspectOverlayHeaderRef,
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
  closeMailboxPanel,
  pasteAccumRef,
  pasteFlushTimerRef,
  commitPaste,
  builderRef,
  tokenPreviewsRef,
  runBlocksRef,
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
  setMemoryContextMonitor,
  runSteerSequence,
  setEnhanceStartedAt,
  setEnhanceDurationMs,
  setRefineProviderId,
  setRefineModel,
  bugHuntLoop,
}: {
  sessionGenerationRef: React.RefObject<number>;
  /** Move the input queue to a resumed session. */
  switchQueueSession?: ((sessionId: string) => void) | undefined;
  props: import('./app-props.js').AppProps;
  state: import('./app-state.js').State;
  dispatch: React.ActionDispatch<[action: import('./app-action-type.js').Action]>;
  environment: {
    hiddenItemsRef: React.RefObject<import('@wrongstack/core/statusline').StatuslineItem[]>;
    memoryContextMonitor: import('./memory-context-monitor.js').MemoryContextMonitorState;
    setMemoryContextMonitor: React.Dispatch<
      React.SetStateAction<import('./memory-context-monitor.js').MemoryContextMonitorState>
    >;
    memoryRecordTotal: number | undefined;
    memoryContextMonitorRef: React.RefObject<
      import('./memory-context-monitor.js').MemoryContextMonitorState
    >;
    memoryRecordTotalRef: React.RefObject<number | undefined>;
    activeMemoryInContext: number;
    liveToolCount: number | undefined;
    setLiveToolCount: React.Dispatch<React.SetStateAction<number | undefined>>;
    indexState: {
      ready: boolean;
      indexing: boolean;
      currentFile: number;
      totalFiles: number;
      lastError: string | null;
      server: import('@wrongstack/tools').ProjectIndexServerConnectionState;
      circuit: import('@wrongstack/tools').CircuitSnapshot;
    };
    breakerCountdown: import('@wrongstack/tools').BreakerCountdown | null;
    liveModel: string;
    setLiveModel: (v: string) => void;
    liveProvider: string;
    setLiveProvider: (v: string) => void;
    activeMaxContext: number | undefined;
    setActiveMaxContext: (v: number | undefined) => void;
    yoloLive: boolean;
    setYoloLive: (v: boolean) => void;
    autonomyLive: import('./hooks/use-statusline-state.js').AutonomyStage;
    setAutonomyLive: (v: import('./hooks/use-statusline-state.js').AutonomyStage) => void;
    liveModeLabel: string;
    setLiveModeLabel: (v: string) => void;
    hiddenItems: import('@wrongstack/core/statusline').StatuslineItem[];
    setHiddenItems: (v: import('@wrongstack/core/statusline').StatuslineItem[]) => void;
    lines: Partial<
      Record<
        import('@wrongstack/core/statusline').StatuslineItem,
        import('@wrongstack/core/statusline').StatuslineLine
      >
    >;
    setLines: (
      v: Partial<
        Record<
          import('@wrongstack/core/statusline').StatuslineItem,
          import('@wrongstack/core/statusline').StatuslineLine
        >
      >,
    ) => void;
    densities: Partial<
      Record<
        import('@wrongstack/core/statusline').StatuslineItem,
        import('@wrongstack/core/statusline').StatuslineDensity
      >
    >;
    setDensities: (
      v: Partial<
        Record<
          import('@wrongstack/core/statusline').StatuslineItem,
          import('@wrongstack/core/statusline').StatuslineDensity
        >
      >,
    ) => void;
    order: import('@wrongstack/core/statusline').StatuslineOrder;
    setOrder: (v: import('@wrongstack/core/statusline').StatuslineOrder) => void;
    sessionCount: number;
    setSessionCount: (v: number) => void;
  };
  statusbar: {
    contextBreakdown: import('@wrongstack/core/agent').ContextBreakdown | undefined;
    contextResidency: import('@wrongstack/core/utils').RequestResidency | undefined;
    historyRetention: import('@wrongstack/core/utils').HistoryRetention | undefined;
    currentContextTokens: number;
    contextWindow: { used: number; max: number } | undefined;
    cacheStats: import('@wrongstack/contracts/types').CacheStats;
    cacheCoverageTokens: number;
    todos: { pending: number; inProgress: number; completed: number };
    fleetCounts: { running: number; idle: number; pending: number; completed: number } | undefined;
    visibleSubagentCount: number;
    hasVisibleFleetPanel: boolean;
    entriesWithLeader: Record<string, import('./app-state-fleet.js').FleetEntry>;
    planCounts: import('./hooks/use-statusbar-view-model.js').PlanCounts | null;
    taskCounts: import('./hooks/use-statusbar-view-model.js').TaskCounts | null;
    droppedTools: number;
  };
  panelControllers: {
    openModelPicker: () => Promise<void>;
    openProjectPicker: () => Promise<void>;
    openFKeyPicker: () => void;
    loadLiveSessions: () => Promise<void>;
    openSettings: () => void;
    toggleSelectedPlugin: () => Promise<void>;
    toggleSelectedMcpServer: () => Promise<void>;
    restartSelectedMcpServer: () => Promise<void>;
    saveMcpEditor: () => Promise<void>;
    toggleSelectedTool: () => Promise<void>;
  };
  authPanelController: import('./hooks/use-auth-panel.js').AuthPanelController;
  brainCtl: import('./hooks/use-brain-panel.js').BrainPanelController;
  lastEnterAtRef: React.RefObject<number>;
  inputGateRef: React.RefObject<boolean>;
  submitRef: React.RefObject<(text?: string | undefined) => void>;
  promptUsageRef: React.RefObject<import('@wrongstack/core/storage').PromptUsageStore | null>;
  setDraft: (buffer: string, cursor: number) => void;
  acceptSlashPickerSelection: () => void;
  changeBrainRisk: (delta: number) => void;
  handleModelPicked: (providerId: string, modelId: string) => void;
  handleShadowStart: () => Promise<void>;
  handleShadowStop: () => Promise<void>;
  subagentModelsCtl: import('./hooks/use-subagent-models-panel.js').SubagentModelsPanelController;
  statuslineHiddenForPicker: () => import('@wrongstack/core/statusline').StatuslineItem[];
  onPickerEnter: () => Promise<void>;
  onThemePickerEnter: () => void;
  onThemePickerUndo: () => void;
  setPromptFavorite: (slug: string, favorite: boolean) => Promise<void>;
  stateRef: React.RefObject<import('./app-state.js').State>;
  exitRequestedRef: React.RefObject<boolean>;
  agent: import('@wrongstack/core/agent').Agent;
  liveDirector: () => import('@wrongstack/core/coordination').Director | null;
  onExit: (code: number) => void;
  exit: (errorOrResult?: unknown) => void;
  activeCtrlRef: React.RefObject<AbortController | null>;
  clearPendingConfirms: () => void;
  getEternalEngine:
    | (() => import('@wrongstack/core/execution').EternalAutonomyEngine | null)
    | undefined;
  getParallelEngine:
    | (() => import('@wrongstack/core/coordination').ParallelEternalEngine | null)
    | undefined;
  eternalLoopRunningRef: React.RefObject<boolean>;
  parallelLoopRunningRef: React.RefObject<boolean>;
  switchAutonomy:
    | ((mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => string | null)
    | undefined;
  getSddRun: (() => import('@wrongstack/sdd').SddRunControl | null) | undefined;
  confirmExitRef: React.MutableRefObject<boolean>;
  historyScrollRef: React.RefObject<
    import('./components/history/scroll-controller-types.js').HistoryScrollController | null
  >;
  onHistoryScrollActivity: () => void;
  enhanceCancelledRef: React.MutableRefObject<boolean>;
  enhanceAbortRef: React.MutableRefObject<AbortController | null>;
  enhanceOriginalRef: React.MutableRefObject<string>;
  enhanceEnabledRef: React.MutableRefObject<boolean>;
  lastEscAtRef: React.RefObject<number>;
  dismissedEscAtRef: React.RefObject<number>;
  streamingTextRef: React.RefObject<string>;
  streamSegmentsRef: React.RefObject<{ kind: 'assistant' | 'thinking'; text: string }[]>;
  pendingDeltaRef: React.RefObject<string>;
  flushTimerRef: React.RefObject<NodeJS.Timeout | null>;
  activeRunGenerationRef: React.RefObject<number>;
  activeRunSettledRef: React.RefObject<Promise<void>>;
  assistantCommittedThisRunRef: React.RefObject<boolean>;
  chimeRef: React.MutableRefObject<boolean>;
  openProjectPicker: () => Promise<void>;
  loadLiveSessions: () => Promise<void>;
  openStatuslinePicker: (field?: number | undefined) => void;
  statuslineHiddenItems: import('@wrongstack/core/statusline').StatuslineItem[];
  draftRef: React.RefObject<{ buffer: string; cursor: number }>;
  clearDraft: () => void;
  mouseMode: boolean;
  nativeMouse: boolean;
  termRows: number;
  stdout: ReturnType<typeof useStdout>['stdout'];
  sidebarLayout: import('./app-ui-state.js').SidebarLayoutState;
  statusBarWrapRef: React.RefObject<import('ink').DOMElement | null>;
  belowStatusBarRef: React.RefObject<import('ink').DOMElement | null>;
  statusBarClickMapRef: React.RefObject<
    import('./components/status-bar-types.js').StatusBarClickMap | null
  >;
  inspectOverlayHeaderRef: React.RefObject<import('ink').DOMElement | null>;
  openModelPicker: () => Promise<void>;
  nextStepsAutoSubmitTimerRef: React.MutableRefObject<NodeJS.Timeout | undefined>;
  nextStepsAutoSubmitSuggestionRef: React.MutableRefObject<string | null>;
  nextStepsAutoSubmitLabel: string | null;
  setNextStepsAutoSubmitCountdown: React.Dispatch<React.SetStateAction<number | null>>;
  setNextStepsAutoSubmitLabel: React.Dispatch<React.SetStateAction<string | null>>;
  cancelNextStepsCountdown: () => void;
  pasteClipboardText: () => Promise<void>;
  pasteClipboardImage: () => Promise<void>;
  onHistoryCopy: (entryId: number) => void;
  /** Defined only while the /mailbox panel is open (Esc closes it). */
  closeMailboxPanel: (() => void) | undefined;
  pasteAccumRef: React.MutableRefObject<import('./paste-accumulator.js').PasteAccumState>;
  pasteFlushTimerRef: React.MutableRefObject<NodeJS.Timeout | null>;
  commitPaste: (full: string) => Promise<void>;
  builderRef: React.RefObject<import('@wrongstack/core/agent').InputBuilder | null>;
  tokenPreviewsRef: React.RefObject<import('./token-previews.js').TokenPreviewStore>;
  runBlocksRef: React.RefObject<
    (blocks: import('@wrongstack/contracts/types').ContentBlock[]) => Promise<void>
  >;
  liveModel: string;
  liveProvider: string;
  activeMaxContext: number | undefined;
  yoloLive: boolean;
  autonomyLive: import('./hooks/use-statusline-state.js').AutonomyStage;
  liveModeLabel: string;
  setMouseMode: (value: boolean) => void;
  setNativeMouse: (value: boolean) => void;
  setLiveModel: (v: string) => void;
  setLiveProvider: (v: string) => void;
  setActiveMaxContext: (v: number | undefined) => void;
  setYoloLive: (v: boolean) => void;
  setAutonomyLive: (v: import('./hooks/use-statusline-state.js').AutonomyStage) => void;
  setLiveModeLabel: (v: string) => void;
  setLiveToolCount: React.Dispatch<React.SetStateAction<number | undefined>>;
  autoSubmitStreakRef: React.MutableRefObject<number>;
  autoSubmitCapWarnedRef: React.MutableRefObject<boolean>;
  autoSubmitLoopGuardRef: React.MutableRefObject<import('@wrongstack/tools').AutoProceedLoopGuard>;
  runEternalLoopRef: React.MutableRefObject<() => Promise<void>>;
  runParallelLoopRef: React.MutableRefObject<() => Promise<void>>;
  midRunSendPickerRef: React.MutableRefObject<boolean>;
  openPromptPicker: () => Promise<void>;
  refreshGoalSummary: () => void;
  setMemoryContextMonitor: React.Dispatch<
    React.SetStateAction<import('./memory-context-monitor.js').MemoryContextMonitorState>
  >;
  runSteerSequence: (text: string) => {
    preamble: string;
    droppedCount: number;
    subagentsTerminated: number;
  };
  setEnhanceStartedAt: React.Dispatch<React.SetStateAction<number | null>>;
  setEnhanceDurationMs: React.Dispatch<React.SetStateAction<number | null>>;
  setRefineProviderId: React.Dispatch<React.SetStateAction<string | null>>;
  setRefineModel: React.Dispatch<React.SetStateAction<string | null>>;
  bugHuntLoop: {
    onBugHuntStarted: (command: string, totalRounds?: number | undefined) => void;
    onRunFinished: (status: 'done' | 'aborted' | 'failed' | 'max_iterations') => void;
    consumeReplay: (command: string) => boolean;
    stopAfterCurrentRound: () => void;
    shouldSuppressNextSteps: () => boolean;
  };
}) {
  const tryPickerKey = useAppPickerKeys({
    sessionGenerationRef,
    switchQueueSession,
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
    subagentModelsController: subagentModelsCtl,
    statuslineHiddenForPicker,
    onPickerEnter,
    onThemePickerEnter,
    onThemePickerUndo,
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
    terminalColumns: stdout?.columns ?? 80,
    terminalRows: stdout?.rows ?? 24,
    mainColumnWidth: sidebarLayout.mainColumnWidth,
    overlayOpen: sidebarLayout.overlayOpen,
    effectiveSwarmOnSidebar: sidebarLayout.effectiveSwarmOnSidebar,
    sidebarTwinRowCount: sidebarLayout.sidebarTwinRowCount,
    statusBarWrapRef,
    belowStatusBarRef,
    statusBarClickMapRef,
    inspectOverlayHeaderRef,
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
    closeMailboxPanel,
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
    onBugHuntStarted: bugHuntLoop.onBugHuntStarted,
    stopBugHuntAfterCurrentRound: bugHuntLoop.stopAfterCurrentRound,
    consumeBugHuntReplay: bugHuntLoop.consumeReplay,
    onBugHuntRunFinished: bugHuntLoop.onRunFinished,
    shouldSuppressBugHuntNextSteps: bugHuntLoop.shouldSuppressNextSteps,
  });

  const { stableOnKey } = useAppExecutionPipeline(pipelineArgs);
  return { runInterruptLadder, stableOnKey };
}
