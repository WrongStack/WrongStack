import { render } from 'ink-testing-library';
import React, { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBrainPanel } from '../src/hooks/use-brain-panel.js';
import { Text } from '../src/ink.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeSettings() {
  return {
    mode: 'interactive' as const,
    riskLevel: 'medium' as const,
    strategy: 'fallback' as const,
    pool: ['gpt-4'],
    poolResolved: ['gpt-4'],
    usingSessionModel: false,
    councilEnabled: false,
    councilMinRisk: 'medium' as const,
    councilDistinctness: 'none' as const,
    councilQuorum: undefined,
    councilApproval: undefined,
    councilPerCallTimeoutMs: undefined,
    councilMaxConcurrency: undefined,
    councilJudgeMaxTokens: undefined,
    voters: [],
    councilSeats: [],
    ledgerEnabled: false,
    decisionTimeoutMs: undefined,
    humanTimeoutMs: undefined,
    judgeLabel: undefined,
    autoDenyAfterFailures: undefined,
  };
}

function createHarness() {
  const dispatch = vi.fn();
  const brainPanelHost = {
    getSettings: vi.fn().mockReturnValue(fakeSettings()),
    setMode: vi.fn().mockResolvedValue(null as string | null),
    setRisk: vi.fn().mockResolvedValue(null as string | null),
    setStrategy: vi.fn().mockResolvedValue(null as string | null),
    setDecisionTimeout: vi.fn().mockResolvedValue(null as string | null),
    setHumanTimeout: vi.fn().mockResolvedValue(null as string | null),
    addPoolModel: vi.fn().mockResolvedValue(null as string | null),
    removePoolModel: vi.fn().mockResolvedValue(null as string | null),
    clearPool: vi.fn().mockResolvedValue(null as string | null),
    setCouncilEnabled: vi.fn().mockResolvedValue(null as string | null),
    setCouncilMinRisk: vi.fn().mockResolvedValue(null as string | null),
    addVoter: vi.fn().mockResolvedValue(null as string | null),
    removeVoter: vi.fn().mockResolvedValue(null as string | null),
    cycleVoterPersona: vi.fn().mockResolvedValue(null as string | null),
    toggleVoterVeto: vi.fn().mockResolvedValue(null as string | null),
    setJudge: vi.fn().mockResolvedValue(null as string | null),
    clearJudge: vi.fn().mockResolvedValue(null as string | null),
    setCouncilQuorum: vi.fn().mockResolvedValue(null as string | null),
    setCouncilApproval: vi.fn().mockResolvedValue(null as string | null),
    setCouncilDistinctness: vi.fn().mockResolvedValue(null as string | null),
    setCouncilPerCallTimeout: vi.fn().mockResolvedValue(null as string | null),
    setCouncilMaxConcurrency: vi.fn().mockResolvedValue(null as string | null),
    setCouncilJudgeMaxTokens: vi.fn().mockResolvedValue(null as string | null),
    setCouncilVoterMaxTokens: vi.fn().mockResolvedValue(null as string | null),
    setCouncilDeliberationRounds: vi.fn().mockResolvedValue(null as string | null),
    setLedgerEnabled: vi.fn().mockResolvedValue(null as string | null),
    setAutoDeny: vi.fn().mockResolvedValue(null as string | null),
    setTerminalPolicy: vi.fn().mockResolvedValue(null as string | null),
    setHeuristic: vi.fn().mockResolvedValue(null as string | null),
    setLlmMaxTokens: vi.fn().mockResolvedValue(null as string | null),
    setLlmRejectUncertain: vi.fn().mockResolvedValue(null as string | null),
    setLlmMinConfidence: vi.fn().mockResolvedValue(null as string | null),
    setLlmDenyIsTerminal: vi.fn().mockResolvedValue(null as string | null),
    setCacheEnabled: vi.fn().mockResolvedValue(null as string | null),
    setCacheTtl: vi.fn().mockResolvedValue(null as string | null),
    setCacheMaxEntries: vi.fn().mockResolvedValue(null as string | null),
    setTraceEnabled: vi.fn().mockResolvedValue(null as string | null),
    setTraceContent: vi.fn().mockResolvedValue(null as string | null),
  };

  const getBrainData = vi.fn().mockReturnValue({
    riskLevel: 'medium' as const,
    log: [{ kind: 'tool', question: 'Allow?', outcome: 'yes', age: '30s' }],
  });

  const requestModelPick = vi.fn().mockResolvedValue(null);

  let controller: ReturnType<typeof useBrainPanel> | undefined;

  function Harness(): React.ReactElement {
    const ctrl = useBrainPanel({ dispatch, getBrainData, brainPanelHost, requestModelPick });
    useEffect(() => {
      controller = ctrl;
    }, [ctrl]);
    return React.createElement(Text, null, 'test');
  }

  const view = render(React.createElement(Harness));
  return {
    get controller() {
      if (!controller) throw new Error('Controller not mounted');
      return controller;
    },
    dispatch,
    brainPanelHost,
    getBrainData,
    requestModelPick,
    view,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useBrainPanel', () => {
  it('openBrainPanel dispatches brainOpen with data', () => {
    const harness = createHarness();
    harness.controller.openBrainPanel();
    expect(harness.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'brainOpen', riskLevel: 'medium' }),
    );
    expect(harness.getBrainData).toHaveBeenCalled();
    harness.view.unmount();
  });

  it('openBrainPanel is a no-op without getBrainData', () => {
    const dispatch = vi.fn();
    let controller: ReturnType<typeof useBrainPanel> | undefined;
    function Harness(): React.ReactElement {
      const ctrl = useBrainPanel({
        dispatch,
        getBrainData: undefined,
        brainPanelHost: undefined,
        requestModelPick: undefined,
      });
      useEffect(() => {
        controller = ctrl;
      }, [ctrl]);
      return React.createElement(Text, null, 'test');
    }
    const view = render(React.createElement(Harness));
    controller?.openBrainPanel();
    expect(dispatch).not.toHaveBeenCalled();
    view.unmount();
  });

  it('handleBrainDelete removes pool model', async () => {
    const harness = createHarness();
    harness.controller.handleBrainDelete({ kind: 'poolModel', index: 0 });
    // Should call runBrainMutation which calls removePoolModel
    expect(harness.brainPanelHost.removePoolModel).toHaveBeenCalledWith(0);
    harness.view.unmount();
  });

  it('handleBrainDelete removes voter', () => {
    const harness = createHarness();
    harness.controller.handleBrainDelete({ kind: 'voter', index: 1 });
    expect(harness.brainPanelHost.removeVoter).toHaveBeenCalledWith(1);
    harness.view.unmount();
  });

  it('handleBrainDelete clears judge', () => {
    const harness = createHarness();
    harness.controller.handleBrainDelete({ kind: 'judge' });
    expect(harness.brainPanelHost.clearJudge).toHaveBeenCalled();
    harness.view.unmount();
  });

  it('handleBrainDelete is a no-op without host', () => {
    const dispatch = vi.fn();
    let controller: ReturnType<typeof useBrainPanel> | undefined;
    function Harness(): React.ReactElement {
      const ctrl = useBrainPanel({
        dispatch,
        getBrainData: vi.fn(),
        brainPanelHost: undefined,
        requestModelPick: undefined,
      });
      useEffect(() => {
        controller = ctrl;
      }, [ctrl]);
      return React.createElement(Text, null, 'test');
    }
    const view = render(React.createElement(Harness));
    controller?.handleBrainDelete({ kind: 'poolModel', index: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    view.unmount();
  });

  it('handleBrainVoterMod cycles persona when host available', () => {
    const harness = createHarness();
    harness.controller.handleBrainVoterMod(0, 'persona');
    expect(harness.brainPanelHost.cycleVoterPersona).toHaveBeenCalledWith(0);
    harness.view.unmount();
  });

  it('handleBrainVoterMod toggles veto', () => {
    const harness = createHarness();
    harness.controller.handleBrainVoterMod(0, 'veto');
    expect(harness.brainPanelHost.toggleVoterVeto).toHaveBeenCalledWith(0);
    harness.view.unmount();
  });
});
