import { describe, expect, it } from 'vitest';
import { DELEGATION_LIMIT, delegationTotals } from '../src/delegations';
import { emptyEngineState, reduceEngine } from '../src/engine-state';

const start = reduceEngine(emptyEngineState, {
  type: 'session.start',
  payload: { sessionId: 's1', provider: 'p', model: 'm' },
});
const done = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'delegate.completed',
  payload: {
    sessionId: 's1',
    delegationId: id,
    target: 'reviewer',
    task: 'Review the diff',
    ok: true,
    summary: 'No issues',
    durationMs: 30_000,
    iterations: 4,
    toolCalls: 7,
    ...extra,
  },
});

describe('worker delegations', () => {
  it('keeps finished delegations once each and totals only known costs', () => {
    let state = reduceEngine(start, done('d1', { costUsd: 0.12 }));
    state = reduceEngine(state, done('d1', { costUsd: 0.12 }));
    state = reduceEngine(state, done('d2', { ok: false, status: 'timeout' }));
    state = reduceEngine(state, done('other', { sessionId: 's2' }));
    expect(state.delegations.map((item) => item.id)).toEqual(['d1', 'd2']);
    expect(delegationTotals(state.delegations)).toEqual({
      count: 2,
      failed: 1,
      toolCalls: 14,
      durationMs: 60_000,
      costUsd: 0.12,
      unpriced: 1,
    });
    expect(delegationTotals([state.delegations[1]!]).costUsd).toBeNull();
  });
  it('bounds the list and clears it on a reset', () => {
    let state = start;
    for (let index = 0; index < DELEGATION_LIMIT + 4; index++)
      state = reduceEngine(state, done(`d${index}`));
    expect(state.delegations).toHaveLength(DELEGATION_LIMIT);
    state = reduceEngine(state, {
      type: 'session.start',
      payload: { sessionId: 's1', provider: 'p', model: 'm', reset: true },
    });
    expect(state.delegations).toEqual([]);
  });
});
