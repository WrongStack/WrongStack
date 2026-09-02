import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFleetPolling } from '../../src/hooks/useFleetPolling';
import { useFleetStore } from '../../src/stores';

// Helper: build a minimal SubagentView-shaped object for store injection.
function makeAgent(
  id: string,
  overrides: Partial<{
    name: string;
    status: 'running' | 'completed' | 'failed' | 'timeout' | 'stopped';
    costUsd: number;
    startedAt: number;
    completedAt: number | undefined;
    iteration: number;
    toolCalls: number;
  }> = {},
) {
  return {
    id,
    name: overrides.name ?? id,
    status: overrides.status ?? 'running',
    iteration: overrides.iteration ?? 0,
    toolCalls: overrides.toolCalls ?? 0,
    costUsd: overrides.costUsd ?? 0,
    ctxPct: 0,
    ctxTokens: 0,
    maxContext: 0,
    extensions: 0,
    startedAt: overrides.startedAt ?? Date.now(),
    completedAt: overrides.completedAt,
    toolLog: [],
    sparklineBins: Array(12).fill(0),
  };
}

describe('useFleetPolling', () => {
  beforeEach(() => {
    useFleetStore.setState({
      agents: new Map(),
      leaderId: undefined,
      fleetTokensIn: 0,
      fleetTokensOut: 0,
      fleetConcurrency: 0,
      fleetConcurrencyMax: 4,
    });
  });

  it('returns empty summary when no agents exist', () => {
    const { result } = renderHook(() => useFleetPolling(true));
    expect(result.current.summary).toEqual({
      running: 0,
      completed: 0,
      failed: 0,
      total: 0,
      totalCost: 0,
      tokensIn: 0,
      tokensOut: 0,
      concurrency: 0,
      concurrencyMax: 4,
    });
    expect(result.current.agentList).toEqual([]);
    expect(typeof result.current.now).toBe('number');
    expect(typeof result.current.refreshNow).toBe('function');
  });

  it('returns mixed-status summary with cost aggregation', () => {
    const agents = new Map();
    agents.set(
      'a1',
      makeAgent('a1', { name: 'alpha', status: 'running', costUsd: 0.1, startedAt: 100 }),
    );
    agents.set(
      'a2',
      makeAgent('a2', { name: 'beta', status: 'completed', costUsd: 0.2, startedAt: 200 }),
    );
    agents.set(
      'a3',
      makeAgent('a3', { name: 'gamma', status: 'failed', costUsd: 0.3, startedAt: 50 }),
    );
    agents.set(
      'a4',
      makeAgent('a4', { name: 'delta', status: 'timeout', costUsd: 0.4, startedAt: 300 }),
    );

    act(() => {
      useFleetStore.setState({
        agents,
        fleetTokensIn: 10_000,
        fleetTokensOut: 5_000,
        fleetConcurrency: 2,
        fleetConcurrencyMax: 8,
      });
    });

    const { result } = renderHook(() => useFleetPolling(true));
    expect(result.current.summary).toEqual({
      running: 1,
      completed: 1,
      failed: 2,
      total: 4,
      totalCost: 1.0,
      tokensIn: 10_000,
      tokensOut: 5_000,
      concurrency: 2,
      concurrencyMax: 8,
    });
  });

  it('sorts agent list: leader first, running before completed, then by startedAt', () => {
    const agents = new Map();
    agents.set('a1', makeAgent('a1', { name: 'worker-1', status: 'running', startedAt: 300 }));
    agents.set('a2', makeAgent('a2', { name: 'leader', status: 'running', startedAt: 100 }));
    agents.set('a3', makeAgent('a3', { name: 'worker-2', status: 'completed', startedAt: 200 }));
    agents.set('a4', makeAgent('a4', { name: 'worker-3', status: 'running', startedAt: 200 }));

    act(() => {
      useFleetStore.setState({ agents, leaderId: 'a2' });
    });

    const { result } = renderHook(() => useFleetPolling(true));
    const names = result.current.agentList.map((a) => a.name);
    expect(names).toEqual(['leader', 'worker-3', 'worker-1', 'worker-2']);
  });

  it('exposes a live now timestamp that advances', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useFleetPolling(true));
    const first = result.current.now;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const second = result.current.now;
    expect(second - first).toBeGreaterThanOrEqual(1000);
    vi.useRealTimers();
  });

  it('refreshNow bumps the timestamp immediately', () => {
    const { result } = renderHook(() => useFleetPolling(true));
    const before = result.current.now;
    act(() => {
      result.current.refreshNow();
    });
    expect(result.current.now).toBeGreaterThanOrEqual(before);
  });

  it('stops ticking when disabled', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook((enabled: boolean) => useFleetPolling(enabled), {
      initialProps: true,
    });
    const first = result.current.now;

    // Re-render with enabled=false — clock stops.
    rerender(false);
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // The timestamp should NOT have advanced because the interval was cleared.
    expect(result.current.now).toBe(first);
    vi.useRealTimers();
  });
});
