/**
 * Health readings over time, in words: how the disk and memory moved, and a
 * "full in about N days" projection only when the disk is genuinely filling.
 */
import type { HqHealthPoint } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { fullInWords, healthTrend } from '../src/features/machines/health-trend';

const GIB = 1024 ** 3;
const HOUR = 60 * 60_000;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

const point = (hoursIn: number, diskFreeGib: number | undefined, mem = 50): HqHealthPoint => ({
  key: 'host:lab-02',
  at: new Date(T0 + hoursIn * HOUR).toISOString(),
  memUsedPct: mem,
  ...(diskFreeGib !== undefined
    ? { diskFreeBytes: diskFreeGib * GIB, diskTotalBytes: 500 * GIB }
    : {}),
  cpuCount: 8,
});

describe('healthTrend', () => {
  it('says nothing from fewer than two readings', () => {
    expect(healthTrend([])).toMatchObject({ diskSummary: undefined, memorySummary: undefined });
    expect(healthTrend([point(0, 40)]).diskSummary).toBeUndefined();
  });

  it('projects when a filling disk runs out', () => {
    // 40 GB → 10 GB over 3 days: 10 GB a day, so about 1 more day.
    const trend = healthTrend([point(0, 40), point(24, 30), point(48, 20), point(72, 10)]);
    expect(trend.diskSummary).toBe('Free space went from 40 GB to 10 GB over 3 days.');
    expect(trend.diskFullInDays).toBe(1);
    expect(fullInWords(trend.diskFullInDays!)).toBe('in about 1 day');
  });

  it('does not project a stable or growing disk, or from too short a span', () => {
    expect(healthTrend([point(0, 40), point(48, 40)]).diskFullInDays).toBeUndefined();
    expect(healthTrend([point(0, 20), point(48, 40)]).diskFullInDays).toBeUndefined();
    expect(healthTrend([point(0, 40), point(2, 39)]).diskFullInDays).toBeUndefined();
    // Filling, but slower than 60 days to full: not a warning.
    expect(healthTrend([point(0, 400), point(72, 399)]).diskFullInDays).toBeUndefined();
  });

  it('is not fooled by order or by readings without a disk', () => {
    const trend = healthTrend([point(72, 10), point(0, 40), point(36, undefined, 90)]);
    expect(trend.disk.map((p) => p.value / GIB)).toEqual([40, 10]);
    expect(trend.memorySummary).toBe('Memory in use averaged 63% and peaked at 90%.');
  });

  it('words short projections and short spans for people', () => {
    expect(fullInWords(0.4)).toBe('within a day');
    expect(fullInWords(5.4)).toBe('in about 5 days');
    expect(healthTrend([point(0, 40), point(5, 39)]).diskSummary).toContain('over 5 hours');
  });
});
