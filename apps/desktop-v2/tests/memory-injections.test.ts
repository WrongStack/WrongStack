import { describe, expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { MEMORY_RUN_LIMIT } from '../src/memory-injections';

const start = reduceEngine(emptyEngineState, {
  type: 'session.start',
  payload: { sessionId: 's1', provider: 'p', model: 'm' },
});
const run = (runId: string, extra: Record<string, unknown> = {}) => ({
  type: 'memory.event',
  payload: {
    event: 'memory.injector_run',
    sessionId: 's1',
    runId,
    at: '2026-10-30T10:00:00.000Z',
    outcome: 'injected',
    trigger: 'tool_call',
    toolName: 'read',
    queryPreview: 'src/a.ts',
    candidates: 4,
    eligible: 2,
    thresholds: { minScore: 0.5, minImportance: 0.2, relationFloor: 0.1 },
    rejected: { duplicate: 0, belowScore: 2, alreadyVisible: 1, cooldown: 0, budget: 0 },
    injected: [{ id: 'm1', kind: 'decision', text: 'Use SQLite', score: 0.81 }],
    injectedChars: 120,
    ...extra,
  },
});

describe('memory injections in engine state', () => {
  it('keeps this conversation’s injector runs with what was injected and rejected', () => {
    const state = reduceEngine(start, run('r1'));
    expect(state.memoryRuns).toHaveLength(1);
    expect(state.memoryRuns[0]).toMatchObject({
      outcome: 'injected',
      toolName: 'read',
      minScore: 0.5,
      injected: [{ id: 'm1', kind: 'decision', text: 'Use SQLite', score: 0.81 }],
      rejected: [
        { gate: 'Below score', count: 2 },
        { gate: 'Already in context', count: 1 },
      ],
    });
  });
  it('ignores other sessions, duplicates and other memory events, within a bound', () => {
    let state = reduceEngine(start, run('other', { sessionId: 's2' }));
    state = reduceEngine(state, run('r1'));
    state = reduceEngine(state, run('r1'));
    state = reduceEngine(state, {
      type: 'memory.event',
      payload: { event: 'memory.injected', sessionId: 's1', memoryIds: ['m1'] },
    });
    expect(state.memoryRuns.map((item) => item.runId)).toEqual(['r1']);
    for (let index = 0; index < MEMORY_RUN_LIMIT + 5; index++)
      state = reduceEngine(state, run(`n${index}`));
    expect(state.memoryRuns).toHaveLength(MEMORY_RUN_LIMIT);
    expect(state.memoryRuns.at(-1)?.runId).toBe(`n${MEMORY_RUN_LIMIT + 4}`);
  });
  it('tracks the latest request context and clears both on a reset', () => {
    let state = reduceEngine(start, {
      type: 'memory.event',
      payload: {
        event: 'memory.context_snapshot',
        sessionId: 's1',
        at: '2026-10-30T10:01:00.000Z',
        activeMemoryIds: ['m1', 'm2'],
        enteredMemoryIds: ['m2'],
        exitedMemoryIds: [],
        reason: 'provider_request',
      },
    });
    state = reduceEngine(state, run('r1'));
    expect(state.memoryContext).toMatchObject({ active: ['m1', 'm2'], entered: ['m2'] });
    state = reduceEngine(state, {
      type: 'session.start',
      payload: { sessionId: 's1', provider: 'p', model: 'm', reset: true },
    });
    expect(state.memoryRuns).toEqual([]);
    expect(state.memoryContext).toBeNull();
  });
});
