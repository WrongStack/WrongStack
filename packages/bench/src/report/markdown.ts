import { fingerprintLabel } from '../fingerprint.js';
import type { BenchReport, CellResult, HarnessFingerprint } from '../types.js';

/**
 * Render the human-facing leaderboard. The header carries the harness
 * fingerprint: rows are only comparable across reports that share it. The body
 * sorts cells by pass rate (the headline correctness metric), highest first.
 */
export function renderMarkdownReport(
  report: Pick<BenchReport, 'suite' | 'finishedAt' | 'fingerprint' | 'cells'>,
): string {
  const { suite, finishedAt, fingerprint, cells } = report;
  const lines: string[] = [];

  lines.push(`# WrongStack benchmark — ${suite}`);
  lines.push('');
  lines.push(`**Harness:** ${fingerprintLabel(fingerprint)}`);
  lines.push(`**Finished:** ${finishedAt}`);
  lines.push(`**Tasks/cell:** ${cells[0]?.taskCount ?? 0}`);
  lines.push('');
  lines.push(
    "Grading is deterministic (the suite's own tests decide pass/fail — no LLM judge). " +
      'The only variable across rows is the model; everything else is fixed by the harness fingerprint.',
  );
  lines.push('');

  const sorted = [...cells].sort((a, b) => b.passRate - a.passRate);
  const hasTraceEval = cells.some((cell) => cell.traceEval !== undefined);

  if (hasTraceEval) {
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
    lines.push(renderRow(c, hasTraceEval));
  }
  lines.push('');
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

  return lines.join('\n');
}

function renderRow(c: CellResult, hasTraceEval: boolean): string {
  // No graded rows (e.g. SWE-bench predictions exported for offline grading) →
  // show a dash rather than a misleading 0%.
  const passCell =
    c.gradedCount === 0
      ? '—'
      : c.gradedCount < c.taskCount
        ? `${pct(c.passRate)} (${c.gradedCount}/${c.taskCount})`
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
    c.cell.label,
    passCell,
    ...traceCells,
    pct(c.editApplyRate),
    `$${c.avgCostUsd.toFixed(3)}`,
    `${fmtK(c.avgTokensIn)}/${fmtK(c.avgTokensOut)}`,
    String(Math.round(c.p50Iterations)),
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
  return `${(x * 100).toFixed(1)}%`;
}

function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** Build the full fingerprint-stamped header line for terminal echo. */
export function reportHeaderLine(fp: HarnessFingerprint): string {
  return fingerprintLabel(fp);
}
