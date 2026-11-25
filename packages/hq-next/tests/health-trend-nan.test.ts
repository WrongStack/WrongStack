import type { HqHealthPoint } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { fullInWords, healthTrend } from '../src/features/machines/health-trend.js';

describe('healthTrend and fullInWords non-finite values (F1869)', () => {
  it('filters non-finite readings and guards non-finite days in fullInWords', () => {
    const trend = healthTrend([
      {
        key: 'm1',
        at: '2026-11-25T10:00:00.000Z',
        memUsedPct: 40,
        diskFreeBytes: 1000,
        cpuCount: 4,
      },
      {
        key: 'm1',
        at: '2026-11-25T11:00:00.000Z',
        memUsedPct: Number.NaN,
        diskFreeBytes: Number.NaN,
        cpuCount: 4,
      },
      {
        key: 'm1',
        at: '2026-11-25T12:00:00.000Z',
        memUsedPct: 60,
        diskFreeBytes: 800,
        cpuCount: 4,
      },
    ] as HqHealthPoint[]);

    expect(trend.memorySummary).toBe('Memory in use averaged 50% and peaked at 60%.');
    expect(trend.memory).toHaveLength(2);
    expect(trend.disk).toHaveLength(2);
    expect(fullInWords(Number.NaN)).toBe('unknown');
    expect(fullInWords(Number.POSITIVE_INFINITY)).toBe('unknown');
    expect(fullInWords(0.5)).toBe('within a day');
    expect(fullInWords(3)).toBe('in about 3 days');
  });
});
