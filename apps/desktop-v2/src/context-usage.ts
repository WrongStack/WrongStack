import { displayDecimal } from './display-dates';
import { record } from './engine-values.js';

/** An engine frame as the reducer sees it (structurally `EngineEvent`). */
type EngineEvent = { type: string; payload: Record<string, unknown> };

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
/** How full the conversation's context is, in the order the engine reported it. */
export interface ContextUsage {
  /** Prompt tokens of the latest request the model saw, cached tokens included. */
  tokens: number;
  /** The active model's context window; 0 when the engine does not know it. */
  max: number;
  /** Prompt tokens of the latest response read from and written to the provider's cache. */
  cacheRead: number;
  cacheWrite: number;
  /**
   * Prompt tokens of the latest response (uncached + cache read + cache write), from the
   * same usage as `cacheRead`. Not `tokens`: a response can cover many model calls (a
   * WrongForge leader turn runs up to 150 steps and reports their summed usage), while
   * `tokens` is the size of one request, so dividing one by the other overshot 100 %.
   */
  prompt: number;
  /** Every response of this conversation added together. */
  totals: TokenTotals;
  responses: number;
  /** The provider reported a smaller window than the one configured. */
  decreasedFrom: number;
  compaction: { before: number; after: number; saved: number } | null;
}
export const emptyContextUsage: ContextUsage = {
  tokens: 0,
  max: 0,
  cacheRead: 0,
  cacheWrite: 0,
  prompt: 0,
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  responses: 0,
  decreasedFrom: 0,
  compaction: null,
};
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const tracked = (type: string) =>
  type === 'session.start' ||
  type === 'ctx.max_context' ||
  type === 'ctx.pct' ||
  type === 'token.threshold' ||
  type === 'provider.response' ||
  type === 'context.compacted';

/** Folds one engine frame into the leader's context usage; other frames return it unchanged. */
export function reduceContextUsage(usage: ContextUsage, event: EngineEvent): ContextUsage {
  if (!tracked(event.type)) return usage;
  const p = event.payload;
  // A worker's own requests do not fill the leader's window.
  if (typeof p['agentId'] === 'string' && p['agentId'] && p['agentId'] !== 'leader') return usage;
  if (event.type === 'session.start') {
    const replay = record(p['replayUsage']);
    const base = p['reset'] === true ? { ...emptyContextUsage, max: usage.max } : usage;
    return {
      ...base,
      max: count(p['maxContext']) || base.max,
      tokens: count(p['lastInputTokens']) || base.tokens,
      ...(Object.keys(replay).length
        ? {
            totals: {
              input: count(replay['input']),
              output: count(replay['output']),
              cacheRead: count(replay['cacheRead']),
              cacheWrite: count(replay['cacheWrite']),
            },
          }
        : {}),
    };
  }
  if (event.type === 'ctx.max_context') {
    const max = count(p['maxContext']);
    const previous = count(p['previousMaxContext']);
    const decreased =
      p['source'] === 'provider' && p['decreased'] === true && previous > max ? previous : 0;
    const keep = p['decreased'] === false || p['source'] === 'configured' ? 0 : usage.decreasedFrom;
    return { ...usage, max: max || usage.max, decreasedFrom: decreased || keep };
  }
  if (event.type === 'ctx.pct')
    return {
      ...usage,
      tokens: count(p['tokens']) || usage.tokens,
      max: count(p['maxContext']) || usage.max,
    };
  if (event.type === 'token.threshold')
    return {
      ...usage,
      tokens: count(p['used']) || usage.tokens,
      max: count(p['limit']) || usage.max,
    };
  if (event.type === 'context.compacted') {
    const after = count(p['fullRequestTokensAfter']) || count(p['after']);
    return {
      ...usage,
      tokens: after || usage.tokens,
      compaction: {
        before: count(p['before']),
        after: count(p['after']),
        saved: count(p['saved']),
      },
    };
  }
  const reported = record(p['usage']);
  const input = count(reported['input']);
  const cacheRead = count(reported['cacheRead']);
  const cacheWrite = count(reported['cacheWrite']);
  const output = count(reported['output']);
  if (!input && !cacheRead && !cacheWrite && !output) return usage;
  const prompt = input + cacheRead + cacheWrite;
  return {
    ...usage,
    tokens: prompt || usage.tokens,
    cacheRead,
    cacheWrite,
    prompt,
    responses: usage.responses + 1,
    totals: {
      input: usage.totals.input + input,
      output: usage.totals.output + output,
      cacheRead: usage.totals.cacheRead + cacheRead,
      cacheWrite: usage.totals.cacheWrite + cacheWrite,
    },
  };
}
/** Window fill in whole percent, capped at 100; null while either side is unknown. */
export function contextPercent(usage: ContextUsage): number | null {
  if (!usage.max || !usage.tokens) return null;
  return Math.min(100, Math.round((usage.tokens / usage.max) * 100));
}
/** The same zones the WebUI uses: warn from 60 %, critical from 85 %. */
export function contextZone(percent: number | null): 'unknown' | 'ok' | 'warn' | 'critical' {
  if (percent === null) return 'unknown';
  return percent >= 85 ? 'critical' : percent >= 60 ? 'warn' : 'ok';
}
/**
 * Share of the latest response's prompt served from the provider's cache, in whole percent.
 * Numerator and denominator come from the same usage report, so the share stays within
 * 0–100 even when that report sums many model calls.
 */
export function cacheHitPercent(usage: ContextUsage): number | null {
  if (!usage.prompt || !(usage.cacheRead + usage.cacheWrite)) return null;
  return Math.min(100, Math.round((usage.cacheRead / usage.prompt) * 100));
}
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${displayDecimal(value / 1_000_000, 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${displayDecimal(value / 1000, 1)}k`;
  return String(value);
}

/** What one finished turn took: its iterations and the tokens its requests used. */
export interface TurnStats {
  iterations: number;
  prompt: number;
  output: number;
  cacheRead: number;
  /** From the turn's first iteration to its result, when the journal has both times. */
  durationMs?: number;
}
export function turnStats(
  start: TokenTotals | null,
  end: TokenTotals,
  iterations: unknown,
  durationMs?: number,
): TurnStats {
  const from = start ?? end;
  const input = end.input - from.input;
  const cacheRead = end.cacheRead - from.cacheRead;
  const cacheWrite = end.cacheWrite - from.cacheWrite;
  return {
    iterations: count(iterations),
    prompt: input + cacheRead + cacheWrite,
    output: end.output - from.output,
    cacheRead,
    ...(durationMs !== undefined && durationMs >= 0 ? { durationMs } : {}),
  };
}
