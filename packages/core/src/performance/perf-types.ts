/**
 * Record shapes for the performance ratchet.
 *
 * The ratchet exists to make one rule mechanical instead of aspirational:
 * *nothing counts unless it was measured, and anything not measurably better
 * gets reverted*. Every type here exists to carry a number that some command
 * actually produced, plus the exact command that produced it — a claim without
 * a reproducible command is not representable.
 *
 * @module performance/perf-types
 */

/**
 * The metrics a ratchet round can optimise for.
 *
 * Deliberately small and closed. A metric that cannot be produced by running a
 * command and reading a number is not a ratchet metric — it is an opinion, and
 * opinions do not gate keep/revert decisions.
 */
export type PerfMetricId =
  | 'wall-ms'
  | 'p99-latency-ms'
  | 'peak-rss-bytes'
  | 'throughput-ops'
  | 'allocs-per-op'
  | 'cold-start-ms'
  | 'bundle-bytes';

/** Whether a smaller or a larger number is the improvement. */
export type PerfDirection = 'lower' | 'higher';

export interface PerfMetricSpec {
  id: PerfMetricId;
  /** Human label for logs, CLI output, and the WebUI picker. */
  label: string;
  /** Unit suffix used when formatting a raw value. */
  unit: string;
  /** Which way is better. Only `throughput-ops` is `higher`. */
  better: PerfDirection;
  /**
   * What the metric means in one line, injected into the agent prompt so the
   * round optimises the thing the user actually feels.
   */
  description: string;
}

export const PERF_METRICS: Record<PerfMetricId, PerfMetricSpec> = {
  'wall-ms': {
    id: 'wall-ms',
    label: 'Wall time',
    unit: 'ms',
    better: 'lower',
    description: 'End-to-end wall-clock duration of one workload run.',
  },
  'p99-latency-ms': {
    id: 'p99-latency-ms',
    label: 'p99 latency',
    unit: 'ms',
    better: 'lower',
    description: 'Tail request latency under the load the service actually sees.',
  },
  'peak-rss-bytes': {
    id: 'peak-rss-bytes',
    label: 'Peak RSS',
    unit: 'B',
    better: 'lower',
    description: 'High-water resident memory for the process during the workload.',
  },
  'throughput-ops': {
    id: 'throughput-ops',
    label: 'Throughput',
    unit: 'ops/s',
    better: 'higher',
    description: 'Completed operations per second at a fixed concurrency level.',
  },
  'allocs-per-op': {
    id: 'allocs-per-op',
    label: 'Allocations per op',
    unit: 'allocs',
    better: 'lower',
    description: 'Allocation count attributable to a single unit of work.',
  },
  'cold-start-ms': {
    id: 'cold-start-ms',
    label: 'Cold start',
    unit: 'ms',
    better: 'lower',
    description: 'Time from process launch to first useful response.',
  },
  'bundle-bytes': {
    id: 'bundle-bytes',
    label: 'Bundle size',
    unit: 'B',
    better: 'lower',
    description: 'Shipped artifact size — binary, bundle, or image layer.',
  },
};

export const PERF_METRIC_IDS: readonly PerfMetricId[] = Object.keys(PERF_METRICS) as PerfMetricId[];

export function isPerfMetricId(value: string): value is PerfMetricId {
  return Object.hasOwn(PERF_METRICS, value);
}

/**
 * The default noise floor, as a percentage.
 *
 * Contract rule 3: a delta under 5% is treated as noise even when the machine
 * happened to be quiet enough to produce a tight spread. Machines lie; this
 * floor is the standing distrust of a quiet machine.
 */
export const DEFAULT_MIN_DELTA_PCT = 5;

/** Default repeat count for a measurement. Three is the contract minimum. */
export const DEFAULT_RUNS = 5;

/**
 * Statistics over the repeat runs of one measurement.
 *
 * `spread` is the empirical noise band — `(max - min) / median` — and is the
 * reason a single fast run never justifies keeping a change.
 */
export interface PerfStats {
  runs: number;
  min: number;
  median: number;
  max: number;
  mean: number;
  p95: number;
  /** `(max - min) / median`, as a fraction. `0` when median is 0. */
  spread: number;
}

/** A completed measurement: the numbers plus everything needed to redo it. */
export interface PerfMeasurement extends PerfStats {
  metric: PerfMetricId;
  /** Exact command line, as it must appear in PERF_LOG.md. */
  command: string;
  cwd: string;
  /** Metric values in run order, so an outlier run stays visible. */
  samples: number[];
  startedAt: number;
  finishedAt: number;
  /** Non-fatal notes: discarded warmups, a run that printed to stderr, etc. */
  notes: string[];
}

/**
 * The verdict for one hypothesis.
 *
 * `noise` is not a soft failure — it is the revert signal. A change that lands
 * in `noise` costs readability and buys nothing measurable.
 */
export type PerfVerdict = 'improved' | 'regressed' | 'noise';

export interface PerfDecision {
  verdict: PerfVerdict;
  /** Signed percentage where positive always means *better*, regardless of direction. */
  deltaPct: number;
  /** The larger of the two measurements' spreads, as a percentage. */
  noiseFloorPct: number;
  /** `max(noiseFloorPct, minDeltaPct)` — what the delta had to beat. */
  thresholdPct: number;
  /** True only for `improved`. The single field callers should branch on. */
  keep: boolean;
  /** One-line explanation suitable for PERF_LOG.md. */
  reason: string;
}
