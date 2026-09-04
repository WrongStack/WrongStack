import type { BenchReport, CellResult, HarnessFingerprint, TaskResult } from './types.js';

/** Compact pass/fail view of one (task × cell) cell. */
export interface TaskOutcome {
  passed: boolean | null;
  graded: boolean;
  status: TaskResult['run']['status'];
  detail?: string | undefined;
  costUsd: number;
}

/** One task where at least two models in the same run disagreed. */
export interface IntraRunDisagreement {
  taskId: string;
  outcomes: Array<{ label: string; outcome: TaskOutcome }>;
}

/** Diagnostic view of a single run: leaderboard plus where models split. */
export interface IntraRunInsights {
  taskIds: string[];
  cellLabels: string[];
  /** taskId → cellLabel → outcome */
  matrix: Record<string, Record<string, TaskOutcome>>;
  disagreements: IntraRunDisagreement[];
  unanimousPass: string[];
  unanimousFail: string[];
  ungraded: string[];
}

export interface CellDelta {
  label: string;
  baseline?: CellResult | undefined;
  candidate?: CellResult | undefined;
  passRateDelta?: number | undefined;
  avgCostUsdDelta?: number | undefined;
  p50ElapsedMsDelta?: number | undefined;
  timeoutRateDelta?: number | undefined;
  editApplyRateDelta?: number | undefined;
}

export interface CrossRunTaskDelta {
  taskId: string;
  cellLabel: string;
  baseline: TaskOutcome;
  candidate: TaskOutcome;
}

/** Two finished runs, folded into deltas. Comparable only when fingerprints match. */
export interface RunComparison {
  comparable: boolean;
  reasons: string[];
  baseline: Pick<BenchReport, 'suite' | 'finishedAt' | 'fingerprint'>;
  candidate: Pick<BenchReport, 'suite' | 'finishedAt' | 'fingerprint'>;
  cells: CellDelta[];
  flipped: CrossRunTaskDelta[];
  sharedTaskCount: number;
  sharedCellCount: number;
}

export function outcomeFromResult(result: TaskResult): TaskOutcome {
  const graded = result.grade.graded !== false;
  return {
    passed: graded ? result.grade.passed : null,
    graded,
    status: result.run.status,
    detail: result.grade.detail,
    costUsd: result.run.costUsd,
  };
}

/** Build the per-task matrix and intra-run disagreements from raw rows. */
export function buildIntraRunInsights(results: TaskResult[]): IntraRunInsights {
  const taskIds: string[] = [];
  const seenTasks = new Set<string>();
  const cellLabels: string[] = [];
  const seenCells = new Set<string>();
  const matrix: Record<string, Record<string, TaskOutcome>> = {};

  for (const row of results) {
    if (!seenTasks.has(row.taskId)) {
      seenTasks.add(row.taskId);
      taskIds.push(row.taskId);
    }
    if (!seenCells.has(row.cell.label)) {
      seenCells.add(row.cell.label);
      cellLabels.push(row.cell.label);
    }
    const byCell = matrix[row.taskId] ?? (matrix[row.taskId] = {});
    byCell[row.cell.label] = outcomeFromResult(row);
  }

  const disagreements: IntraRunDisagreement[] = [];
  const unanimousPass: string[] = [];
  const unanimousFail: string[] = [];
  const ungraded: string[] = [];

  for (const taskId of taskIds) {
    const byCell = matrix[taskId] ?? {};
    const outcomes = cellLabels.map((label) => ({
      label,
      outcome: byCell[label] ?? {
        passed: null,
        graded: false,
        status: 'crashed' as const,
        costUsd: 0,
      },
    }));
    const graded = outcomes.filter(
      (entry) => entry.outcome.graded && entry.outcome.passed !== null,
    );
    if (graded.length === 0) {
      ungraded.push(taskId);
      continue;
    }
    const passes = graded.filter((entry) => entry.outcome.passed === true).length;
    if (passes === graded.length) unanimousPass.push(taskId);
    else if (passes === 0) unanimousFail.push(taskId);
    else disagreements.push({ taskId, outcomes });
  }

  return {
    taskIds,
    cellLabels,
    matrix,
    disagreements,
    unanimousPass,
    unanimousFail,
    ungraded,
  };
}

