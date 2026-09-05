import {
  buildIntraRunInsights,
  type CellDelta,
  type RunComparison,
  type TaskOutcome,
} from '../compare.js';
import { fingerprintLabel } from '../fingerprint.js';
import type { BenchReport, CellResult, HarnessFingerprint, TaskResult } from '../types.js';

/**
 * Render the human-facing leaderboard. The header carries the harness
 * fingerprint: rows are only comparable across reports that share it. The body
 * sorts cells by pass rate (the headline correctness metric), highest first.
 *
 * When `results` is present, a per-task matrix and intra-run disagreement
 * section are appended so a single run is already a model-vs-model comparison.
 */
export function renderMarkdownReport(
  report: Pick<BenchReport, 'suite' | 'finishedAt' | 'fingerprint' | 'cells'> & {
    results?: TaskResult[] | undefined;
  },
): string {
  const { suite, finishedAt, fingerprint, cells } = report;
  const lines: string[] = [];

  lines.push(`# WrongStack benchmark — ${suite}`);
  lines.push('');
  lines.push(`**Harness:** ${fingerprintLabel(fingerprint)}`);
  lines.push(`**Finished:** ${finishedAt}`);
  lines.push(`**Tasks/cell:** ${cells[0]?.taskCount ?? 0}`);
  const repeats = Math.max(1, ...cells.map((c) => c.repeats ?? 1));
  if (repeats > 1) {
    lines.push(`**Attempts/task:** ${repeats} (pass@1 is measured over every attempt)`);
  }
  lines.push('');
  lines.push(
    "Grading is deterministic (the suite's own tests decide pass/fail — no LLM judge). " +
      'The only variable across rows is the model; everything else is fixed by the harness fingerprint.',
  );
  lines.push('');

  const sorted = [...cells].sort((a, b) => b.passRate - a.passRate);
  const hasTraceEval = cells.some((cell) => cell.traceEval !== undefined);
  const showRepeats = repeats > 1;

  if (showRepeats) {
    lines.push(
      '| Model | Pass@1 | Pass@' +
        repeats +
        ' | All-pass | Flaky tasks | Edit-apply | $/task | tok in/out | iters (p50) | wall (p50) | timeout | 429s |',
    );
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  } else if (hasTraceEval) {
    lines.push(
      '| Model | Pass@1 | Retrieval | Recall (given retrieval) | Edit application (given recall) | Tool edit-apply | $/task | tok in/out | iters (p50) | wall (p50) | timeout | 429s |',
    );
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  } else {
    lines.push(
      '| Model | Pass@1 | Edit-apply | $/task | tok in/out | iters (p50) | wall (p50) | timeout | 429s |',
    );
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  }
  for (const c of sorted) {
    lines.push(showRepeats ? renderRepeatRow(c) : renderRow(c, hasTraceEval));
  }
  lines.push('');
  if (showRepeats) {
    lines.push(
      `_Pass@1 is the share of all ${repeats} attempts that passed; Pass@${repeats} is the share of tasks ` +
        'solved at least once; All-pass is the share solved every time. Flaky tasks split their own attempts — ' +
        'a large flaky count means the gap between two models may be noise.',
    );
    lines.push('');
  }
  const incomplete = cells.reduce((total, c) => total + (c.incompleteCount ?? 0), 0);
  if (incomplete > 0) {
    lines.push(
      `> ⚠ ${incomplete} attempt(s) timed out or crashed before reporting usage. Their tokens and cost ` +
        'are counted as zero, so the $/task and token columns are lower bounds.',
    );
    lines.push('');
  }
  if (hasTraceEval) {
    lines.push(
      '_Trace metrics are a causal funnel: retrieval observes expected evidence; recall is scored only after retrieval; edit application is scored only after a correct edit intent._',
    );
    lines.push('');
  }
  lines.push(
    `_Fingerprint hash: \`${fingerprint.hash}\` · tools: ${fingerprint.toolNames.length} · subset: \`${fingerprint.subsetId}\`_`,
  );
  lines.push('');

  if (cells.length > 0) {
    lines.push(...renderCostQuality(cells));
  }

  if (report.results && report.results.length > 0) {
    lines.push(...renderInsights(report.results));
    lines.push(...renderFailures(report.results));
  }

  return lines.join('\n');
}

