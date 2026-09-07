import { describe, expect, it } from 'vitest';
import {
  renderComparisonMarkdown,
  renderMarkdownReport,
  reportHeaderLine,
} from '../src/report/markdown.js';
import type { HarnessFingerprint } from '../src/types.js';

const FP: HarnessFingerprint = {
  cliVersion: '0.260.0',
  toolNames: ['read', 'write', 'bash'],
  maxIterations: 40,
  yolo: false,
  subsetId: 'polyglot-10',
  hash: 'abc123def456',
};

const opus = { label: 'opus-4.8', provider: 'anthropic', model: 'claude-opus-4-8' };

describe('renderMarkdownReport — conditionalPct edge cases', () => {
  it('shows dash for trace-eval cells with undefined rates', () => {
    // When traceEval is present but the conditional rate is undefined
    // (eligible=0 → rate=undefined), conditionalPct returns '—'
    const md = renderMarkdownReport({
      suite: 'local',
      finishedAt: 'now',
      fingerprint: FP,
      cells: [
        {
          cell: opus,
          taskCount: 2,
          gradedCount: 2,
          passRate: 0.5,
          editApplyRate: 0.9,
          avgCostUsd: 0.1,
          avgTokensIn: 100,
          avgTokensOut: 50,
          p50Iterations: 5,
          p50ElapsedMs: 500,
          timeoutRate: 0,
          totalRateLimitRetries: 0,
          traceEval: {
            retrieval: { eligible: 2, passed: 1, rate: 0.5 },
            recallGivenRetrieval: { eligible: 0, passed: 0, rate: undefined },
            editApplicationGivenRecall: { eligible: 0, passed: 0, rate: undefined },
          },
        },
      ],
    });
    // For recall and edit-application columns, rate is undefined → dash
    const lines = md.split('\n');
    // Find the data row: has 'opus-4.8' and follows the header
    const dataLine = lines.find((l) => l.includes('opus-4.8'));
    expect(dataLine).toBeDefined();
    // Should contain dashes for undefined-rate columns
    expect(md).toContain('—');
  });

  it('shows dash for all conditional columns when traceEval.retrieval is undefined', () => {
    const md = renderMarkdownReport({
      suite: 'local',
      finishedAt: 'now',
      fingerprint: FP,
      cells: [
        {
          cell: opus,
          taskCount: 1,
          gradedCount: 1,
          passRate: 1,
          editApplyRate: 1,
          avgCostUsd: 0.01,
          avgTokensIn: 10,
          avgTokensOut: 5,
          p50Iterations: 1,
          p50ElapsedMs: 100,
          timeoutRate: 0,
          totalRateLimitRetries: 0,
          traceEval: {
            retrieval: { eligible: 0, passed: 0, rate: undefined },
            recallGivenRetrieval: { eligible: 0, passed: 0, rate: undefined },
            editApplicationGivenRecall: { eligible: 0, passed: 0, rate: undefined },
          },
        },
      ],
    });
    expect(md).toContain('—');
  });

  it('includes trace-eval columns when any cell has traceEval', () => {
    const md = renderMarkdownReport({
      suite: 'local',
      finishedAt: 'now',
      fingerprint: FP,
      cells: [
        {
          cell: opus,
          taskCount: 1,
          gradedCount: 1,
          passRate: 1,
          editApplyRate: 1,
          avgCostUsd: 0.01,
          avgTokensIn: 10,
          avgTokensOut: 5,
          p50Iterations: 1,
          p50ElapsedMs: 100,
          timeoutRate: 0,
          totalRateLimitRetries: 0,
          traceEval: {
            retrieval: { eligible: 1, passed: 1, rate: 1 },
            recallGivenRetrieval: { eligible: 1, passed: 1, rate: 1 },
            editApplicationGivenRecall: { eligible: 1, passed: 1, rate: 1 },
          },
        },
      ],
    });
    expect(md).toContain('Recall (given retrieval)');
    expect(md).toContain('Edit application (given recall)');
  });

  it('shows the trace-eval footnote when traceEval is present', () => {
    const md = renderMarkdownReport({
      suite: 'local',
      finishedAt: 'now',
      fingerprint: FP,
      cells: [
        {
          cell: opus,
          taskCount: 1,
          gradedCount: 1,
          passRate: 1,
          editApplyRate: 1,
          avgCostUsd: 0.01,
          avgTokensIn: 10,
          avgTokensOut: 5,
          p50Iterations: 1,
          p50ElapsedMs: 100,
          timeoutRate: 0,
          totalRateLimitRetries: 0,
          traceEval: {
            retrieval: { eligible: 1, passed: 1, rate: 1 },
            recallGivenRetrieval: { eligible: 1, passed: 1, rate: 1 },
            editApplicationGivenRecall: { eligible: 1, passed: 1, rate: 1 },
          },
        },
      ],
    });
    expect(md).toContain('causal funnel');
  });

  it('reportHeaderLine returns a tagged label', () => {
    expect(reportHeaderLine(FP)).toMatch(/fp:abc123/);
  });

  it('renders dash for non-finite values in pct, usd, fmtK, fmtN, fmtMs', () => {
    const md = renderMarkdownReport({
      suite: 'local',
      finishedAt: 'now',
      fingerprint: FP,
      cells: [
        {
          cell: opus,
          taskCount: 1,
          gradedCount: 1,
          passRate: Number.NaN,
          editApplyRate: Number.POSITIVE_INFINITY,
          avgCostUsd: Number.NaN,
          avgTokensIn: Number.NaN,
          avgTokensOut: Number.NaN,
          p50Iterations: Number.NaN,
          p50ElapsedMs: Number.NaN,
          timeoutRate: Number.NaN,
          totalRateLimitRetries: 0,
        },
      ],
    });
    expect(md).toContain('—');
  });

  it('renders positive, negative, and zero deltas in signedUsd and signedMs', () => {
    const md = renderComparisonMarkdown({
      comparable: true,
      reasons: [],
      baseline: { suite: 'smoke', finishedAt: 'now', fingerprint: FP },
      candidate: { suite: 'smoke', finishedAt: 'now', fingerprint: FP },
      cells: [
        {
          label: 'zero-delta',
          avgCostUsdDelta: 0,
          p50ElapsedMsDelta: 0,
        },
        {
          label: 'pos-delta',
          avgCostUsdDelta: 0.05,
          p50ElapsedMsDelta: 1500,
        },
      ],
      flipped: [],
      sharedTaskCount: 1,
      sharedCellCount: 2,
    });
    expect(md).toContain('$0.000');
    expect(md).toContain('+$0.050');
    expect(md).toContain('+1.5s');

    // Test signedPct with negative and zero deltas
    const mdPct = renderComparisonMarkdown({
      comparable: true,
      reasons: [],
      baseline: { suite: 'smoke', finishedAt: 'now', fingerprint: FP },
      candidate: { suite: 'smoke', finishedAt: 'now', fingerprint: FP },
      cells: [
        {
          label: 'neg-pct',
          passRateDelta: -0.1,
        },
        {
          label: 'zero-pct',
          passRateDelta: 0,
        },
        {
          label: 'pos-pct',
          passRateDelta: 0.1,
        },
      ],
      flipped: [],
      sharedTaskCount: 1,
      sharedCellCount: 3,
    });
    expect(mdPct).toContain('-10.0pp');
    expect(mdPct).toContain('0.0pp');
    expect(mdPct).toContain('+10.0pp');
  });

  it('renders repeated rows with partially graded, zero graded, and undefined fallback fields', () => {
    const md = renderMarkdownReport({
      suite: 'local',
      finishedAt: 'now',
      fingerprint: FP,
      cells: [
        {
          cell: opus,
          taskCount: 2,
          attemptCount: 4,
          repeats: 2,
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
        },
        {
          cell: { label: 'partial', provider: 'p', model: 'm' },
          taskCount: 2,
          attemptCount: 4,
          repeats: 2,
          gradedCount: 2,
          passRate: 0.5,
          passAnyRate: 0.5,
          passAllRate: 0.5,
          flakyTaskCount: 1,
          editApplyRate: 1,
          avgCostUsd: 0.01,
          avgTokensIn: 10,
          avgTokensOut: 10,
          p50Iterations: 1,
          p50ElapsedMs: 100,
          timeoutRate: 0,
          totalRateLimitRetries: 0,
        },
        {
          cell: { label: 'defaults', provider: 'p', model: 'm2' },
          taskCount: 2,
          repeats: 2,
          gradedCount: 2,
          passRate: 1,
          editApplyRate: 1,
          avgCostUsd: 0.01,
          avgTokensIn: 10,
          avgTokensOut: 10,
          p50Iterations: 1,
          p50ElapsedMs: 100,
          timeoutRate: 0,
          totalRateLimitRetries: 0,
        },
      ],
    });
    expect(md).toContain('Pass@1');
    expect(md).toContain('Pass@2');
    expect(md).toContain('(2/4)');
    expect(md).toContain('defaults');
  });

  it('truncates failure detail over 800 chars and renders missing matrix outcome', () => {
    const md = renderMarkdownReport({
      suite: 'local',
      finishedAt: 'now',
      fingerprint: FP,
      cells: [
        {
          cell: opus,
          taskCount: 2,
          gradedCount: 1,
          passRate: 0,
          editApplyRate: 1,
          avgCostUsd: 0.01,
          avgTokensIn: 10,
          avgTokensOut: 10,
          p50Iterations: 1,
          p50ElapsedMs: 100,
          timeoutRate: 0,
          totalRateLimitRetries: 0,
        },
        {
          cell: { label: 'other', provider: 'p', model: 'm' },
          taskCount: 2,
          gradedCount: 1,
          passRate: 1,
          editApplyRate: 1,
          avgCostUsd: 0.01,
          avgTokensIn: 10,
          avgTokensOut: 10,
          p50Iterations: 1,
          p50ElapsedMs: 100,
          timeoutRate: 0,
          totalRateLimitRetries: 0,
        },
      ],
      results: [
        {
          taskId: 'task-long-fail',
          cell: opus,
          run: {
            status: 'failed',
            finalText: null,
            iterations: 1,
            tokensIn: 1,
            tokensOut: 1,
            costUsd: 0,
            elapsedMs: 1,
            exitCode: 1,
          },
          grade: {
            passed: false,
            graded: true,
            detail: 'long-line-failure-'.repeat(60), // > 800 chars
          },
          tools: { totalCalls: 0, editCalls: 0, editErrors: 0, rateLimitRetries: 0 },
        },
        {
          taskId: 'task-two',
          cell: { label: 'other', provider: 'p', model: 'm' },
          run: {
            status: 'completed',
            finalText: null,
            iterations: 1,
            tokensIn: 1,
            tokensOut: 1,
            costUsd: 0,
            elapsedMs: 1,
            exitCode: 0,
          },
          grade: { passed: true },
          tools: { totalCalls: 0, editCalls: 0, editErrors: 0, rateLimitRetries: 0 },
        },
      ],
    });
    expect(md).toContain('long-line-failure-');
    expect(md).toContain('…');
    expect(md).toContain('—');
  });
});
