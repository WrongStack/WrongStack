import { describe, expect, it } from 'vitest';
import {
  decide,
  decideForMetric,
  formatMetricValue,
  isStableBaseline,
  percentileSorted,
  rawDeltaPct,
  summarize,
} from '../../src/performance/perf-stats.js';

/** Build stats with an exact median and a controlled spread. */
function statsWithSpread(median: number, spreadPct: number) {
  const half = (median * spreadPct) / 200;
  return summarize([median - half, median, median + half]);
}

describe('summarize', () => {
  it('reports order statistics and the empirical spread', () => {
    const stats = summarize([10, 12, 11, 30, 11]);
    expect(stats.runs).toBe(5);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(30);
    expect(stats.median).toBe(11);
    expect(stats.spread).toBeCloseTo((30 - 10) / 11, 6);
  });

  it('rejects an empty sample set rather than pretending it is zero', () => {
    expect(() => summarize([])).toThrow(/at least one sample/);
  });

  it('rejects non-finite samples', () => {
    expect(() => summarize([1, Number.NaN, 3])).toThrow(/non-finite/);
  });

  it('reports zero spread when the median collapses to zero', () => {
    // No noise estimate is available; the caller's percentage floor becomes the
    // only gate, which beats reporting an infinite spread that swallows
    // every subsequent delta as "noise".
    expect(summarize([0, 0, 1]).spread).toBe(0);
  });
});

describe('percentileSorted', () => {
  it('interpolates rather than snapping to the nearest rank', () => {
    expect(percentileSorted([0, 10], 0.5)).toBe(5);
    expect(percentileSorted([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 6);
  });

  it('handles degenerate inputs', () => {
    expect(percentileSorted([], 0.5)).toBeNaN();
    expect(percentileSorted([7], 0.95)).toBe(7);
  });
});

describe('rawDeltaPct', () => {
  it('is signed relative to the before value', () => {
    expect(rawDeltaPct(100, 80)).toBe(-20);
    expect(rawDeltaPct(100, 130)).toBe(30);
  });

  it('is infinite when the baseline was zero and the after value is not', () => {
    expect(rawDeltaPct(0, 5)).toBe(Number.POSITIVE_INFINITY);
    expect(rawDeltaPct(0, 0)).toBe(0);
  });
});

describe('decide — the keep/revert gate', () => {
  it('keeps a win that clears both the spread and the percentage floor', () => {
    const before = statsWithSpread(100, 2);
    const after = statsWithSpread(80, 2);
    const decision = decide(before, after);
    expect(decision.verdict).toBe('improved');
    expect(decision.keep).toBe(true);
    expect(decision.deltaPct).toBeCloseTo(20, 1);
  });

  it('reverts a win smaller than the 5% floor even on a quiet machine', () => {
    // 3% better with a 0.2% spread: the machine is quiet enough to "see" it,
    // and it is still not worth the readability cost.
    const decision = decide(statsWithSpread(100, 0.2), statsWithSpread(97, 0.2));
    expect(decision.verdict).toBe('noise');
    expect(decision.keep).toBe(false);
    expect(decision.reason).toMatch(/inside noise/);
  });

  it('reverts a win smaller than the run spread even when it clears 5%', () => {
    // 8% better, but the runs themselves vary by 30% — the delta is a coin flip.
    const decision = decide(statsWithSpread(100, 30), statsWithSpread(92, 30));
    expect(decision.verdict).toBe('noise');
    expect(decision.thresholdPct).toBeGreaterThan(8);
  });

  it('flags a regression that clears the threshold', () => {
    const decision = decide(statsWithSpread(100, 1), statsWithSpread(140, 1));
    expect(decision.verdict).toBe('regressed');
    expect(decision.keep).toBe(false);
    expect(decision.deltaPct).toBeCloseTo(-40, 1);
  });

  it('honours a higher-is-better direction', () => {
    const decision = decide(statsWithSpread(100, 1), statsWithSpread(140, 1), {
      better: 'higher',
    });
    expect(decision.verdict).toBe('improved');
    expect(decision.deltaPct).toBeCloseTo(40, 1);
  });

  it('takes the direction from the metric registry', () => {
    const before = statsWithSpread(1000, 1);
    const after = statsWithSpread(1400, 1);
    expect(decideForMetric('throughput-ops', before, after).verdict).toBe('improved');
    expect(decideForMetric('p99-latency-ms', before, after).verdict).toBe('regressed');
  });

  it('refuses to make a claim against a zero baseline', () => {
    const decision = decide(summarize([0, 0, 0]), summarize([5, 5, 5]));
    expect(decision.verdict).toBe('noise');
    expect(decision.reason).toMatch(/baseline median was zero/);
  });

  it('respects a caller-supplied floor', () => {
    const before = statsWithSpread(100, 0.2);
    const after = statsWithSpread(97, 0.2);
    expect(decide(before, after, { minDeltaPct: 1 }).verdict).toBe('improved');
  });
});

describe('isStableBaseline', () => {
  it('requires three runs and a tight spread', () => {
    expect(isStableBaseline(statsWithSpread(100, 5))).toBe(true);
    expect(isStableBaseline(statsWithSpread(100, 40))).toBe(false);
    expect(isStableBaseline(summarize([100, 100]))).toBe(false);
  });
});

describe('formatMetricValue', () => {
  it('scales byte metrics and leaves the others alone', () => {
    expect(formatMetricValue('peak-rss-bytes', 1536)).toBe('1.5KB');
    expect(formatMetricValue('peak-rss-bytes', 900)).toBe('900B');
    expect(formatMetricValue('wall-ms', 301.4)).toBe('301ms');
    expect(formatMetricValue('throughput-ops', 12.345)).toBe('12.35 ops/s');
  });
});
