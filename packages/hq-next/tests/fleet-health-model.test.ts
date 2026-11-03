/**
 * Fleet health side by side: the machine that fills up first leads, then any
 * the server flagged, then the least free space; the headline names the
 * machines that run out within a week.
 */
import type { HqHealthPoint } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { fleetHealthHeadline, fleetHealthRows } from '../src/features/machines/fleet-health';
import type { MachineSummary } from '../src/features/machines/model';

const GB = 1e9;
const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-02T00:00:00.000Z');

const machine = (key: string, over: Partial<MachineSummary> = {}): MachineSummary =>
  ({
    key,
    hostname: key.replace('host:', '').toUpperCase(),
    online: true,
    health: undefined,
    healthProblems: undefined,
    labels: [],
    attention: [],
    ...over,
  }) as unknown as MachineSummary;

/** One reading every 6 hours for 2 days, free space falling by `perDay`. */
const falling = (key: string, startGb: number, perDayGb: number): HqHealthPoint[] =>
  Array.from({ length: 9 }, (_, i) => ({
    key,
    at: new Date(T0 + i * 6 * HOUR).toISOString(),
    memUsedPct: 40 + i,
    diskFreeBytes: (startGb - (perDayGb * i) / 4) * GB,
    diskTotalBytes: 500 * GB,
    cpuCount: 4,
  }));

describe('fleet health', () => {
  const machines = [
    machine('host:steady'),
    machine('host:fast'),
    machine('host:slow'),
    machine('host:new'),
  ];
  const overview = [
    {
      key: 'host:steady',
      points: falling('host:steady', 200, 0),
    },
    { key: 'host:fast', points: falling('host:fast', 30, 10) },
    { key: 'host:slow', points: falling('host:slow', 100, 5) },
  ];
  const rows = fleetHealthRows(machines, overview);

  it('puts the machine that fills up first on top', () => {
    expect(rows.map((row) => row.hostname)).toEqual(['FAST', 'SLOW', 'STEADY', 'NEW']);
    // 30 → 10 GB over 2 days: about 1 more day at 10 GB a day.
    expect(rows[0]?.diskFullInDays).toBeCloseTo(1, 0);
    expect(rows[0]?.diskFreePct).toBe(2);
    expect(rows[2]?.diskFullInDays).toBeUndefined();
    expect(rows[3]).toMatchObject({ readings: 0, diskFreeBytes: undefined });
  });

  it('sums memory pressure from the readings', () => {
    expect(rows[0]).toMatchObject({ memoryAveragePct: 44, memoryPeakPct: 48 });
  });

  it('names the machines that run out within a week', () => {
    expect(fleetHealthHeadline(rows)).toBe('1 machine fills up within a week');
    expect(fleetHealthHeadline(fleetHealthRows([machine('host:new')], []))).toBe(
      'No disk is filling up',
    );
  });
});
