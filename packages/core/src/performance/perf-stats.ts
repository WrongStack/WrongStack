/**
 * Pure statistics and the keep/revert gate for the performance ratchet.
 *
 * Nothing here touches the filesystem, spawns a process, or reads a clock, so
 * the one rule that makes the ratchet work — *if it is inside the noise, it
 * gets reverted* — is exhaustively unit-testable.
 *
 * @module performance/perf-stats
 */
import {
  DEFAULT_MIN_DELTA_PCT,
  type PerfDecision,
  type PerfDirection,
  type PerfMetricId,
  PERF_METRICS,
  type PerfStats,
} from './perf-types.js';

/**
 * Linear-interpolation percentile over an already-sorted ascending array.
 *
 * `q` is a fraction in `[0, 1]`. Interpolating rather than picking the nearest
 * rank matters at the sample counts a ratchet uses: with 5 runs, nearest-rank
 * p95 is just `max`, which reports machine noise as tail latency.
 */
export function percentileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0] as number;
  const clamped = Math.min(1, Math.max(0, q));
  const position = clamped * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] as number;
  if (lower === upper) return low;
  const high = sorted[upper] as number;
  return low + (high - low) * (position - lower);
}

/**
 * Collapse repeat runs into the shape the gate consumes.
 *
 * Throws on an empty sample set rather than returning zeros: a measurement
 * that produced no numbers must not be silently comparable to one that did.
 */
export function summarize(samples: readonly number[]): PerfStats {
  if (samples.length === 0) {
    throw new Error('summarize(): at least one sample is required');
  }
  for (const value of samples) {
    if (!Number.isFinite(value)) {
      throw new Error(`summarize(): non-finite sample ${String(value)}`);
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0] as number;
  const max = sorted[sorted.length - 1] as number;
  const median = percentileSorted(sorted, 0.5);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    runs: samples.length,
    min,
    median,
    max,
    mean,
    p95: percentileSorted(sorted, 0.95),
    // A zero median means the metric collapsed (an empty workload, a counter
    // that never incremented). Reporting an infinite spread there would make
    // every delta "noise"; reporting 0 makes the caller's threshold the only
    // gate, which is the honest reading of "we have no noise estimate".
    spread: median === 0 ? 0 : (max - min) / median,
  };
}

/** Signed percentage change from `before` to `after`, positive = larger. */
export function rawDeltaPct(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : Number.POSITIVE_INFINITY;
  return ((after - before) / Math.abs(before)) * 100;
}

export interface DecideOptions {
  /**
   * Percentage floor below which a delta is noise no matter how tight the
   * spread. Defaults to {@link DEFAULT_MIN_DELTA_PCT}.
   */
  minDeltaPct?: number;
  /** Which direction counts as an improvement. Defaults to `lower`. */
  better?: PerfDirection;
}

/**
 * The keep/revert gate.
 *
 * A change is kept only when the improvement beats **both** the empirical noise
 * band of the two measurements *and* the absolute percentage floor. Beating one
 * but not the other is exactly the case that produces a repo full of unreadable
 * "optimisations" that never showed up in production.
 */
export function decide(
  before: PerfStats,
  after: PerfStats,
  options: DecideOptions = {},
): PerfDecision {
  const minDeltaPct = options.minDeltaPct ?? DEFAULT_MIN_DELTA_PCT;
  const better = options.better ?? 'lower';
  const signedRaw = rawDeltaPct(before.median, after.median);
  // Normalise so positive always means *better*, whichever way the metric runs.
  const deltaPct = better === 'lower' ? -signedRaw : signedRaw;
  const noiseFloorPct = Math.max(before.spread, after.spread) * 100;
  const thresholdPct = Math.max(noiseFloorPct, minDeltaPct);

  const round = (value: number) => Math.round(value * 10) / 10;

  if (!Number.isFinite(deltaPct)) {
    return {
      verdict: 'noise',
      deltaPct: 0,
      noiseFloorPct: round(noiseFloorPct),
      thresholdPct: round(thresholdPct),
      keep: false,
      reason: 'baseline median was zero; the ratio is undefined, so no claim can be made',
    };
  }

  if (Math.abs(deltaPct) < thresholdPct) {
    return {
      verdict: 'noise',
      deltaPct: round(deltaPct),
      noiseFloorPct: round(noiseFloorPct),
      thresholdPct: round(thresholdPct),
      keep: false,
      reason:
        `${round(deltaPct)}% is inside noise (needed ${round(thresholdPct)}%: ` +
        `${round(noiseFloorPct)}% run spread, ${minDeltaPct}% floor)`,
    };
  }

  if (deltaPct > 0) {
    return {
      verdict: 'improved',
      deltaPct: round(deltaPct),
      noiseFloorPct: round(noiseFloorPct),
      thresholdPct: round(thresholdPct),
      keep: true,
      reason: `${round(deltaPct)}% better, outside the ${round(thresholdPct)}% noise threshold`,
    };
  }

  return {
    verdict: 'regressed',
    deltaPct: round(deltaPct),
    noiseFloorPct: round(noiseFloorPct),
    thresholdPct: round(thresholdPct),
    keep: false,
    reason: `${round(Math.abs(deltaPct))}% worse, outside the ${round(thresholdPct)}% noise threshold`,
  };
}

/** {@link decide} with the direction taken from the metric registry. */
export function decideForMetric(
  metric: PerfMetricId,
  before: PerfStats,
  after: PerfStats,
  options: Omit<DecideOptions, 'better'> = {},
): PerfDecision {
  return decide(before, after, { ...options, better: PERF_METRICS[metric].better });
}

/**
 * Whether a baseline is stable enough to optimise against.
 *
 * Contract step 1: an unstable baseline makes every subsequent verdict a coin
 * flip, and optimising against a coin flip is worse than doing nothing.
 */
export function isStableBaseline(stats: PerfStats, maxSpreadPct = 15): boolean {
  return stats.runs >= 3 && stats.spread * 100 <= maxSpreadPct;
}

/** Format a raw metric value with its unit, scaling bytes to KB/MB/GB. */
export function formatMetricValue(metric: PerfMetricId, value: number): string {
  const spec = PERF_METRICS[metric];
  if (spec.unit !== 'B') {
    const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
    return `${rounded}${spec.unit === 'ops/s' ? ' ops/s' : spec.unit === 'allocs' ? ' allocs' : spec.unit}`;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let scaled = value;
  let index = 0;
  while (Math.abs(scaled) >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  const rounded = index === 0 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return `${rounded}${units[index]}`;
}
