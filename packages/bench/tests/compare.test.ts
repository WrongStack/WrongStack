import { describe, expect, it } from 'vitest';
import { buildIntraRunInsights, compareReports } from '../src/compare.js';
import { renderComparisonMarkdown, renderMarkdownReport } from '../src/report/markdown.js';
import type { BenchReport, HarnessFingerprint, ModelCell, TaskResult } from '../src/types.js';

const FP: HarnessFingerprint = {
  cliVersion: '0.320.0',
  toolNames: ['read', 'write'],
  maxIterations: 20,
  yolo: true,
  subsetId: 'smoke:abc',
  hash: 'deadbeef0001',
};

const opus: ModelCell = { label: 'opus', provider: 'anthropic', model: 'claude-opus-4-8' };
const haiku: ModelCell = { label: 'haiku', provider: 'anthropic', model: 'claude-haiku-4-5' };

function result(
  taskId: string,
  cell: ModelCell,
  passed: boolean,
  over: Partial<TaskResult['run']> = {},
): TaskResult {
  return {
    taskId,
    cell,
    run: {
      status: 'completed',
      finalText: 'done',
      iterations: 3,
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.02,
      elapsedMs: 1000,
      exitCode: 0,
      ...over,
    },
    grade: { passed },
    tools: { totalCalls: 4, editCalls: 1, editErrors: 0, rateLimitRetries: 0 },
  };
}

function report(results: TaskResult[], fingerprint: HarnessFingerprint = FP): BenchReport {
  const cells = [opus, haiku]
    .map((cell) => {
      const rows = results.filter((r) => r.cell.label === cell.label);
      if (rows.length === 0) return undefined;
      const graded = rows.filter((r) => r.grade.graded !== false);
      const passed = graded.filter((r) => r.grade.passed).length;
      return {
        cell,
        taskCount: rows.length,
        gradedCount: graded.length,
        passRate: graded.length === 0 ? 0 : passed / graded.length,
        editApplyRate: 1,
        avgCostUsd: 0.02,
        avgTokensIn: 100,
        avgTokensOut: 50,
        p50Iterations: 3,
        p50ElapsedMs: 1000,
        timeoutRate: 0,
        totalRateLimitRetries: 0,
      };
    })
    .filter((c) => c !== undefined);
  return {
    suite: 'smoke',
    finishedAt: '2026-09-04T00:00:00Z',
    fingerprint,
    cells,
    results,
  };
}

describe('buildIntraRunInsights', () => {
  it('flags tasks where models split and lists unanimous rows', () => {
    const insights = buildIntraRunInsights([
      result('smoke/add-banner', opus, true),
      result('smoke/add-banner', haiku, false),
      result('smoke/rename-export', opus, true),
      result('smoke/rename-export', haiku, true),
      result('smoke/strip-todo', opus, false),
      result('smoke/strip-todo', haiku, false),
    ]);
    expect(insights.disagreements.map((d) => d.taskId)).toEqual(['smoke/add-banner']);
    expect(insights.unanimousPass).toEqual(['smoke/rename-export']);
    expect(insights.unanimousFail).toEqual(['smoke/strip-todo']);
  });

  it('records tasks with no graded verdict as ungraded', () => {
    const insights = buildIntraRunInsights([
      {
        ...result('smoke/add-banner', opus, false),
        grade: { passed: false, graded: false },
      },
    ]);
    expect(insights.ungraded).toEqual(['smoke/add-banner']);
    expect(insights.disagreements).toEqual([]);
  });
});

describe('compareReports', () => {
  it('computes pass-rate deltas and flipped tasks when fingerprints match', () => {
    const baseline = report([
      result('smoke/add-banner', opus, false),
      result('smoke/add-banner', haiku, false),
    ]);
    const candidate = report([
      result('smoke/add-banner', opus, true),
      result('smoke/add-banner', haiku, false),
    ]);
    const comparison = compareReports(baseline, candidate);
    expect(comparison.comparable).toBe(true);
    expect(comparison.flipped).toHaveLength(1);
    expect(comparison.flipped[0]?.cellLabel).toBe('opus');
    expect(comparison.cells.find((c) => c.label === 'opus')?.passRateDelta).toBe(1);
  });

  it('lists unmatched cells and extra fingerprint fields', () => {
    const baseline = report([result('smoke/add-banner', opus, true)]);
    const candidate = report([result('smoke/add-banner', haiku, true)], {
      ...FP,
      hash: 'other',
      toolManifestHash: 'aaaa',
      systemPromptHash: 'bbbb',
      configHash: 'cccc',
      maxIterations: 40,
      yolo: false,
      subsetId: 'smoke:other',
    });
    const comparison = compareReports(baseline, candidate);
    expect(comparison.comparable).toBe(false);
    expect(comparison.cells.map((c) => c.label).sort()).toEqual(['haiku', 'opus']);
    expect(comparison.reasons.some((r) => r.includes('tool manifest'))).toBe(true);
    expect(comparison.reasons.some((r) => r.includes('system prompt'))).toBe(true);
    expect(comparison.reasons.some((r) => r.includes('config hash'))).toBe(true);
    expect(comparison.reasons.some((r) => r.includes('maxIterations'))).toBe(true);
  });

  it('marks a fingerprint mismatch as not comparable but still emits deltas', () => {
    const baseline = report([result('smoke/add-banner', opus, true)]);
    const candidate = report([result('smoke/add-banner', opus, false)], {
      ...FP,
      hash: 'cafebabe0002',
      cliVersion: '0.321.0',
    });
    const comparison = compareReports(baseline, candidate);
    expect(comparison.comparable).toBe(false);
    expect(comparison.reasons.some((r) => r.includes('fingerprint hash'))).toBe(true);
    expect(comparison.flipped).toHaveLength(1);
  });
});

