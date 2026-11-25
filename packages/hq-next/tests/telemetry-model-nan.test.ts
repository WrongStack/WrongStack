import { describe, expect, it } from 'vitest';
import { percent, trendTotals } from '../src/features/telemetry/model.js';

describe('hq-next telemetry model non-finite guards (F1870)', () => {
  it('clamps digits in percent and ignores non-finite values in trendTotals', () => {
    expect(percent(0.5, -1)).toBe('50%');
    expect(percent(0.5, Number.NaN)).toBe('50%');
    expect(percent(0.5, 1)).toBe('50.0%');
    expect(percent(Number.NaN, 2)).toBe('0%');

    const totals = trendTotals([
      { ts: 1000, costUsd: 1.5, inputTokens: 100, outputTokens: 50, toolCalls: 2 },
      {
        ts: 2000,
        costUsd: Number.NaN,
        inputTokens: Number.POSITIVE_INFINITY,
        outputTokens: Number.NaN,
        toolCalls: Number.NaN,
      },
    ]);
    expect(totals.costUsd).toBe(1.5);
    expect(totals.inputTokens).toBe(100);
    expect(totals.outputTokens).toBe(50);
    expect(totals.toolCalls).toBe(2);
  });
});
