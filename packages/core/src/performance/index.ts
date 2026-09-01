/**
 * The performance ratchet: measurement, the keep/revert gate, the ledger, and
 * the regression guard.
 *
 * Consumers: `/perf` in the CLI, the WebUI one-click card, and
 * `scripts/perf-guard.mjs`. Imported as `@wrongstack/core/performance`.
 *
 * @module performance
 */
export {
  gnuTimeMaxRssExtractor,
  hyperfineMeanExtractor,
  isPerfExtractorName,
  jsonPathExtractor,
  type MetricExtractor,
  PERF_EXTRACTORS,
  type PerfExtractorName,
  type PerfRunOutput,
  regexExtractor,
  resolveExtractor,
  wallTimeExtractor,
} from './perf-extractors.js';
export {
  applyRatchet,
  DEFAULT_GUARD_THRESHOLD_PCT,
  type EvaluateGuardOptions,
  evaluateGuard,
  formatGuardReport,
  guardFailed,
  type GuardResult,
  PERF_BASELINE_SCHEMA_VERSION,
  parseBaselineFile,
  type PerfBaselineEntry,
  type PerfBaselineFile,
  type RatchetOptions,
} from './perf-guard.js';
export {
  appendPerfAttempt,
  appendPerfRound,
  latestRound,
  parsePerfLog,
  PERF_LOG_HEADER,
  type PerfAttempt,
  type PerfAttemptOutcome,
  type PerfLogDocument,
  type PerfRound,
  renderPerfLog,
  renderRound,
  summarizePerfLog,
} from './perf-log.js';
export {
  DEFAULT_PERF_MODE,
  isPerfModeId,
  PERF_MODE_IDS,
  PERF_MODES,
  PERF_PROMPT_SLUGS,
  type PerfMode,
  type PerfModeId,
} from './perf-modes.js';
export {
  describeMachine,
  measure,
  type MeasureOptions,
  runOnce,
} from './perf-runner.js';
export {
  detectPerfStacks,
  GENERIC_STACK,
  type PerfStackId,
  type PerfStackProfile,
  renderStackGuidance,
} from './perf-stack.js';
export {
  type DecideOptions,
  decide,
  decideForMetric,
  formatMetricValue,
  isStableBaseline,
  percentileSorted,
  rawDeltaPct,
  summarize,
} from './perf-stats.js';
export {
  DEFAULT_MIN_DELTA_PCT,
  DEFAULT_RUNS,
  isPerfMetricId,
  PERF_METRIC_IDS,
  PERF_METRICS,
  type PerfDecision,
  type PerfDirection,
  type PerfMeasurement,
  type PerfMetricId,
  type PerfMetricSpec,
  type PerfStats,
  type PerfVerdict,
} from './perf-types.js';
