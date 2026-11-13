import { number, record } from '../session-coercion';
import type { SessionState } from '../session-state';
import type { FrameReducer, FrameReducerTable } from './types';

const clampRatio = (value: unknown) => Math.max(0, Math.min(1, number(value)));

const stats: FrameReducer = (state, p) => {
  const usage = record(p.usage);
  const next: SessionState = {
    ...state,
    usage: {
      input: number(usage.input),
      output: number(usage.output),
      total: number(usage.total),
    },
  };
  if (!p.cache || typeof p.cache !== 'object') return next;
  const cache = record(p.cache);
  const last = record(cache.last);
  return {
    ...next,
    cache: {
      readTokens: number(cache.readTokens),
      writeTokens: number(cache.writeTokens),
      hitRatio: clampRatio(cache.hitRatio),
      lastHitRatio: typeof last.hitRatio === 'number' ? clampRatio(last.hitRatio) : null,
      coverageTokens: Math.max(
        0,
        Math.min(state.tokens, number(record(p.currentRequest).cacheRead)),
      ),
      capturedAt: Date.now(),
    },
  };
};

/** Context window, run lifecycle signals, preferences and usage statistics. */
export const runtimeReducers: FrameReducerTable = {
  'ctx.pct': (state, p) => ({
    ...state,
    load: Math.max(0, number(p.load)),
    tokens: number(p.tokens),
    maxContext: number(p.maxContext) || state.maxContext,
  }),
  'ctx.max_context': (state, p) => ({ ...state, maxContext: number(p.maxContext) }),
  'context.compacted': (state, p) => ({
    ...state,
    notice: `Context compacted: ${number(p.before).toLocaleString()} → ${number(p.after).toLocaleString()} tokens.`,
    tokens: number(p.after),
    load: state.maxContext > 0 ? number(p.after) / state.maxContext : 0,
  }),
  'iteration.started': (state) => ({ ...state, running: true, runOutcome: null }),
  'session.run_state': (state, p) => ({
    ...state,
    running: p.isRunning === true,
    runOutcome: p.isRunning === true ? null : state.runOutcome,
  }),
  'provider.retry': (state) => ({
    ...state,
    messages: state.messages.filter((m) => !m.streaming),
    notice: 'The provider is retrying the response.',
  }),
  'prefs.updated': (state, p) => ({ ...state, prefs: { ...state.prefs, ...p } }),
  'stats.get': stats,
};