/**
 * List what actually went wrong. A leaderboard with no failure detail forces
 * whoever reads it back into results.jsonl; the graders already carry the
 * failing test names, and the runner now carries the agent's own error.
 */
function renderFailures(results: TaskResult[]): string[] {
  const failures = results.filter((row) => row.grade.graded !== false && !row.grade.passed);
  if (failures.length === 0) return [];
  const lines: string[] = [
    '## Failures',
    '',
    `${failures.length} failing (task × model) row(s).`,
    '',
  ];
  for (const row of failures) {
    const attempt = row.attempt !== undefined ? ` #${row.attempt}` : '';
    lines.push(`- **${row.taskId}** · ${row.cell.label}${attempt} — \`${row.run.status}\``);
    const detail = (row.grade.detail ?? '').trim();
    if (detail.length === 0) continue;
    lines.push('  ```');
    for (const line of clampDetail(detail).split('\n')) lines.push(`  ${line}`);
    lines.push('  ```');
  }
  lines.push('');
  return lines;
}

/** Keep each failure block readable: first 12 lines, 800 chars. */
function clampDetail(detail: string): string {
  const byLine = detail.split('\n');
  const head = byLine.slice(0, 12).join('\n');
  const clipped = head.length > 800 ? `${head.slice(0, 800)}…` : head;
  return byLine.length > 12 ? `${clipped}\n… (${byLine.length - 12} more line(s))` : clipped;
}

/** Escape a value for interpolation into a markdown table cell so a literal
 * `|` (e.g. in user-supplied cell labels) cannot terminate the cell early.
 * Mirrors markdownCell() in scripts/generate-provider-catalog.mjs. */
