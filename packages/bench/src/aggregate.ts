import type {
  CellResult,
  ConditionalRate,
  ModelCell,
  TaskResult,
  TraceEvalMetrics,
} from './types.js';

/**
 * Fold every per-(task × cell) result for ONE cell into its leaderboard row.
 * All metrics are derived from deterministic signals (grader pass/fail, the
 * `--output-json` usage block, and session-log tool counts) — nothing here
 * consults a model.
 */
export function aggregateCell(cell: ModelCell, results: TaskResult[]): CellResult {
  const attemptCount = results.length;
  if (attemptCount === 0) {
    return {
      cell,
      taskCount: 0,
      attemptCount: 0,
      repeats: 1,
      incompleteCount: 0,
      flakyTaskCount: 0,
      passAnyRate: 0,
      passAllRate: 0,
      gradedCount: 0,
      passRate: 0,
      editApplyRate: 1,
      avgCostUsd: 0,
      avgTokensIn: 0,
      avgTokensOut: 0,
      p50Iterations: 0,
      p50ElapsedMs: 0,
      timeoutRate: 0,
      totalRateLimitRetries: 0,
    };
  }

  // With repeats, several rows share one taskId. Task-level metrics (pass@k,
  // flakiness) fold per task; attempt-level metrics (pass@1, cost, latency)
  // stay over every row so a repeated run is a bigger, not a distorted, sample.
  const byTask = new Map<string, TaskResult[]>();
  for (const row of results) {
    const bucket = byTask.get(row.taskId);
    if (bucket) bucket.push(row);
    else byTask.set(row.taskId, [row]);
  }
  const taskCount = byTask.size;

  // Only count rows that produced an actual verdict — exported-but-ungraded
  // SWE-bench rows (graded === false) must not deflate the pass rate.
  const graded = results.filter((r) => r.grade.graded !== false);
  const passed = graded.filter((r) => r.grade.passed).length;
  const timeouts = results.filter((r) => r.run.status === 'timeout').length;

  const editCalls = sum(results, (r) => r.tools.editCalls);
  const editErrors = sum(results, (r) => r.tools.editErrors);
  // Edit-apply rate is undefined when no edit was ever attempted; report 1
  // (nothing failed to apply) so a no-op run doesn't drag the column down.
  // Clamp to [0,1]: a single over-reported error (editErrors > editCalls) must
  // not emit a negative percentage in the leaderboard.
  const editApplyRate =
    editCalls === 0 ? 1 : Math.max(0, Math.min(1, (editCalls - editErrors) / editCalls));
  const traceEval = aggregateTraceEval(results);

  const stability = foldTaskStability(byTask);

  const cellResult: CellResult = {
    cell,
    taskCount,
    attemptCount,
    repeats: Math.max(1, Math.round(attemptCount / Math.max(1, taskCount))),
    // Timeouts and crashes never print the usage payload, so their tokens and
    // cost are unrecoverable zeros. Surfacing the count keeps the averages
    // below honest instead of quietly flattering a model that gave up.
    incompleteCount: results.filter((r) => r.run.status === 'timeout' || r.run.status === 'crashed')
      .length,
    flakyTaskCount: stability.flaky,
    passAnyRate: stability.eligible === 0 ? 0 : stability.passAny / stability.eligible,
    passAllRate: stability.eligible === 0 ? 0 : stability.passAll / stability.eligible,
    gradedCount: graded.length,
    passRate: graded.length === 0 ? 0 : passed / graded.length,
    editApplyRate,
    // Averages stay finite even when one row reports non-finite telemetry
    // (runWstack guards its parse, but an injected/mocked TaskResult may not):
    // non-finite values count as 0 in the average, matching the timeouts.
    avgCostUsd: finiteSum(results, (r) => r.run.costUsd) / attemptCount,
    avgTokensIn: finiteSum(results, (r) => r.run.tokensIn) / attemptCount,
    avgTokensOut: finiteSum(results, (r) => r.run.tokensOut) / attemptCount,
    p50Iterations: median(results.map((r) => r.run.iterations)),
    p50ElapsedMs: median(results.map((r) => r.run.elapsedMs)),
    timeoutRate: timeouts / attemptCount,
    totalRateLimitRetries: sum(results, (r) => r.tools.rateLimitRetries),
  };
  if (traceEval) cellResult.traceEval = traceEval;
  return cellResult;
}

/**
 * Fold per-task attempt outcomes into pass@k / all-pass / flaky counts. Only
 * tasks with at least one graded attempt are eligible — an entirely ungraded
 * task (SWE-bench predictions exported for offline grading) must not count as
 * a failure in any of the three.
 */
function foldTaskStability(byTask: Map<string, TaskResult[]>): {
  eligible: number;
  passAny: number;
  passAll: number;
  flaky: number;
} {
  let eligible = 0;
  let passAny = 0;
  let passAll = 0;
  let flaky = 0;
  for (const attempts of byTask.values()) {
    const graded = attempts.filter((r) => r.grade.graded !== false);
    if (graded.length === 0) continue;
    eligible++;
    const passes = graded.filter((r) => r.grade.passed).length;
    if (passes > 0) passAny++;
    if (passes === graded.length) passAll++;
    if (passes > 0 && passes < graded.length) flaky++;
  }
  return { eligible, passAny, passAll, flaky };
}

/**
 * Fold transcript-mined cases into an ordered conditional funnel. A recall
 * miss after failed retrieval is intentionally excluded from recall's
 * denominator; likewise application is measured only after a correct model
 * intent. That makes the three numbers diagnostic instead of overlapping.
 */
function aggregateTraceEval(results: TaskResult[]): TraceEvalMetrics | undefined {
  const traces = results.flatMap((result) => (result.traceEval ? [result.traceEval] : []));
  if (traces.length === 0) return undefined;

  const retrieval = rate(traces.length, traces.filter((trace) => trace.retrievalPassed).length);
  const recallEligible = traces.filter((trace) => trace.retrievalPassed);
  const recallGivenRetrieval = rate(
    recallEligible.length,
    recallEligible.filter((trace) => trace.recallPassed).length,
  );
  const applicationEligible = recallEligible.filter((trace) => trace.recallPassed);
  const editApplicationGivenRecall = rate(
    applicationEligible.length,
    applicationEligible.filter((trace) => trace.editApplicationPassed).length,
  );

  return { retrieval, recallGivenRetrieval, editApplicationGivenRecall };
}

function rate(eligible: number, passed: number): ConditionalRate {
  return { eligible, passed, rate: eligible === 0 ? undefined : passed / eligible };
}

/** Group all results by cell label and aggregate each group. */
export function aggregateAll(cells: ModelCell[], results: TaskResult[]): CellResult[] {
  return cells.map((cell) =>
    aggregateCell(
      cell,
      results.filter((r) => r.cell.label === cell.label),
    ),
  );
}

/** Median of a numeric array (0 for empty). Exported for tests. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += pick(item);
  return total;
}

/** Sum of finite values only; NaN/Infinity contribute 0 so the cell average
 *  never becomes Infinity/NaN from a single malformed row. */
function finiteSum<T>(items: T[], pick: (item: T) => number): number {
  let total = 0;
  for (const item of items) {
    const v = pick(item);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}
