import { useCallback } from 'react';
import { leaderTimelineFromEntries } from '../components/agents-monitor.js';
import { useClientTelemetry } from './use-client-telemetry.js';
import { useDirectorFleetBridge } from './use-director-fleet-bridge.js';
import { useExitCommand } from './use-exit-command.js';
import { useProviderEventBridge } from './use-provider-event-bridge.js';
import { useSessionInterruptController } from './use-session-interrupt-controller.js';
import { useTuiControllers } from './use-tui-controllers.js';
import { useTuiEventBridge } from './use-tui-event-bridge.js';

export function useAppEventBridges(params: {
  events: any;
  agent: any;
  dispatch: any;
  streamingTextRef: any;
  streamSegmentsRef: any;
  pendingDeltaRef: any;
  flushTimerRef: any;
  sessionGenerationRef: any;
  activeRunGenerationRef: any;
  assistantCommittedThisRunRef: any;
  setMemoryContextMonitor: any;
  clientId: any;
  tokenCounter: any;
  getAutonomy: any;
  registerDebugStreamCallback: any;
  restoreDebugStreamCallback: any;
  stateRef: any;
  setActiveMaxContext: any;
  subscribeGoal: any;
  onClearHistory: any;
  fleetChat: any;
  enhanceEnabled: boolean;
  agentsMonitorOpen: boolean;
  fleetStreamController: any;
  enhanceController: any;
  agentsMonitorController: any;
  interruptController: any;
  activeCtrlRef: any;
  activeRunSettledRef: any;
  eternalLoopRunningRef: any;
  parallelLoopRunningRef: any;
  tokenPreviewsRef: any;
  clearPendingConfirms: () => void;
  getEternalEngine: any;
  getParallelEngine: any;
  getSddRun: any;
  switchAutonomy: any;
  slashRegistry: any;
  exitConfirm: any;
  liveDirector: any;
  director: any;
}) {
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