describe('renderMarkdownReport insights', () => {
  it('appends a per-task matrix and disagreement table when results are present', () => {
    const md = renderMarkdownReport(
      report([
        result('smoke/add-banner', opus, true),
        result('smoke/add-banner', haiku, false),
        result('smoke/rename-export', opus, true),
        result('smoke/rename-export', haiku, true),
      ]),
    );
    expect(md).toContain('## Per-task matrix');
    expect(md).toContain('## Where models disagreed');
    expect(md).toContain('## Cost vs quality');
    expect(md).toContain('smoke/add-banner');
    expect(md).toMatch(/PASS/);
    expect(md).toMatch(/fail/);
  });
});

describe('renderComparisonMarkdown', () => {
  it('renders flipped tasks and signed deltas', () => {
    const comparison = compareReports(
      report([result('smoke/add-banner', opus, false)]),
      report([result('smoke/add-banner', opus, true)]),
    );
    const md = renderComparisonMarkdown(comparison);
    expect(md).toContain('**Comparable:**');
    expect(md).toContain('smoke/add-banner');
    expect(md).toContain('+100.0pp');
  });

  it('calls out a fingerprint mismatch and a no-flip overlap', () => {
    const baseline = report([result('smoke/add-banner', opus, true)]);
    const candidate = report([result('smoke/add-banner', opus, true)], { ...FP, hash: 'other' });
    const mismatched = compareReports(baseline, { ...candidate, suite: 'local' });
    const md = renderComparisonMarkdown(mismatched);
    expect(md).toContain('**Not comparable:**');
    expect(md).toContain('suite mismatch');
    expect(md).toContain('No shared (task × model) cell changed');
  });

  it('renders unmatched models and cheaper/faster candidate deltas', () => {
    const baseline = report([
      result('smoke/add-banner', opus, true),
      result('smoke/add-banner', haiku, true),
    ]);
    const candidate = report([result('smoke/add-banner', opus, true)]);
    expect(baseline.cells.map((c) => c.cell.label)).toEqual(['opus', 'haiku']);
    expect(candidate.cells.map((c) => c.cell.label)).toEqual(['opus']);
    baseline.cells[0]!.avgCostUsd = 0.08;
    baseline.cells[0]!.p50ElapsedMs = 5000;
    baseline.cells[0]!.gradedCount = 0;
    candidate.cells[0]!.avgCostUsd = 0.02;
    candidate.cells[0]!.p50ElapsedMs = 1000;
    const md = renderComparisonMarkdown(compareReports(baseline, candidate));
    expect(md).toContain('haiku');
    expect(md).toContain('-$0.060');
    expect(md).toContain('-4.0s');
  });
});

describe('renderMarkdownReport edge outcomes', () => {
  it('shows timeout and ungraded cells in the matrix', () => {
    const md = renderMarkdownReport(
      report([
        {
          ...result('smoke/add-banner', opus, false, { status: 'timeout' }),
        },
        {
          ...result('smoke/add-banner', haiku, false),
          grade: { passed: false, graded: false },
        },
      ]),
    );
    expect(md).toContain('fail (timeout)');
    expect(md).toContain('ungraded');
  });

  it('labels a crashed agent as fail (crash)', () => {
    const md = renderMarkdownReport(
      report([
        {
          ...result('smoke/add-banner', opus, false, { status: 'crashed' }),
        },
      ]),
    );
    expect(md).toContain('fail (crash)');
  });

  it('omits the disagreement section when only one model ran', () => {
    const md = renderMarkdownReport(report([result('smoke/add-banner', opus, true)]));
    expect(md).toContain('## Per-task matrix');
    expect(md).not.toContain('## Where models disagreed');
  });

  it('reports unanimous agreement when every model matches', () => {
    const md = renderMarkdownReport(
      report([result('smoke/add-banner', opus, true), result('smoke/add-banner', haiku, true)]),
    );
    expect(md).toContain('No disagreements');
  });
});
