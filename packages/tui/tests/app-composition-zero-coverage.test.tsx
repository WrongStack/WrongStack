// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  leaderTimelineFromEntries: vi.fn(),
  useProviderEventBridge: vi.fn(),
  useClientTelemetry: vi.fn(),
  useTuiEventBridge: vi.fn(),
  useTuiControllers: vi.fn(),
  useSessionInterruptController: vi.fn(),
  useExitCommand: vi.fn(),
  useDirectorFleetBridge: vi.fn(),
  usePromptPicker: vi.fn(),
  useModePicker: vi.fn(),
  useModelPickRequest: vi.fn(),
  useBrainPanel: vi.fn(),
  useBrainRiskSync: vi.fn(),
  useShadowPanel: vi.fn(),
  useHelpPanel: vi.fn(),
  useStatuslineHiddenSync: vi.fn(),
  useStreamChipExpiration: vi.fn(),
  useAutonomousCoordinator: vi.fn(),
}));

vi.mock('../src/components/agents-monitor.js', () => ({
  leaderTimelineFromEntries: mocks.leaderTimelineFromEntries,
}));
vi.mock('../src/hooks/use-provider-event-bridge.js', () => ({
  useProviderEventBridge: mocks.useProviderEventBridge,
}));
vi.mock('../src/hooks/use-client-telemetry.js', () => ({
  useClientTelemetry: mocks.useClientTelemetry,
}));
vi.mock('../src/hooks/use-tui-event-bridge.js', () => ({
  useTuiEventBridge: mocks.useTuiEventBridge,
}));
vi.mock('../src/hooks/use-tui-controllers.js', () => ({
  useTuiControllers: mocks.useTuiControllers,
}));
vi.mock('../src/hooks/use-session-interrupt-controller.js', () => ({
  useSessionInterruptController: mocks.useSessionInterruptController,
}));
vi.mock('../src/hooks/use-exit-command.js', () => ({ useExitCommand: mocks.useExitCommand }));
vi.mock('../src/hooks/use-director-fleet-bridge.js', () => ({
  useDirectorFleetBridge: mocks.useDirectorFleetBridge,
}));
vi.mock('../src/hooks/use-prompt-picker.js', () => ({ usePromptPicker: mocks.usePromptPicker }));
vi.mock('../src/hooks/use-mode-picker.js', () => ({ useModePicker: mocks.useModePicker }));
vi.mock('../src/hooks/use-model-pick.js', () => ({
  useModelPickRequest: mocks.useModelPickRequest,
}));
vi.mock('../src/hooks/use-brain-panel.js', () => ({ useBrainPanel: mocks.useBrainPanel }));
vi.mock('../src/hooks/use-brain-risk-sync.js', () => ({
  useBrainRiskSync: mocks.useBrainRiskSync,
}));
vi.mock('../src/hooks/use-shadow-panel.js', () => ({ useShadowPanel: mocks.useShadowPanel }));
vi.mock('../src/hooks/use-help-panel.js', () => ({ useHelpPanel: mocks.useHelpPanel }));
vi.mock('../src/hooks/use-statusline-hidden-sync.js', () => ({
  useStatuslineHiddenSync: mocks.useStatuslineHiddenSync,
}));
vi.mock('../src/hooks/use-stream-chip-expiration.js', () => ({
  useStreamChipExpiration: mocks.useStreamChipExpiration,
}));
vi.mock('../src/hooks/use-autonomous-coordinator.js', () => ({
  useAutonomousCoordinator: mocks.useAutonomousCoordinator,
}));

