import type { HqProjectRecord, HqSessionSnapshotPayload, HqTimeseriesSample } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import {
  breakdown,
  count,
  labelSpend,
  niceCeiling,
  projectSpend,
  samplesForMachines,
  sessionSpend,
  TREND_RANGES,
  trendTotals,
  trendWindow,
  usd,
} from '../src/features/telemetry/model';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 31, 12, 30);
const range = (id: string) => {
  const found = TREND_RANGES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};
const sample = (ts: number, extra: Partial<HqTimeseriesSample> = {}): HqTimeseriesSample => ({
  ts,
  costUsd: 1,
  inputTokens: 100,
  outputTokens: 10,
  toolCalls: 2,
  ...extra,
});

describe('trendWindow', () => {
  it('draws every column of the window, empty ones included', () => {
    const view = trendWindow(
      [sample(NOW - 2 * HOUR), sample(NOW - 2 * HOUR + 60_000)],
      range('24h'),
      NOW,
    );
    expect(view.columns).toHaveLength(24);
    expect(view.end - view.start).toBe(24 * HOUR);
    const filled = view.columns.filter((column) => column.costUsd > 0);
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({ costUsd: 2, tokens: 220, toolCalls: 4 });
    // A quiet hour stays a gap at its own time, not a squeezed-out slot.
    expect(view.columns.indexOf(filled[0] as never)).toBe(21);
  });

  it('does not show older data under a newer window, but remembers when it happened', () => {
    const old = NOW - 3 * 24 * HOUR;
    const view = trendWindow([sample(old)], range('24h'), NOW);
    expect(view.samples).toEqual([]);
    expect(view.lastActivity).toBe(old);
  });
});

describe('totals and breakdowns', () => {
  it('reports cache reads as a share of prompt tokens only when present', () => {
    expect(trendTotals([sample(NOW)]).cacheShare).toBeNull();
    const cached = sample(NOW, {
      byModel: { m: { costUsd: 1, inputTokens: 100, outputTokens: 10, cacheRead: 40 } },
    });
    expect(trendTotals([cached]).cacheShare).toBeCloseTo(0.4);
  });

  it('sums a model across samples and ranks by cost', () => {
    const rows = breakdown(
      [
        sample(NOW, {
          byModel: {
            a: { costUsd: 1, inputTokens: 1, outputTokens: 1 },
            b: { costUsd: 3, inputTokens: 1, outputTokens: 1 },
          },
        }),
        sample(NOW, {
          byModel: { a: { costUsd: 4, inputTokens: 2, outputTokens: 2, cacheWrite: 5 } },
        }),
      ],
      'byModel',
    );
    expect(rows.map((row) => [row.key, row.costUsd, row.cacheTokens])).toEqual([
      ['a', 5, 5],
      ['b', 3, 0],
    ]);
    expect(rows[0]?.share).toBeCloseTo(5 / 8);
  });
});

describe('spend', () => {
  it('ranks projects by spend with their share', () => {
    const project = (id: string, cost: number) =>
      ({
        projectId: id,
        projectName: id.toUpperCase(),
        totalCostUsd: cost,
        activeSessions: 1,
      }) as HqProjectRecord;
    const rows = projectSpend([project('a', 1), project('b', 3)]);
    expect(rows.map((row) => [row.name, row.share])).toEqual([
      ['B', 0.75],
      ['A', 0.25],
    ]);
  });

  it('sums agents per session and drops sessions that spent nothing', () => {
    const session = (id: string, agents: object[]) =>
      ({
        sessionId: id,
        projectName: 'P',
        machineId: 'm',
        agents,
      }) as unknown as HqSessionSnapshotPayload;
    const rows = sessionSpend([
      session('idle', [{ costUsd: 0 }]),
      session('busy', [
        { costUsd: 0.5, tokensIn: 10, tokensOut: 5, model: 'b' },
        { costUsd: 0.25, model: 'a' },
      ]),
    ]);
    expect(rows).toEqual([
      {
        sessionId: 'busy',
        projectName: 'P',
        machine: 'm',
        costUsd: 0.75,
        tokens: 15,
        agents: 2,
        models: ['a', 'b'],
      },
    ]);
  });

  it('formats money and counts', () => {
    expect(usd(0)).toBe('$0');
    expect(usd(0.0042)).toBe('$0.0042');
    expect(usd(12.4)).toBe('$12.40');
    expect(usd(0.8)).toBe('$0.80');
    expect(usd(0.042)).toBe('$0.042');
    expect(count(999)).toBe('999');
    expect(count(1234)).toBe('1.2k');
    expect(count(999_999)).toBe('1M');
    expect(count(100_000)).toBe('100k');
    expect(count(85_500)).toBe('85.5k');
  });
});

describe('niceCeiling', () => {
  it('rounds a peak up to the next round axis top', () => {
    expect(niceCeiling(0.1966)).toBe(0.2);
    expect(niceCeiling(0.2)).toBe(0.2);
    expect(niceCeiling(0.3)).toBeCloseTo(0.5);
    expect(niceCeiling(99_300)).toBe(100_000);
    expect(niceCeiling(2_300)).toBe(2_500);
    expect(niceCeiling(7)).toBe(10);
    expect(niceCeiling(1)).toBe(1);
  });

  it('has no scale for an empty or broken peak', () => {
    expect(niceCeiling(0)).toBe(0);
    expect(niceCeiling(-3)).toBe(0);
    expect(niceCeiling(Number.NaN)).toBe(0);
  });
});

describe('label spend', () => {
  const entry = (costUsd: number) => ({ costUsd, inputTokens: 10, outputTokens: 5, toolCalls: 1 });
  const samples = [
    {
      ts: 0,
      costUsd: 6,
      inputTokens: 30,
      outputTokens: 15,
      byMachine: { 'host:desk': entry(1), 'host:lab': entry(2), 'host:spare': entry(3) },
    },
    { ts: 1, costUsd: 4, inputTokens: 10, outputTokens: 5, byMachine: { 'host:lab': entry(4) } },
  ] as unknown as HqTimeseriesSample[];
  const labels = { 'host:desk': ['gpu', 'lab'], 'host:lab': ['lab'] };

  it('narrows the series to a set of machines', () => {
    const lab = samplesForMachines(samples, new Set(['host:desk', 'host:lab']));
    expect(lab.map((sample) => sample.costUsd)).toEqual([3, 4]);
    expect(lab[0]).toMatchObject({ inputTokens: 20, outputTokens: 10, toolCalls: 2 });
  });

  it('sums spend per label, counts multi-label machines twice and keeps the rest as one row', () => {
    const rows = labelSpend(samples, labels);
    expect(rows.map((row) => [row.key, row.costUsd])).toEqual([
      ['lab', 7],
      ['gpu', 1],
      ['no label', 3],
    ]);
    // Shares are of the whole fleet's 10.
    expect(rows[0]?.share).toBeCloseTo(0.7);
  });
});