/**
 * Diff two finished reports. A fingerprint mismatch does not abort — the
 * reasons array explains why the numbers are not apples-to-apples, and the
 * numeric deltas are still emitted so a harness change is visible rather than
 * silent.
 */
export function compareReports(baseline: BenchReport, candidate: BenchReport): RunComparison {
  const reasons: string[] = [];
  if (baseline.suite !== candidate.suite) {
    reasons.push(`suite mismatch: ${baseline.suite} vs ${candidate.suite}`);
  }
  reasons.push(...fingerprintDiff(baseline.fingerprint, candidate.fingerprint));

  const baselineInsights = buildIntraRunInsights(baseline.results);
  const candidateInsights = buildIntraRunInsights(candidate.results);
  const sharedTasks = baselineInsights.taskIds.filter((id) =>
    candidateInsights.taskIds.includes(id),
  );
  const sharedCells = baselineInsights.cellLabels.filter((label) =>
    candidateInsights.cellLabels.includes(label),
  );

  const cells: CellDelta[] = mergeCellLabels(baseline.cells, candidate.cells).map((label) => {
    const base = baseline.cells.find((c) => c.cell.label === label);
    const cand = candidate.cells.find((c) => c.cell.label === label);
    const delta: CellDelta = { label, baseline: base, candidate: cand };
    if (base && cand) {
      delta.passRateDelta = cand.passRate - base.passRate;
      delta.avgCostUsdDelta = cand.avgCostUsd - base.avgCostUsd;
      delta.p50ElapsedMsDelta = cand.p50ElapsedMs - base.p50ElapsedMs;
      delta.timeoutRateDelta = cand.timeoutRate - base.timeoutRate;
      delta.editApplyRateDelta = cand.editApplyRate - base.editApplyRate;
    }
    return delta;
  });

  const flipped: CrossRunTaskDelta[] = [];
  for (const taskId of sharedTasks) {
    for (const cellLabel of sharedCells) {
      const base = baselineInsights.matrix[taskId]?.[cellLabel];
      const cand = candidateInsights.matrix[taskId]?.[cellLabel];
      if (!base || !cand) continue;
      if (base.passed !== cand.passed || base.graded !== cand.graded) {
        flipped.push({ taskId, cellLabel, baseline: base, candidate: cand });
      }
    }
  }

  return {
    comparable: reasons.length === 0,
    reasons,
    baseline: {
      suite: baseline.suite,
      finishedAt: baseline.finishedAt,
      fingerprint: baseline.fingerprint,
    },
    candidate: {
      suite: candidate.suite,
      finishedAt: candidate.finishedAt,
      fingerprint: candidate.fingerprint,
    },
    cells,
    flipped,
    sharedTaskCount: sharedTasks.length,
    sharedCellCount: sharedCells.length,
  };
}

function mergeCellLabels(a: CellResult[], b: CellResult[]): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const row of [...a, ...b]) {
    if (seen.has(row.cell.label)) continue;
    seen.add(row.cell.label);
    labels.push(row.cell.label);
  }
  return labels;
}

function fingerprintDiff(a: HarnessFingerprint, b: HarnessFingerprint): string[] {
  const reasons: string[] = [];
  if (a.hash !== b.hash) reasons.push(`fingerprint hash mismatch: ${a.hash} vs ${b.hash}`);
  if (a.cliVersion !== b.cliVersion) {
    reasons.push(`cliVersion: ${a.cliVersion} vs ${b.cliVersion}`);
  }
  if (a.subsetId !== b.subsetId) reasons.push(`subset: ${a.subsetId} vs ${b.subsetId}`);
  if (a.maxIterations !== b.maxIterations) {
    reasons.push(`maxIterations: ${a.maxIterations} vs ${b.maxIterations}`);
  }
  if (a.yolo !== b.yolo) reasons.push(`yolo: ${a.yolo} vs ${b.yolo}`);
  if ((a.toolManifestHash ?? '') !== (b.toolManifestHash ?? '')) {
    reasons.push('tool manifest hash differs');
  }
  if ((a.systemPromptHash ?? '') !== (b.systemPromptHash ?? '')) {
    reasons.push('system prompt hash differs');
  }
  if ((a.configHash ?? '') !== (b.configHash ?? '')) reasons.push('config hash differs');
  return reasons;
}