function markdownCell(value: string): string {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function renderCostQuality(cells: CellResult[]): string[] {
  const lines: string[] = [
    '## Cost vs quality',
    '',
    '| Model | Pass@1 | $/task | Pass per $ |',
    '|---|---:|---:|---:|',
  ];
  const ranked = [...cells].sort((a, b) => passPerDollar(b) - passPerDollar(a));
  for (const c of ranked) {
    const passCell = c.gradedCount === 0 ? '—' : pct(c.passRate);
    const finiteCost = Number.isFinite(c.avgCostUsd);
    const efficiency = finiteCost && c.avgCostUsd > 0 && c.gradedCount > 0 ? passPerDollar(c).toFixed(1) : '—';
    lines.push(`| ${markdownCell(c.cell.label)} | ${passCell} | $${usd(c.avgCostUsd)} | ${efficiency} |`);
  }
  lines.push('');
  lines.push(
    '_Pass per $ is Pass@1 / average USD per task. Higher is better. Zero-cost rows show —._',
  );
  lines.push('');
  return lines;
}

function passPerDollar(c: CellResult): number {
  if (c.avgCostUsd <= 0 || c.gradedCount === 0) return 0;
  return c.passRate / c.avgCostUsd;
}

function renderInsights(results: TaskResult[]): string[] {
  const insights = buildIntraRunInsights(results);
  const lines: string[] = [
    '## Per-task matrix',
    '',
    `| Task | ${insights.cellLabels.map(markdownCell).join(' | ')} |`,
    `|---|${insights.cellLabels.map(() => '---').join('|')}|`,
  ];
  for (const taskId of insights.taskIds) {
    const cells = insights.cellLabels.map((label) =>
      formatOutcome(insights.matrix[taskId]?.[label]),
    );
    lines.push(`| ${markdownCell(taskId)} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  if (insights.cellLabels.length < 2) return lines;

  lines.push('## Where models disagreed');
  lines.push('');
  if (insights.disagreements.length === 0) {
    lines.push(
      `No disagreements across ${insights.cellLabels.length} models ` +
        `(${insights.unanimousPass.length} unanimous pass, ${insights.unanimousFail.length} unanimous fail).`,
    );
    lines.push('');
    return lines;
  }

  lines.push(
    `${insights.disagreements.length} task(s) split the field. ` +
      `Unanimous pass: ${insights.unanimousPass.length}. Unanimous fail: ${insights.unanimousFail.length}.`,
  );
  lines.push('');
  lines.push(`| Task | ${insights.cellLabels.join(' | ')} |`);
  lines.push(`|---|${insights.cellLabels.map(() => '---').join('|')}|`);
  for (const row of insights.disagreements) {
    const cells = insights.cellLabels.map((label) => {
      const entry = row.outcomes.find((o) => o.label === label);
      return formatOutcome(entry?.outcome);
    });
    lines.push(`| ${markdownCell(row.taskId)} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  return lines;
}

function formatOutcome(outcome: TaskOutcome | undefined): string {
  if (!outcome) return '—';
  if (!outcome.graded) return 'ungraded';
  if (outcome.passed === true) return 'PASS';
  if (outcome.status === 'timeout') return 'fail (timeout)';
  if (outcome.status === 'crashed') return 'fail (crash)';
  return 'fail';
}

/**
 * Render a baseline-vs-candidate comparison. Fingerprint mismatches are
 * called out at the top so a harness change cannot masquerade as a model win.
 */
export function renderComparisonMarkdown(comparison: RunComparison): string {
  const lines: string[] = [];
  lines.push('# WrongStack benchmark comparison');
  lines.push('');
  lines.push(
    comparison.comparable
      ? '**Comparable:** harness fingerprints match. Deltas are model/run variance, not a harness change.'
      : '**Not comparable:** harness fingerprints differ. Read the deltas as directional, not as a leaderboard.',
  );
  lines.push('');
  if (comparison.reasons.length > 0) {
    lines.push('Mismatches:');
    for (const reason of comparison.reasons) lines.push(`- ${reason}`);
    lines.push('');
  }
  lines.push(
    `**Baseline:** ${comparison.baseline.suite} · ${comparison.baseline.finishedAt} · \`${comparison.baseline.fingerprint.hash}\``,
  );
  lines.push(
    `**Candidate:** ${comparison.candidate.suite} · ${comparison.candidate.finishedAt} · \`${comparison.candidate.fingerprint.hash}\``,
  );
  lines.push(
    `**Overlap:** ${comparison.sharedTaskCount} shared task(s), ${comparison.sharedCellCount} shared model(s).`,
  );
  lines.push('');

  lines.push('## Leaderboard deltas');
  lines.push('');
  lines.push(
    '| Model | Pass@1 (base → cand) | Δ Pass@1 | $/task (base → cand) | Δ $ | wall p50 Δ | timeout Δ |',
  );
  lines.push('|---|---|---:|---|---:|---:|---:|');
  for (const cell of comparison.cells) {
    lines.push(renderDeltaRow(cell));
  }
  lines.push('');

  lines.push('## Tasks that flipped');
  lines.push('');
  if (comparison.flipped.length === 0) {
    lines.push('No shared (task × model) cell changed pass/fail between the two runs.');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('| Task | Model | Baseline | Candidate |');
  lines.push('|---|---|---|---|');
  for (const row of comparison.flipped) {
    lines.push(
      `| ${markdownCell(row.taskId)} | ${markdownCell(row.cellLabel)} | ${formatOutcome(row.baseline)} | ${formatOutcome(row.candidate)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function renderDeltaRow(cell: CellDelta): string {
  const basePass = formatCellPass(cell.baseline);
  const candPass = formatCellPass(cell.candidate);
  const passArrow = `${basePass} → ${candPass}`;
  const costArrow =
    cell.baseline && cell.candidate
      ? `$${usd(cell.baseline.avgCostUsd)} → $${usd(cell.candidate.avgCostUsd)}`
      : '—';
  return [
    '',
    markdownCell(cell.label),
    passArrow,
    signedPct(cell.passRateDelta),
    costArrow,
    signedUsd(cell.avgCostUsdDelta),
    signedMs(cell.p50ElapsedMsDelta),
    signedPct(cell.timeoutRateDelta),
    '',
  ]
    .join(' | ')
    .trim();
}

function formatCellPass(cell: CellResult | undefined): string {
  if (!cell) return '—';
  if (cell.gradedCount === 0) return '—';
  return pct(cell.passRate);
}

function signedPct(delta: number | undefined): string {
  if (delta === undefined || !Number.isFinite(delta)) return '—';
  const value = `${(delta * 100).toFixed(1)}pp`;
  if (delta > 0) return `+${value}`;
  return value;
}

function signedUsd(delta: number | undefined): string {
  if (delta === undefined || !Number.isFinite(delta)) return '—';
  const value = `$${Math.abs(delta).toFixed(3)}`;
  if (delta > 0) return `+${value}`;
  if (delta < 0) return `-${value}`;
  return value;
}

function signedMs(delta: number | undefined): string {
  if (delta === undefined) return '—';
  const formatted = delta >= 0 ? fmtMs(delta) : `-${fmtMs(-delta)}`;
  if (delta > 0) return `+${formatted}`;
  return formatted;
}

function renderRow(c: CellResult, hasTraceEval: boolean): string {
  // No graded rows (e.g. SWE-bench predictions exported for offline grading) →
  // show a dash rather than a misleading 0%.
  const attempts = c.attemptCount ?? c.taskCount;
  const passCell =
    c.gradedCount === 0
      ? '—'
      : c.gradedCount < attempts
        ? `${pct(c.passRate)} (${c.gradedCount}/${attempts})`
        : pct(c.passRate);
  const traceCells = hasTraceEval
    ? [
        conditionalPct(c.traceEval?.retrieval),
        conditionalPct(c.traceEval?.recallGivenRetrieval),
        conditionalPct(c.traceEval?.editApplicationGivenRecall),
      ]
    : [];
  return [
    '',
    markdownCell(c.cell.label),
    passCell,
    ...traceCells,
    pct(c.editApplyRate),
    `$${usd(c.avgCostUsd)}`,
    `${fmtK(c.avgTokensIn)}/${fmtK(c.avgTokensOut)}`,
    fmtN(c.p50Iterations),
    fmtMs(c.p50ElapsedMs),
    pct(c.timeoutRate),
    String(c.totalRateLimitRetries),
    '',
  ]
    .join(' | ')
    .trim();
}

/** Leaderboard row for a repeated run: pass@1 next to pass@k and flakiness. */
function renderRepeatRow(c: CellResult): string {
  const attempts = c.attemptCount ?? c.taskCount;
  const passCell =
    c.gradedCount === 0
      ? '—'
      : c.gradedCount < attempts
        ? `${pct(c.passRate)} (${c.gradedCount}/${attempts})`
        : pct(c.passRate);
  return [
    '',
    markdownCell(c.cell.label),
    passCell,
    c.gradedCount === 0 ? '—' : pct(c.passAnyRate ?? 0),
    c.gradedCount === 0 ? '—' : pct(c.passAllRate ?? 0),
    `${c.flakyTaskCount ?? 0}/${c.taskCount}`,
    pct(c.editApplyRate),
    `$${usd(c.avgCostUsd)}`,
    `${fmtK(c.avgTokensIn)}/${fmtK(c.avgTokensOut)}`,
    fmtN(c.p50Iterations),
    fmtMs(c.p50ElapsedMs),
    pct(c.timeoutRate),
    String(c.totalRateLimitRetries),
    '',
  ]
    .join(' | ')
    .trim();
}

function conditionalPct(
  metric: { passed: number; eligible: number; rate: number | undefined } | undefined,
): string {
  if (!metric || metric.rate === undefined) return '—';
  return `${pct(metric.rate)} (${metric.passed}/${metric.eligible})`;
}

function pct(x: number): string {
  // The report can receive hand-built or legacy CellResult objects that did
  // not go through aggregateCell's clamping; guard against NaN and out-of-range
  // values so the rendered leaderboard never shows "NaN%" or a negative/over-1
  // percentage.
  if (!Number.isFinite(x)) return '—';
  const clamped = Math.max(0, Math.min(1, x));
  return `${(clamped * 100).toFixed(1)}%`;
}

/** Money column: guard non-finite cost so "$NaN" never leaks into a report. */
function usd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(3);
}

function fmtK(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Whole-number column (e.g. iterations); NaN/Infinity never renders as "NaN". */
function fmtN(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n));
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** Build the full fingerprint-stamped header line for terminal echo. */
export function reportHeaderLine(fp: HarnessFingerprint): string {
  return fingerprintLabel(fp);
}
