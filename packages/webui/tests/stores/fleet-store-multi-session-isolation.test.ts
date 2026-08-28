import { beforeEach, describe, expect, it } from 'vitest';
import {
  selectSessionFleetTotals,
  selectSessionLeaderId,
  summarizeTab,
  useFleetStore,
  useSessionTabStore,
  useUIStore,
} from '../../src/stores';
import { SESSION_DEFAULT_LANE_ID, useSessionLanes } from '../../src/stores/session-lanes.js';

const fleet = () => useFleetStore.getState();

beforeEach(() => {
  fleet().clear();
  useSessionTabStore.setState({ openTabIds: [], lastSeenCounts: {}, attention: {} });
  useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  useUIStore.setState({ sessionNicknames: {} });
});

describe('multi-session fleet isolation', () => {
  it('session_stopped removes only target session agents and preserves other sessions tokens and leader', () => {
    // Session 1 setup
    fleet().applyEvent({
      kind: 'spawned',
      subagentId: 'a1_s1',
      name: 'Agent S1 Leader',
      sessionId: 'sess-1',
    });
    fleet().applyEvent({
      kind: 'leader_updated',
      subagentId: 'a1_s1',
      sessionId: 'sess-1',
    });
    fleet().applyEvent({
      kind: 'ctx_pct',
      subagentId: 'a1_s1',
      sessionId: 'sess-1',
      tokens: 100,
      tokensIn: 500,
      tokensOut: 200,
    });

    // Session 2 setup
    fleet().applyEvent({
      kind: 'spawned',
      subagentId: 'a1_s2',
      name: 'Agent S2 Leader',
      sessionId: 'sess-2',
    });
    fleet().applyEvent({
      kind: 'leader_updated',
      subagentId: 'a1_s2',
      sessionId: 'sess-2',
    });
    fleet().applyEvent({
      kind: 'ctx_pct',
      subagentId: 'a1_s2',
      sessionId: 'sess-2',
      tokens: 150,
      tokensIn: 1000,
      tokensOut: 400,
    });

    expect(fleet().agents.size).toBe(2);
    expect(fleet().fleetTokensIn).toBe(1500);
    expect(fleet().fleetTokensOut).toBe(600);
    expect(fleet().leaderId).toBe('a1_s2');

    // Stop session 1
    fleet().applyEvent({
      kind: 'session_stopped',
      sessionId: 'sess-1',
    });

    // Session 1 agents should be removed
    expect(fleet().agents.has('a1_s1')).toBe(false);
    // Session 2 agents should remain
    expect(fleet().agents.has('a1_s2')).toBe(true);

    // Tokens for session 2 should be preserved (1000 In, 400 Out)
    expect(fleet().fleetTokensIn).toBe(1000);
    expect(fleet().fleetTokensOut).toBe(400);

    // Leader for session 2 should NOT be reset to undefined
    expect(fleet().leaderId).toBe('a1_s2');
    expect(selectSessionLeaderId(fleet(), 'sess-2')).toBe('a1_s2');
    expect(selectSessionLeaderId(fleet(), 'sess-1')).toBeUndefined();
  });

  it('selectSessionLeaderId does not leak another tabs leader when sessionId is undefined or different', () => {
    fleet().applyEvent({
      kind: 'spawned',
      subagentId: 'leader_tab2',
      name: 'Leader Tab 2',
      sessionId: 'tab-2-id',
    });
    fleet().applyEvent({
      kind: 'leader_updated',
      subagentId: 'leader_tab2',
      sessionId: 'tab-2-id',
    });

    // Asking for tab-1 should yield undefined
    expect(selectSessionLeaderId(fleet(), 'tab-1-id')).toBeUndefined();
    // Asking without a sessionId should not return tab-2's leader
    expect(selectSessionLeaderId(fleet(), undefined)).toBeUndefined();
    // Asking for tab-2 should return tab-2's leader
    expect(selectSessionLeaderId(fleet(), 'tab-2-id')).toBe('leader_tab2');
  });

  it('selectSessionFleetTotals correctly separates per-session statistics', () => {
    fleet().applyEvent({
      kind: 'spawned',
      subagentId: 'w1_s1',
      sessionId: 'sess-1',
    });
    fleet().applyEvent({
      kind: 'iteration_summary',
      subagentId: 'w1_s1',
      costUsd: 0.05,
    });
    fleet().applyEvent({
      kind: 'ctx_pct',
      subagentId: 'w1_s1',
      tokensIn: 300,
      tokensOut: 150,
    });

    fleet().applyEvent({
      kind: 'spawned',
      subagentId: 'w1_s2',
      sessionId: 'sess-2',
    });
    fleet().applyEvent({
      kind: 'iteration_summary',
      subagentId: 'w1_s2',
      costUsd: 0.12,
    });
    fleet().applyEvent({
      kind: 'ctx_pct',
      subagentId: 'w1_s2',
      tokensIn: 800,
      tokensOut: 400,
    });

    const s1Totals = selectSessionFleetTotals(fleet(), 'sess-1');
    const s2Totals = selectSessionFleetTotals(fleet(), 'sess-2');

    expect(s1Totals.tokensIn).toBe(300);
    expect(s1Totals.tokensOut).toBe(150);
    expect(s1Totals.totalCost).toBeCloseTo(0.05);

    expect(s2Totals.tokensIn).toBe(800);
    expect(s2Totals.tokensOut).toBe(400);
    expect(s2Totals.totalCost).toBeCloseTo(0.12);
  });

  it('summarizeTab honors sessionNicknames in title', () => {
    useUIStore.getState().setSessionNickname('sess-abc', 'My Custom Workflow');
    const summary = summarizeTab('sess-abc', 0);
    expect(summary.title).toBe('My Custom Workflow');
  });

  it('closeTab releases fleet agents and transcripts for the closed session', () => {
    // Open a tab and spawn agents for it
    useSessionTabStore.getState().openTab('sess-close-test');
    fleet().applyEvent({
      kind: 'spawned',
      subagentId: 'agent_to_close',
      sessionId: 'sess-close-test',
      name: 'Temporary Agent',
    });
    fleet().pushAgentTimelineEntry({
      subagentId: 'agent_to_close',
      agentName: 'Temporary Agent',
      content: 'thinking...',
      kind: 'thinking',
      iteration: 1,
      ts: '2026-08-28T00:00:00Z',
    });

    expect(fleet().agents.has('agent_to_close')).toBe(true);
    expect(fleet().getAgentTranscript('agent_to_close').length).toBeGreaterThan(0);

    // Close the tab
    useSessionTabStore.getState().closeTab('sess-close-test');

    // Agent and transcript should be pruned from fleet store
    expect(fleet().agents.has('agent_to_close')).toBe(false);
    expect(fleet().getAgentTranscript('agent_to_close')).toEqual([]);
  });
});
