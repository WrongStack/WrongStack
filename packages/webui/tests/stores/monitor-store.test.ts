import { beforeEach, describe, expect, it } from 'vitest';

import {
  clientBucket,
  deriveMonitorStats,
  type LiveSession,
  useMonitorStore,
} from '../../src/stores/monitor-store';

function session(partial: Partial<LiveSession> & { sessionId: string }): LiveSession {
  return { agents: [], ...partial };
}

describe('clientBucket', () => {
  it('maps surfaces to office-map buckets (cli/repl → repl)', () => {
    expect(clientBucket('tui')).toBe('tui');
    expect(clientBucket('webui')).toBe('webui');
    expect(clientBucket('cli')).toBe('repl');
    expect(clientBucket('repl')).toBe('repl');
  });

  it('defaults unknown surfaces to webui', () => {
    expect(clientBucket(undefined)).toBe('webui');
    expect(clientBucket('something-new')).toBe('webui');
  });
});

describe('deriveMonitorStats', () => {
  it('counts clients per surface and agents by activity', () => {
    const sessions: LiveSession[] = [
      session({
        sessionId: 'a',
        clientType: 'tui',
        agents: [
          { id: 'a1', name: 'A1', status: 'running' },
          { id: 'a2', name: 'A2', status: 'idle' },
        ],
      }),
      session({
        sessionId: 'b',
        clientType: 'tui',
        agents: [{ id: 'b1', name: 'B1', status: 'streaming' }],
      }),
      session({ sessionId: 'c', clientType: 'webui', agents: [] }),
      session({
        sessionId: 'd',
        clientType: 'cli',
        agents: [{ id: 'd1', name: 'D1', status: 'completed' }],
      }),
    ];

    const { clientCounts, totalAgents, activeAgents } = deriveMonitorStats(sessions);

    // Two TUIs (multi-client!), one WebUI, one CLI bucketed as repl.
    expect(clientCounts).toEqual({ tui: 2, webui: 1, repl: 1 });
    expect(totalAgents).toBe(4);
    // running + streaming are active; idle + completed are not.
    expect(activeAgents).toBe(2);
  });

  it('returns zeroed counts for an empty snapshot', () => {
    expect(deriveMonitorStats([])).toEqual({
      clientCounts: { tui: 0, webui: 0, repl: 0 },
      totalAgents: 0,
      activeAgents: 0,
      aggregate: { toolCalls: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 },
    });
  });

  it('aggregates tool calls + cost + tokens across all live agents', () => {
    const sessions: LiveSession[] = [
      session({
        sessionId: 'a',
        clientType: 'tui',
        agents: [
          {
            id: 'a1',
            name: 'A1',
            status: 'running',
            toolCalls: 40,
            costUsd: 0.12,
            tokensIn: 1000,
            tokensOut: 200,
          },
          {
            id: 'a2',
            name: 'A2',
            status: 'idle',
            toolCalls: 5,
            costUsd: 0.03,
            tokensIn: 100,
            tokensOut: 50,
          },
        ],
      }),
      session({
        sessionId: 'b',
        clientType: 'cli',
        agents: [
          {
            id: 'b1',
            name: 'B1',
            status: 'running',
            toolCalls: 79,
            costUsd: 0.25,
            tokensIn: 2000,
            tokensOut: 400,
          },
        ],
      }),
    ];
    const agg = deriveMonitorStats(sessions).aggregate;
    expect(agg.toolCalls).toBe(124);
    expect(agg.tokensIn).toBe(3100);
    expect(agg.tokensOut).toBe(650);
    expect(agg.costUsd).toBeCloseTo(0.4, 5);
  });
});

describe('useMonitorStore.setLiveSessions', () => {
  beforeEach(() => {
    useMonitorStore.getState().clear();
  });

  it('stores the snapshot and re-derives client/agent counts', () => {
    const sessions: LiveSession[] = [
      session({
        sessionId: 'x',
        clientType: 'webui',
        agents: [{ id: 'x1', name: 'X1', status: 'running' }],
      }),
      session({ sessionId: 'y', clientType: 'tui', agents: [] }),
    ];

    useMonitorStore.getState().setLiveSessions(sessions);

    const state = useMonitorStore.getState();
    expect(state.liveSessions).toHaveLength(2);
    expect(state.clientCounts).toEqual({ tui: 1, webui: 1, repl: 0 });
    expect(state.totalAgents).toBe(1);
    expect(state.activeAgents).toBe(1);
  });

  it('caps live agent context percentages at 100', () => {
    useMonitorStore.getState().setLiveSessions([
      session({
        sessionId: 'x',
        clientType: 'webui',
        agents: [{ id: 'x1', name: 'X1', status: 'running', ctxPct: 145 }],
      }),
    ]);

    const agent = useMonitorStore.getState().liveSessions[0]?.agents[0];
    expect(agent?.ctxPct).toBe(100);
  });

  it('clear() resets liveSessions and counts', () => {
    useMonitorStore.getState().setLiveSessions([
      session({
        sessionId: 'x',
        clientType: 'tui',
        agents: [{ id: 'x1', name: 'X1', status: 'running' }],
      }),
    ]);
    useMonitorStore.getState().clear();

    const state = useMonitorStore.getState();
    expect(state.liveSessions).toEqual([]);
    expect(state.clientCounts).toEqual({ tui: 0, webui: 0, repl: 0 });
    expect(state.totalAgents).toBe(0);
    expect(state.activeAgents).toBe(0);
  });
});
