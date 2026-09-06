import { useCallback } from 'react';
import { leaderTimelineFromEntries } from '../components/agents-monitor.js';
import { useClientTelemetry } from './use-client-telemetry.js';
import { useDirectorFleetBridge } from './use-director-fleet-bridge.js';
import { useExitCommand } from './use-exit-command.js';
import { useProviderEventBridge } from './use-provider-event-bridge.js';
import { useSessionInterruptController } from './use-session-interrupt-controller.js';
import { useTuiControllers } from './use-tui-controllers.js';
import { useTuiEventBridge } from './use-tui-event-bridge.js';

/**
 * This hook only fans its argument out to the seven bridge hooks below, so its
 * parameter type is *taken from* them rather than restated. The decomposition
 * that extracted it retyped all 38 fields as `any`, which silently unhooked
 * every one of those already-typed contracts at the single point where the
 * TUI wires them together.
 */
type AppEventBridgeParams = Parameters<typeof useProviderEventBridge>[0] &
  Parameters<typeof useClientTelemetry>[0] &
  Omit<Parameters<typeof useTuiEventBridge>[0], 'getSessionId'> &
  Parameters<typeof useTuiControllers>[0] &
  Parameters<typeof useSessionInterruptController>[0] &
  Omit<Parameters<typeof useExitCommand>[0], 'getDirector'> &
  Omit<Parameters<typeof useDirectorFleetBridge>[0], 'chatMode'> & {
    /** Passed to `useExitCommand` as `getDirector`. */
    liveDirector: Parameters<typeof useExitCommand>[0]['getDirector'];
    /** Passed to `useDirectorFleetBridge` as `chatMode`. */
    fleetChat: Parameters<typeof useDirectorFleetBridge>[0]['chatMode'];
  };

export function useAppEventBridges(params: AppEventBridgeParams) {
  const {
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
    clientId,
    tokenCounter,
    getAutonomy,
    registerDebugStreamCallback,
    restoreDebugStreamCallback,
    stateRef,
    setActiveMaxContext,
    subscribeGoal,
    onClearHistory,
    fleetChat,
    enhanceEnabled,
    agentsMonitorOpen,
    fleetStreamController,
    enhanceController,
    agentsMonitorController,
    interruptController,
    activeCtrlRef,
    activeRunSettledRef,
    eternalLoopRunningRef,
    parallelLoopRunningRef,
    tokenPreviewsRef,
    clearPendingConfirms,
    getEternalEngine,
    getParallelEngine,
    getSddRun,
    switchAutonomy,
    slashRegistry,
    exitConfirm,
    liveDirector,
    director,
  } = params;

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
    fleetChat,
    enhanceEnabled,
    agentsMonitorOpen,
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
    exitConfirm,
    stateRef,
    sessionGenerationRef,
    interruptController,
    getDirector: liveDirector,
  });

  useDirectorFleetBridge({
    director,
    dispatch,
    stateRef,
    chatMode: fleetChat,
    sessionGenerationRef,
  });

  return { getLeaderTranscript };
}
