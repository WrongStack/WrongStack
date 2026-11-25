import type { HqTimeseriesSample } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { TREND_RANGES, trendWindow } from '../src/features/telemetry/model';

describe('trendWindow non-finite sample guards', () => {
  it('does not poison bucket column totals with NaN sample metrics', () => {
    const range = TREND_RANGES[0]!;
    const now = 1_700_000_000_000;
    const sampleTs = now - 60_000;
    const win = trendWindow(
      [
        {
          ts: sampleTs,
          costUsd: 1.5,
          inputTokens: 100,
          outputTokens: 50,
          toolCalls: 2,
        } as HqTimeseriesSample,
        {
          ts: sampleTs,
          costUsd: Number.NaN,
          inputTokens: Number.NaN,
          outputTokens: 0,
          toolCalls: Number.NaN,
        } as HqTimeseriesSample,
      ],
      range,
      now,
    );
    expect(
      win.columns.some((c) => c.costUsd === 1.5 && c.tokens === 150 && c.toolCalls === 2),
    ).toBe(true);
    expect(win.columns.every((c) => Number.isFinite(c.costUsd) && Number.isFinite(c.tokens))).toBe(
      true,
    );
  });
});