import { useAppEventBridges } from '../src/hooks/use-app-event-bridges.js';
import { useAppPanelsState } from '../src/hooks/use-app-panels-state.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useAppEventBridges composition', () => {
  it('connects every bridge and exposes callbacks backed by current app state', () => {
    const entries = [{ kind: 'user', text: 'hello' }];
    const timeline = [{ kind: 'user', text: 'leader hello' }];
    mocks.leaderTimelineFromEntries.mockReturnValue(timeline);
    const params = {
      events: {},
      agent: { ctx: { session: { id: 'session-7' } } },
      dispatch: vi.fn(),
      streamingTextRef: { current: '' },
      streamSegmentsRef: { current: [] },
      pendingDeltaRef: { current: '' },
      flushTimerRef: { current: null },
      sessionGenerationRef: { current: 1 },
      activeRunGenerationRef: { current: 1 },
      assistantCommittedThisRunRef: { current: false },
      setMemoryContextMonitor: vi.fn(),
      clientId: 'client-1',
      tokenCounter: {},
      getAutonomy: vi.fn(),
      registerDebugStreamCallback: vi.fn(),
      restoreDebugStreamCallback: vi.fn(),
      stateRef: { current: { entries } },
      setActiveMaxContext: vi.fn(),
      subscribeGoal: vi.fn(),
      onClearHistory: vi.fn(),
      fleetChat: true,
      enhanceEnabled: true,
      agentsMonitorOpen: false,
      fleetStreamController: {},
      enhanceController: {},
      agentsMonitorController: {},
      interruptController: {},
      activeCtrlRef: { current: null },
      activeRunSettledRef: { current: null },
      eternalLoopRunningRef: { current: false },
      parallelLoopRunningRef: { current: false },
      tokenPreviewsRef: { current: [] },
      clearPendingConfirms: vi.fn(),
      getEternalEngine: vi.fn(),
      getParallelEngine: vi.fn(),
      getSddRun: vi.fn(),
      switchAutonomy: vi.fn(),
      slashRegistry: {},
      exitConfirm: {},
      liveDirector: vi.fn(),
      director: {},
    };

    // Every bridge hook is mocked above, so this composition test only needs
    // field identity — not real controllers. The hook's parameter type is the
    // intersection of the seven real hook contracts, so the stub is asserted
    // through it rather than restated.
    const { result } = renderHook(() =>
      useAppEventBridges(params as unknown as Parameters<typeof useAppEventBridges>[0]),
    );

    expect(mocks.useProviderEventBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        events: params.events,
        agent: params.agent,
        dispatch: params.dispatch,
      }),
    );
    expect(mocks.useClientTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client-1', tokenCounter: params.tokenCounter }),
    );
    const tuiOptions = mocks.useTuiEventBridge.mock.calls[0]?.[0];
    expect(tuiOptions.getSessionId()).toBe('session-7');
    expect(mocks.useTuiControllers).toHaveBeenCalledOnce();
    expect(mocks.useSessionInterruptController).toHaveBeenCalledOnce();
    expect(mocks.useExitCommand).toHaveBeenCalledWith(
      expect.objectContaining({ getDirector: params.liveDirector }),
    );
    expect(mocks.useDirectorFleetBridge).toHaveBeenCalledWith(
      expect.objectContaining({ director: params.director, chatMode: true }),
    );
    expect(result.current.getLeaderTranscript()).toBe(timeline);
    expect(mocks.leaderTimelineFromEntries).toHaveBeenCalledWith(entries);
  });
});

describe('useAppPanelsState composition', () => {
  it('wires panel hooks and returns their controllers', () => {
    const controls = {
      openPromptPicker: vi.fn(),
      setPromptFavorite: vi.fn(),
      openModePicker: vi.fn(),
      requestModelPick: vi.fn(),
      handleModelPicked: vi.fn(),
      openBrainPanel: vi.fn(),
      changeBrainRisk: vi.fn(),
      openShadowPanel: vi.fn(),
      handleShadowStart: vi.fn(),
      handleShadowStop: vi.fn(),
      openHelpPanel: vi.fn(),
    };
    mocks.usePromptPicker.mockReturnValue(controls);
    mocks.useModePicker.mockReturnValue(controls);
    mocks.useModelPickRequest.mockReturnValue(controls);
    const brainCtl = { openBrainPanel: controls.openBrainPanel };
    mocks.useBrainPanel.mockReturnValue(brainCtl);
    mocks.useBrainRiskSync.mockReturnValue(controls);
    mocks.useShadowPanel.mockReturnValue(controls);
    mocks.useHelpPanel.mockReturnValue(controls);
    const dispatch = vi.fn();
    const setHiddenItems = vi.fn();
    const subscribeCoordinatorEvents = vi.fn();
    const state = {
      modelPicker: { open: true },
      brainPanel: { riskLevel: 'balanced', open: true },
      statuslinePicker: { open: true, hiddenItems: ['cost'], visibleChips: ['brain'] },
      brainPrompt: { open: false },
      enhance: { open: false },
    };

    const { result } = renderHook(() =>
      useAppPanelsState({
        projectRoot: '/project',
        dispatch: dispatch as never,
        state: state as never,
        hiddenItems: ['model'],
        setHiddenItems,
        subscribeCoordinatorEvents,
        slashRegistry: { listWithOwner: () => [] } as never,
      }),
    );

    expect(mocks.useModelPickRequest).toHaveBeenCalledWith(
      expect.objectContaining({ dispatch, pickerOpen: true }),
    );
    expect(mocks.useBrainPanel).toHaveBeenCalledWith(
      expect.objectContaining({ requestModelPick: controls.requestModelPick }),
    );
    expect(mocks.useStatuslineHiddenSync).toHaveBeenCalledWith(
      expect.objectContaining({ pickerOpen: true, hiddenItems: ['model'] }),
    );
    const hiddenSync = mocks.useStatuslineHiddenSync.mock.calls[0]?.[0];
    hiddenSync.setHiddenItems(['cost']);
    expect(setHiddenItems).toHaveBeenCalledWith(['cost']);
    expect(mocks.useStreamChipExpiration).toHaveBeenCalledWith(
      expect.objectContaining({ visibleChips: ['brain'], dispatch }),
    );
    expect(mocks.useAutonomousCoordinator).toHaveBeenCalledWith(
      subscribeCoordinatorEvents,
      dispatch,
    );
    expect(result.current).toEqual({ ...controls, brainCtl });
  });
});
