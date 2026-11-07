/**
 * Durable display metadata for a one-click performance round.
 *
 * The agent receives the full prompt; the transcript shows a two-line card. The
 * marker is an HTML comment so it survives a session reload without a parallel
 * sidecar store, and so a replayed round still renders as a round rather than
 * as a wall of pasted instructions.
 *
 * Mirrors `bug-hunt-message.ts` — same shape, same guarantees.
 */

/** Keep in sync with `PERF_MODE_IDS` in `@wrongstack/core/performance`. */
export const PERF_RUN_MODES = [
  'ratchet',
  'audit',
  'triage',
  'memory',
  'io',
  'cpu',
  'guard',
  'contract',
] as const;

export type PerfRunMode = (typeof PERF_RUN_MODES)[number];

/** Keep in sync with `PERF_METRIC_IDS` in `@wrongstack/core/performance`. */
export const PERF_RUN_METRICS = [
  'wall-ms',
  'p99-latency-ms',
  'peak-rss-bytes',
  'throughput-ops',
  'allocs-per-op',
  'cold-start-ms',
  'bundle-bytes',
] as const;

export type PerfRunMetric = (typeof PERF_RUN_METRICS)[number];

export interface PerfRunSummary {
  scope: string;
  mode: PerfRunMode;
  /** Empty string means "whichever metric the workload actually feels". */
  metric: PerfRunMetric | '';
}

/**
 * Card labels for the transcript chip.
 *
 * Kept next to the mode list rather than in the i18n catalog, matching the
 * sibling Bug Hunter card: these are the names of built-in modes, and a
 * translated mode name would not match the `/perf <mode>` the user types.
 */
export const PERF_RUN_MODE_LABELS: Record<PerfRunMode, string> = {
  ratchet: 'Performance Ratchet',
  audit: 'Performance Audit',
  triage: 'Performance Triage',
  memory: 'Memory & Retention Hunt',
  io: 'I/O & Concurrency Analysis',
  cpu: 'CPU Hot Path Reduction',
  guard: 'Regression Guard Setup',
  contract: 'Performance Contract',
};

export const PERF_RUN_METRIC_LABELS: Record<PerfRunMetric, string> = {
  'wall-ms': 'Wall time',
  'p99-latency-ms': 'p99 latency',
  'peak-rss-bytes': 'Peak RSS',
  'throughput-ops': 'Throughput',
  'allocs-per-op': 'Allocations/op',
  'cold-start-ms': 'Cold start',
  'bundle-bytes': 'Bundle size',
};

/**
 * Mode → builtin prompt slug.
 *
 * Mirrors `PERF_MODES` in `@wrongstack/core/performance`. `perf-run-message.test.ts`
 * pins the two together, so a mode added on one side cannot silently 404 here.
 */
export const PERF_MODE_SLUGS: Record<PerfRunMode, string> = {
  ratchet: 'elite-performance-ratchet',
  audit: 'performance-baseline-audit',
  triage: 'performance-quick-triage',
  memory: 'performance-memory-hunt',
  io: 'performance-io-concurrency',
  cpu: 'performance-cpu-hot-path',
  guard: 'performance-regression-guard',
  contract: 'performance-contract',
};

/**
 * Modes that may change production code, and therefore run solo.
 *
 * A read-only mode must NOT flip the user's subagent policy: silently
 * disabling their fleet to produce a report is a side effect they did not ask
 * for, and the policy locks after the first message.
 */
export const PERF_MUTATING_MODES: ReadonlySet<PerfRunMode> = new Set<PerfRunMode>([
  'ratchet',
  'cpu',
  'guard',
]);

const PERF_RUN_PREFIX = '<!-- wrongstack-perf-run';
const PERF_RUN_PATTERN =
  /^<!-- wrongstack-perf-run scope="([^"]*)" mode="([a-z]+)" metric="([a-z0-9-]*)" -->\n/;

function isMode(value: string): value is PerfRunMode {
  return (PERF_RUN_MODES as readonly string[]).includes(value);
}

function isMetric(value: string): value is PerfRunMetric {
  return (PERF_RUN_METRICS as readonly string[]).includes(value);
}

/** Adds durable display metadata without changing the instruction sent to the agent. */
export function buildPerfRunMessage(instruction: string, summary: PerfRunSummary): string {
  return `${PERF_RUN_PREFIX} scope="${encodeURIComponent(summary.scope)}" mode="${summary.mode}" metric="${summary.metric}" -->\n${instruction}`;
}

/** Recognizes a persisted performance round and recovers its compact display data. */
export function parsePerfRunMessage(content: string): PerfRunSummary | undefined {
  const match = PERF_RUN_PATTERN.exec(content);
  if (!match) return undefined;
  const mode = match[2] ?? '';
  const metric = match[3] ?? '';
  // A marker written by a newer build may name a mode this build does not know.
  // Rendering it as an unknown chip would be worse than falling back to the
  // transcript text, so the message is treated as an ordinary one instead.
  if (!isMode(mode)) return undefined;
  try {
    return {
      scope: decodeURIComponent(match[1] ?? ''),
      mode,
      metric: isMetric(metric) ? metric : '',
    };
  } catch {
    return undefined;
  }
}
