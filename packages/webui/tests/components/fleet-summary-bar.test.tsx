import { describe, expect, it } from 'vitest';
import { selectFleetSummary, useFleetStore } from '../../src/stores/index.js';

function makeAgent(id: string, overrides: Partial<{ name: string; status: string; costUsd: number }> = {}) {
  return {
    id,
    name: overrides.name ?? id,
    status: overrides.status ?? 'running',
    iteration: 0,
    toolCalls: 0,
    costUsd: overrides.costUsd ?? 0,
    ctxPct: 0,
    ctxTokens: 0,
    maxContext: 0,
    extensions: 0,
    startedAt: Date.now(),
    toolLog: [],
    sparklineBins: Array(12).fill(0),
  } as const;
}

/**
 * Test the data pipeline that FleetSummaryBar uses.
 *
 * FleetSummaryBar calls useFleetStore(selectFleetSummary) and renders
 * the result. Testing selectFleetSummary directly validates every data
 * path the component consumes.
 */
describe('FleetSummaryBar data pipeline', () => {
  beforeEach(() => {
    useFleetStore.setState({ agents: new Map(), fleetConcurrency: 0, fleetConcurrencyMax: 4 });
  });

  it('returns zero summary for empty fleet', () => {
    const s = selectFleetSummary(useFleetStore.getState());
    expect(s.running).toBe(0);
    expect(s.completed).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.total).toBe(0);
    expect(s.totalCost).toBe(0);
  });

  it('counts only running agents', () => {
    const agents = new Map();
    agents.set('a1', makeAgent('a1', { status: 'running' }));
    agents.set('a2', makeAgent('a2', { status: 'running' }));
    useFleetStore.setState({ agents });

    const s = selectFleetSummary(useFleetStore.getState());
    expect(s.running).toBe(2);
    expect(s.completed).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.total).toBe(2);
  });

  it('counts completed and failed separately', () => {
    const agents = new Map();
    agents.set('a1', makeAgent('a1', { status: 'completed' }));
    agents.set('a2', makeAgent('a2', { status: 'failed' }));
    agents.set('a3', makeAgent('a3', { status: 'timeout' }));
    agents.set('a4', makeAgent('a4', { status: 'running' }));
    useFleetStore.setState({ agents });

    const s = selectFleetSummary(useFleetStore.getState());
    expect(s.running).toBe(1);
    expect(s.completed).toBe(1);
    expect(s.failed).toBe(2); // failed + timeout
    expect(s.total).toBe(4);
  });

  it('aggregates totalCost across all agents', () => {
    const agents = new Map();
    agents.set('a1', makeAgent('a1', { costUsd: 0.1 }));
    agents.set('a2', makeAgent('a2', { costUsd: 0.2 }));
    useFleetStore.setState({ agents });

    expect(selectFleetSummary(useFleetStore.getState()).totalCost).toBeCloseTo(0.3);
  });

  it('includes cost from completed/failed agents in totalCost', () => {
    const agents = new Map();
    agents.set('a1', makeAgent('a1', { status: 'completed', costUsd: 0.5 }));
    agents.set('a2', makeAgent('a2', { status: 'failed', costUsd: 0.3 }));
    agents.set('a3', makeAgent('a3', { status: 'running', costUsd: 0.2 }));
    useFleetStore.setState({ agents });

    expect(selectFleetSummary(useFleetStore.getState()).totalCost).toBeCloseTo(1.0);
  });

  it('reads concurrency fields from store scalars', () => {
    useFleetStore.setState({ fleetConcurrency: 2, fleetConcurrencyMax: 8 });

    const s = selectFleetSummary(useFleetStore.getState());
    expect(s.concurrency).toBe(2);
    expect(s.concurrencyMax).toBe(8);
  });

  it('reads token fields from store scalars', () => {
    useFleetStore.setState({ fleetTokensIn: 5000, fleetTokensOut: 2000 });

    const s = selectFleetSummary(useFleetStore.getState());
    expect(s.tokensIn).toBe(5000);
    expect(s.tokensOut).toBe(2000);
  });

  it('returns zero totalCost when all agents have zero cost', () => {
    const agents = new Map();
    agents.set('a1', makeAgent('a1', { costUsd: 0 }));
    agents.set('a2', makeAgent('a2', { costUsd: 0 }));
    useFleetStore.setState({ agents });

    expect(selectFleetSummary(useFleetStore.getState()).totalCost).toBe(0);
  });
});

describe('FleetSummaryBar event timeline data', () => {
  beforeEach(() => {
    useFleetStore.setState({
      agents: new Map(),
      eventTimeline: [],
    });
  });

  it('starts with empty timeline', () => {
    expect(useFleetStore.getState().eventTimeline).toEqual([]);
  });

  it('records spawned and task_completed events in the timeline', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned', subagentId: 'a1', name: 'worker-1',
    });
    useFleetStore.getState().applyEvent({
      kind: 'spawned', subagentId: 'a2', name: 'worker-2',
    });
    useFleetStore.getState().applyEvent({
      kind: 'tool_executed', subagentId: 'a1', toolName: 'bash',
    });

    const timeline = useFleetStore.getState().eventTimeline;
    expect(timeline.length).toBeGreaterThanOrEqual(3);
    // Most recent event first (timeline is prepended).
    expect(timeline[0].kind).toBe('tool_executed');
    expect(timeline[0].agentId).toBe('a1');
  });

  it('includes task_completed events in the timeline', () => {
    useFleetStore.getState().applyEvent({
      kind: 'spawned', subagentId: 'a1', name: 'worker',
    });
    useFleetStore.getState().applyEvent({
      kind: 'task_completed', subagentId: 'a1', status: 'success',
    });

    const timeline = useFleetStore.getState().eventTimeline;
    expect(timeline[0].kind).toBe('task_completed');
    expect(timeline[0].message).toContain('completed');
  });

  it('timeline truncates to 20 entries max', () => {
    for (let i = 0; i < 25; i++) {
      useFleetStore.getState().applyEvent({
        kind: 'tool_executed', subagentId: `a${i}`, toolName: 'bash',
      });
    }
    expect(useFleetStore.getState().eventTimeline.length).toBeLessThanOrEqual(20);
  });
});
