import type { resolveControllerProps } from './controller-props.js';
import type { useAppEnvironment } from './hooks/use-app-environment.js';
import type { useAppRefSpine } from './hooks/use-app-ref-spine.js';
import type { useNextStepsAutoSubmit } from './hooks/use-next-steps-auto-submit.js';
import type { usePasteHandling } from './hooks/use-paste-handling.js';
import type { useQueueManager } from './hooks/use-queue-manager.js';
import { useControllerKeyPipeline } from './use-controller-key-pipeline.js';
import type { useControllerPanelHooks } from './use-controller-panel-hooks.js';

type KeyPipelineArgs = Parameters<typeof useControllerKeyPipeline>[0];

/**
 * Wires `useAppController`'s ref spine, environment, panel, next-steps and
 * paste facades into the key/execution pipeline. Exactly one hook call
 * (`useControllerKeyPipeline`), so `useAppController`'s fixed hook order is
 * unchanged.
 */
export function useControllerInputWiring({
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
}: {
  spine: ReturnType<typeof useAppRefSpine>;
  panelHooks: ReturnType<typeof useControllerPanelHooks>;
  envResult: ReturnType<typeof useAppEnvironment>;
  nextStepsAuto: ReturnType<typeof useNextStepsAutoSubmit>;
  paste: ReturnType<typeof usePasteHandling>;
  controllerProps: ReturnType<typeof resolveControllerProps>;
  queueManager: ReturnType<typeof useQueueManager>;
  props: KeyPipelineArgs['props'];
  state: KeyPipelineArgs['state'];
  dispatch: KeyPipelineArgs['dispatch'];
  statusbar: KeyPipelineArgs['statusbar'];
  panelControllers: KeyPipelineArgs['panelControllers'];
  authPanelController: KeyPipelineArgs['authPanelController'];
  setDraft: KeyPipelineArgs['setDraft'];
  acceptSlashPickerSelection: KeyPipelineArgs['acceptSlashPickerSelection'];
  statuslineHiddenForPicker: KeyPipelineArgs['statuslineHiddenForPicker'];
  onPickerEnter: KeyPipelineArgs['onPickerEnter'];
  onThemePickerEnter: KeyPipelineArgs['onThemePickerEnter'];
  onThemePickerUndo: KeyPipelineArgs['onThemePickerUndo'];
  liveDirector: KeyPipelineArgs['liveDirector'];
  exit: KeyPipelineArgs['exit'];
  clearPendingConfirms: KeyPipelineArgs['clearPendingConfirms'];
  openProjectPicker: KeyPipelineArgs['openProjectPicker'];
  loadLiveSessions: KeyPipelineArgs['loadLiveSessions'];
  openStatuslinePicker: KeyPipelineArgs['openStatuslinePicker'];
  clearDraft: KeyPipelineArgs['clearDraft'];
  stdout: KeyPipelineArgs['stdout'];
  openModelPicker: KeyPipelineArgs['openModelPicker'];
  onHistoryCopy: KeyPipelineArgs['onHistoryCopy'];
  runSteerSequence: KeyPipelineArgs['runSteerSequence'];
}) {
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
    historyScrollRef,
    statusBarClickMapRef,
    inspectOverlayHeaderRef,
    enhanceEnabledRef,
    midRunSendPickerRef,
    enhanceAbortRef,
    enhanceCancelledRef,
    enhanceOriginalRef,
    setEnhanceStartedAt,
    setEnhanceDurationMs,
    setRefineProviderId,
    setRefineModel,
  } = spine;
  const {
    openPromptPicker,
    setPromptFavorite,
    handleModelPicked,
    brainCtl,
    changeBrainRisk,
    handleShadowStart,
    handleShadowStop,
    subagentModelsCtl,
    bugHuntLoop,
    mailbox,
  } = panelHooks;
  const {
    environment,
    refreshGoalSummary,
    chimeRef,
    confirmExitRef,
    sidebarLayout,
    mouseMode,
    setMouseMode,
    nativeMouse,
    setNativeMouse,
    statusBarWrapRef,
    belowStatusBarRef,
    termRows,
    runEternalLoopRef,
    runParallelLoopRef,
    setMemoryContextMonitor,
    setLiveToolCount,
  } = envResult;
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
  } = environment;
  const {
    nextStepsAutoSubmitLabel,
    setNextStepsAutoSubmitCountdown,
    setNextStepsAutoSubmitLabel,
    nextStepsAutoSubmitSuggestionRef,
    nextStepsAutoSubmitTimerRef,
    autoSubmitStreakRef,
    autoSubmitCapWarnedRef,
    autoSubmitLoopGuardRef,
    cancelNextStepsCountdown,
  } = nextStepsAuto;
  const {
    pasteAccumRef,
    pasteFlushTimerRef,
    commitPaste,
    pasteClipboardImage,
    pasteClipboardText,
  } = paste;
  return useControllerKeyPipeline({
    sessionGenerationRef,
    switchQueueSession: queueManager.switchSession,
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
    agent: controllerProps.agent,
    liveDirector,
    onExit: controllerProps.onExit,
    exit,
    activeCtrlRef,
    clearPendingConfirms,
    getEternalEngine: controllerProps.getEternalEngine,
    getParallelEngine: controllerProps.getParallelEngine,
    eternalLoopRunningRef,
    parallelLoopRunningRef,
    switchAutonomy: controllerProps.switchAutonomy,
    getSddRun: controllerProps.getSddRun,
    confirmExitRef,
    historyScrollRef,
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
    statuslineHiddenItems: controllerProps.statuslineHiddenItems,
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
    closeMailboxPanel: mailbox.mailboxPanelOpen
      ? () => mailbox.setMailboxPanelOpen(false)
      : undefined,
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
  });
}
