import type React from 'react';
import type { AppProps } from './app-props.js';
import { AppView } from './app-view.js';
import { UserInputPrompt } from './components/user-input-prompt.js';
import { LiveStreamContext, liveStreamStoreOf } from './live-stream-store.js';
import { useAppController } from './use-app-controller.js';

export { buildGoalPreamble } from '@wrongstack/core/execution';
export type { AppProps } from './app-props.js';
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
export { buildSteeringPreamble } from './steering-preamble.js';

export function App(props0: AppProps): React.ReactElement {
  const {
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
    coordinatorRunning,
    enhanceDelayMs,
    layoutStore,
  } = useAppController(props0);

  if (pendingUserInput)
    return <UserInputPrompt pending={pendingUserInput} onInterrupt={runInterruptLadder} />;

  return (
    <LiveStreamContext.Provider value={liveStreamStoreOf(dispatch)}>
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
          coordinatorRunning,
          enhanceDelayMs,
          layoutStore,
        }}
      />
    </LiveStreamContext.Provider>
  );
}
