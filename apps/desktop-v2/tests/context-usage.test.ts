import { describe, expect, it } from 'vitest';
import { cacheHitPercent, contextPercent, contextZone, formatTokens } from '../src/context-usage';
import { emptyEngineState, reduceEngine } from '../src/engine-state';

const frames = (sessionId: string, list: Array<[string, Record<string, unknown>]>) =>
  list.map(([type, payload]) => ({ type, payload: { sessionId, ...payload } }));

describe('context usage under the chat', () => {
  it('follows the latest request in event order, with cache share and session totals', () => {
    let state = emptyEngineState;
    for (const event of frames('s1', [
      ['session.start', { provider: 'p', model: 'm', maxContext: 200000 }],
      ['ctx.pct', { tokens: 50000, maxContext: 0, load: 0 }],
      [
        'provider.response',
        { usage: { input: 20000, cacheRead: 100000, cacheWrite: 10000, output: 900 } },
      ],
      ['provider.response', { usage: { input: 1000, output: 100 }, agentId: 'worker-1' }],
    ]))
      state = reduceEngine(state, event);
    expect(state.context).toMatchObject({ tokens: 130000, max: 200000, responses: 1 });
    expect(contextPercent(state.context)).toBe(65);
    expect(contextZone(contextPercent(state.context))).toBe('warn');
    expect(cacheHitPercent(state.context)).toBe(77);
    expect(state.context.totals).toEqual({
      input: 20000,
      output: 900,
      cacheRead: 100000,
      cacheWrite: 10000,
    });
    // A compaction lowers the window use to the request size it reports.
    state = reduceEngine(state, {
      type: 'context.compacted',
      payload: {
        sessionId: 's1',
        before: 90000,
        after: 30000,
        saved: 60000,
        fullRequestTokensAfter: 41000,
      },
    });
    expect(state.context.tokens).toBe(41000);
    expect(state.context.compaction).toEqual({ before: 90000, after: 30000, saved: 60000 });
    expect(contextZone(contextPercent(state.context))).toBe('ok');
  });
  it('records a provider limit below the configured window until it is reset', () => {
    let state = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 's1', maxContext: 200000 },
    });
    state = reduceEngine(state, {
      type: 'ctx.max_context',
      payload: {
        sessionId: 's1',
        maxContext: 128000,
        previousMaxContext: 200000,
        source: 'provider',
        decreased: true,
      },
    });
    expect(state.context).toMatchObject({ max: 128000, decreasedFrom: 200000 });
    state = reduceEngine(state, {
      type: 'ctx.max_context',
      payload: { sessionId: 's1', maxContext: 200000, source: 'configured' },
    });
    expect(state.context).toMatchObject({ max: 200000, decreasedFrom: 0 });
  });
  it('ignores another conversation and leaves unknown windows unknown', () => {
    const state = reduceEngine(
      reduceEngine(emptyEngineState, { type: 'session.start', payload: { sessionId: 's1' } }),
      { type: 'ctx.pct', payload: { sessionId: 's2', tokens: 9000, maxContext: 10000 } },
    );
    expect(state.context.tokens).toBe(0);
    expect(contextPercent(state.context)).toBeNull();
    expect(contextZone(null)).toBe('unknown');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(128000)).toBe('128k');
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });
});
