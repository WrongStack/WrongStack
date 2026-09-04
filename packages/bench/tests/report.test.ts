import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRunDir, readSummary, writeJsonArtifacts } from '../src/report/json.js';
import { renderMarkdownReport, reportHeaderLine } from '../src/report/markdown.js';
import type {
  BenchReport,
  CellResult,
  HarnessFingerprint,
  ModelCell,
  TaskResult,
} from '../src/types.js';

const FP: HarnessFingerprint = {
  cliVersion: '0.260.0',
  toolNames: ['read', 'write', 'bash'],
  maxIterations: 40,
  yolo: false,
  subsetId: 'polyglot-10',
  hash: 'abc123def456',
};

const cell = (over: Partial<CellResult> & { cell: ModelCell }): CellResult => ({
  taskCount: 10,
  gradedCount: 10,
  passRate: 0.5,
  editApplyRate: 0.9,
  avgCostUsd: 0.123,
  avgTokensIn: 1500,
  avgTokensOut: 800,
  p50Iterations: 12,
  p50ElapsedMs: 4500,
  timeoutRate: 0,
  totalRateLimitRetries: 0,
  ...over,
});

const opus: ModelCell = { label: 'opus-4.8', provider: 'anthropic', model: 'claude-opus-4-8' };
const haiku: ModelCell = { label: 'haiku-4.5', provider: 'anthropic', model: 'claude-haiku-4-5' };

describe('renderMarkdownReport', () => {
  it('renders a fingerprint-stamped leaderboard sorted by pass rate', () => {
    const report = {
      suite: 'polyglot' as const,
      finishedAt: '2026-06-15T00:00:00Z',
      fingerprint: FP,
      cells: [cell({ cell: haiku, passRate: 0.3 }), cell({ cell: opus, passRate: 0.8 })],
    };
    const md = renderMarkdownReport(report);
    expect(md).toMatch(/# WrongStack benchmark — polyglot/);
    expect(md).toMatch(/Tasks\/cell:\*\* 10/);
    expect(md).toContain('abc123def456');
    // opus (0.8) must sort above haiku (0.3)
    expect(md.indexOf('opus-4.8')).toBeLessThan(md.indexOf('haiku-4.5'));
    expect(md).toMatch(/80\.0%/);
  });

  it('shows a dash for ungraded cells and a fraction for partially graded ones', () => {
    const report = {
      suite: 'swebench' as const,
      finishedAt: 'now',
      fingerprint: FP,
      cells: [
        cell({ cell: opus, gradedCount: 0 }), // ungraded → —
        cell({ cell: haiku, gradedCount: 5, taskCount: 10, passRate: 0.4 }), // partial → fraction
      ],
    };
    const md = renderMarkdownReport(report);
    expect(md).toMatch(/—/);
    expect(md).toMatch(/\(5\/10\)/);
  });

  it('formats large token counts and sub-second timings', () => {
    const report = {
      suite: 'polyglot' as const,
      finishedAt: 'now',
      fingerprint: FP,
      cells: [cell({ cell: opus, avgTokensIn: 12_500, avgTokensOut: 500, p50ElapsedMs: 250 })],
    };
    const md = renderMarkdownReport(report);
    expect(md).toMatch(/12\.5k/); // fmtK >= 1000
    expect(md).toMatch(/500/); // fmtK < 1000
    expect(md).toMatch(/250ms/); // fmtMs < 1000
  });

  it('renders the conditional trace-eval funnel when transcript cases are present', () => {
    const md = renderMarkdownReport({
      suite: 'local',
      finishedAt: 'now',
      fingerprint: FP,
      cells: [
        cell({
          cell: opus,
          traceEval: {
            retrieval: { eligible: 4, passed: 3, rate: 0.75 },
            recallGivenRetrieval: { eligible: 3, passed: 2, rate: 2 / 3 },
            editApplicationGivenRecall: { eligible: 2, passed: 1, rate: 0.5 },
          },
        }),
      ],
    });
    expect(md).toContain('Recall (given retrieval)');
    expect(md).toContain('Edit application (given recall)');
    expect(md).toContain('75.0% (3/4)');
    expect(md).toContain('50.0% (1/2)');
  });

  it('handles an empty cell list (taskCount defaults to 0)', () => {
    const md = renderMarkdownReport({
      suite: 'polyglot',
      finishedAt: 'now',
      fingerprint: FP,
      cells: [],
    });
    expect(md).toMatch(/Tasks\/cell:\*\* 0/);
  });

  it('reportHeaderLine returns the fingerprint label', () => {
    expect(typeof reportHeaderLine(FP)).toBe('string');
    expect(reportHeaderLine(FP).length).toBeGreaterThan(0);
  });
});

describe('writeJsonArtifacts / readSummary', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-report-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const fullReport = (results: TaskResult[]): BenchReport => ({
    suite: 'polyglot',
    finishedAt: '2026-06-15T00:00:00Z',
    fingerprint: FP,
    cells: [cell({ cell: opus })],
    results,
  });

  const mkResult = (taskId: string): TaskResult => ({
    taskId,
    cell: opus,
    run: {
      status: 'completed',
      finalText: 'done',
      iterations: 3,
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.01,
      elapsedMs: 1000,
      exitCode: 0,
    },
    grade: { passed: true },
    tools: { totalCalls: 5, editCalls: 2, editErrors: 0, rateLimitRetries: 0 },
  });

  it('writes results.jsonl and summary.json then reads the summary back', async () => {
    await writeJsonArtifacts(dir, fullReport([mkResult('t1'), mkResult('t2')]));

    const jsonl = await fs.readFile(path.join(dir, 'results.jsonl'), 'utf8');
    expect(jsonl.trim().split('\n')).toHaveLength(2);

    const summary = await readSummary(dir);
    expect(summary.suite).toBe('polyglot');
    expect(summary.fingerprint.hash).toBe('abc123def456');
    expect(summary.cells).toHaveLength(1);
  });

  it('writes an empty results.jsonl without a trailing newline artifact', async () => {
    await writeJsonArtifacts(dir, fullReport([]));
    const jsonl = await fs.readFile(path.join(dir, 'results.jsonl'), 'utf8');
    expect(jsonl).toBe('');
  });

  it('readRunDir reloads summary plus results.jsonl', async () => {
    await writeJsonArtifacts(dir, fullReport([mkResult('t1')]));
    const loaded = await readRunDir(dir);
    expect(loaded.results).toHaveLength(1);
    expect(loaded.results[0]?.taskId).toBe('t1');
  });

  it('readRunDir treats a missing results.jsonl as an empty result set', async () => {
    await writeJsonArtifacts(dir, fullReport([mkResult('t1')]));
    await fs.rm(path.join(dir, 'results.jsonl'));
    const loaded = await readRunDir(dir);
    expect(loaded.results).toEqual([]);
    expect(loaded.cells).toHaveLength(1);
  });
});
