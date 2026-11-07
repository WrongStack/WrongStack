import { describe, expect, it, vi } from 'vitest';
import { compareQualityExperiment, routingExperiment } from '../src/experiments.js';
import { runBenchmark } from '../src/orchestrate.js';
import { reviewTranscript } from '../src/quality-review.js';
import type { BenchReport, TaskResult } from '../src/types.js';

// runBenchmark sweeps leftover daemons through the OS process list after every
// task; these tests run fake agents, so keep them off the real process table.
vi.mock('../src/sandbox-reaper.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox-reaper.js')>()),
  reapProcessesUnder: async () => 0,
}));

function fixture(): BenchReport {
  const row = (model: string, attempt: number, costUsd: number): TaskResult => ({
    taskId: 'core/fix',
    cell: { label: model, provider: 'fixture', model },
    attempt,
    run: {
      status: 'completed',
      finalText: 'done',
      tokensIn: 10,
      tokensOut: 2,
      iterations: 1,
      elapsedMs: model === 'cheap' ? 100 : 10,
      costUsd,
      costSource: 'catalog-estimate',
      exitCode: 0,
    },
    grade: { passed: true },
    tools: { totalCalls: 2, editCalls: 1, editErrors: 0, rateLimitRetries: 0, subagentSpawns: 0 },
  });
  return {
    suite: 'core',
    finishedAt: '2026-10-03',
    fingerprint: {
      hash: 'fixture',
      cliVersion: '1',
      toolNames: ['edit'],
      maxIterations: 40,
      yolo: false,
      subsetId: 'fix',
      configHash: 'base',
    },
    cells: [],
    results: [1, 2, 3].flatMap((attempt) => [
      row('cheap', attempt, 0.01),
      row('fast', attempt, 0.1),
    ]),
  };
}
describe('evidence-based bench experiments', () => {
  it('rejects an invalid review policy before benchmark preparation or model calls', async () => {
    await expect(runBenchmark({ reviewPolicy: { repeatLimit: 1 } } as never)).rejects.toThrow(
      'repeat limit',
    );
  });
  it('recommends cost or latency only after graded quality and corpus checks', () => {
    const report = fixture();
    const policy = { version: 1 as const, categories: { repair: ['core/fix'] } };
    expect(routingExperiment(report, policy).categories[0]?.recommended?.model).toBe('cheap');
    expect(
      routingExperiment(report, { ...policy, objective: 'latency' }).categories[0]?.recommended
        ?.model,
    ).toBe('fast');
    report.results
      .filter((row) => row.cell.model === 'cheap')
      .forEach((row) => {
        row.grade.passed = false;
      });
    expect(routingExperiment(report, policy).categories[0]?.recommended?.model).toBe('fast');
  });
  it('refuses legacy unknown costs, missing tasks and crashed attempts', () => {
    const report = fixture();
    report.results.forEach((row) => {
      delete row.run.costSource;
    });
    expect(
      routingExperiment(report, { version: 1, categories: { fix: ['core/fix'] } }).categories[0]
        ?.recommended,
    ).toBeNull();
    expect(
      routingExperiment(fixture(), { version: 1, categories: { fix: ['core/fix', 'missing'] } })
        .categories[0]?.recommended,
    ).toBeNull();
    const crashed = fixture();
    crashed.results.forEach((row) => {
      row.run.status = 'crashed';
    });
    expect(
      routingExperiment(crashed, { version: 1, categories: { fix: ['core/fix'] } }).categories[0]
        ?.recommended,
    ).toBeNull();
  });
  it('avoids pipe-delimiter cell collisions and rejects candidates missing multi-attempt task runs', () => {
    const report = fixture();
    const partial = report.results.filter(
      (r) => !(r.cell.model === 'cheap' && (r.attempt === 2 || r.attempt === 3)),
    );
    partial.push({
      ...report.results[0]!,
      taskId: 'core/other',
      attempt: 1,
    });
    const partialReport: BenchReport = { ...report, results: partial };
    const rec = routingExperiment(partialReport, {
      version: 1,
      minAttempts: 2,
      categories: { all: ['core/fix', 'core/other'] },
    });
    const cheapCandidate = rec.categories[0]?.candidates.find((c) => c.cell.model === 'cheap');
    expect(cheapCandidate?.eligible).toBe(false);
    expect(cheapCandidate?.reasons).toContain('incomplete-category-corpus');
  });
  it('compares only paired task/model/attempt evidence and rejects fixed harness drift', () => {
    const base = fixture();
    const next = structuredClone(base);
    next.fingerprint.configHash = 'new';
    next.fingerprint.hash = 'next';
    expect(compareQualityExperiment(base, next, 'compaction')).toMatchObject({
      configurationEvidence: 'operator-declared',
      candidate: { metrics: { passed: 6 } },
    });
    next.results.pop();
    expect(() => compareQualityExperiment(base, next, 'compaction')).toThrow('identical');
    const drift = fixture();
    drift.fingerprint.toolNames.push('write');
    expect(() => compareQualityExperiment(base, drift, 'behavior')).toThrow('fixed harness');
  });
  it('records failure/loop/scope evidence and does not certify a self-reported test pass', () => {
    const events = [
      { type: 'tool_use', id: 'a', name: 'read', input: { path: 'a.ts' } },
      { type: 'compaction', fullRequestTokensBefore: 1000, fullRequestTokensAfter: 300 },
      { type: 'tool_use', id: 'b', name: 'read', input: { path: 'a.ts' } },
      { type: 'tool_use', id: 'c', name: 'read', input: { path: 'a.ts' } },
      { type: 'tool_use', id: 'd', name: 'edit', input: { path: 'outside.ts' } },
      { type: 'tool_call_end', id: 'd', ok: false },
      { type: 'assistant_message', content: 'All tests passed' },
    ];
    const report = reviewTranscript(events, 'a'.repeat(64), {
      allowedEditPaths: ['a.ts'],
      requiredFinalMarkers: ['validation boundary'],
    });
    expect(report.findings.map((item) => item.category)).toEqual(
      expect.arrayContaining([
        'scope-excursion',
        'failed-tool-call',
        'repeated-tool-call',
        'missing-test-evidence',
        'missing-final-requirement',
      ]),
    );
    expect(report.observations).toMatchObject({
      rereadsAfterCompaction: 2,
      fullRequestTokensSaved: 700,
    });
    expect(report.validation).toBe('not-independently-verified');
  });
  it('never equates message-only token savings with full-request compaction savings', () => {
    expect(
      reviewTranscript([{ type: 'compaction', before: 100, after: 10 }], 'a'.repeat(64))
        .observations.fullRequestTokensSaved,
    ).toBeNull();
  });
  it('uses persisted response blocks and keeps subagent observations separate', () => {
    const events = [
      { type: 'tool_use', id: 'read', name: 'read', input: { path: 'a.ts' } },
      { type: 'compaction', before: 100, after: 50 },
      { type: 'tool_use', id: 'read', agentId: 'worker', name: 'read', input: { path: 'a.ts' } },
      { type: 'llm_response', content: [{ type: 'text', text: 'validation boundary' }] },
      {
        type: 'llm_response',
        agentId: 'worker',
        content: [{ type: 'text', text: 'other answer' }],
      },
    ];
    const review = reviewTranscript(events, 'a'.repeat(64), {
      requiredFinalMarkers: ['validation boundary'],
      repeatLimit: 2,
    });
    expect(review.findings).toEqual([]);
    expect(review.observations.rereadsAfterCompaction).toBe(0);
  });
  it('reads standard audit start/result events without double-counting tool use/start pairs', () => {
    const events = [
      { type: 'tool_use', id: 'a', name: 'edit', input: { path: 'a.ts' } },
      { type: 'tool_call_start', id: 'a', name: 'edit', input: { path: 'a.ts' } },
      { type: 'tool_call_end', id: 'a', ok: false },
      { type: 'tool_result', id: 'a', isError: true },
      { type: 'tool_call_start', id: 'test', name: 'bash', input: { command: 'pnpm test' } },
      { type: 'tool_result', id: 'test', isError: false },
    ];
    const review = reviewTranscript(events, 'a'.repeat(64));
    expect(review.observations).toMatchObject({
      edits: 1,
      toolInputsObserved: 2,
      toolOutcomesObserved: 2,
      testCommandsObserved: 1,
    });
    expect(
      review.findings.filter((finding) => finding.category === 'failed-tool-call'),
    ).toHaveLength(1);
    expect(review.findings.some((finding) => finding.category === 'missing-test-evidence')).toBe(
      false,
    );
  });
  it('does not count files first read after compaction as rereadsAfterCompaction and preserves finalText across tool-only llm_response (F155)', () => {
    const events = [
      { type: 'compaction', fullRequestTokensBefore: 1000, fullRequestTokensAfter: 300 },
      { type: 'tool_use', id: 'r1', name: 'read', input: { path: 'src/new-file.ts' } },
      { type: 'tool_use', id: 'r2', name: 'read', input: { path: 'src/new-file.ts' } },
      { type: 'llm_response', content: [{ type: 'text', text: 'validation boundary' }] },
      { type: 'llm_response', content: [{ type: 'tool_use', id: 'r3', name: 'read' }] },
    ];
    const review = reviewTranscript(events, 'a'.repeat(64), {
      requiredFinalMarkers: ['validation boundary'],
    });
    expect(review.observations.rereadsAfterCompaction).toBe(0);
    expect(
      review.findings.some((finding) => finding.category === 'missing-final-requirement'),
    ).toBe(false);
  });
  it('normalizes hyphenated tool names and recognizes str_replace in reviewTranscript (F90)', () => {
    const events = [
      { type: 'tool_use', id: 'r1', name: 'read-file', input: { path: 'src/a.ts' } },
      { type: 'compaction', fullRequestTokensBefore: 800, fullRequestTokensAfter: 300 },
      { type: 'tool_use', id: 'r2', name: 'read_file', input: { path: 'src/a.ts' } },
      { type: 'tool_use', id: 'e1', name: 'str_replace', input: { path: 'src/outside.ts' } },
      { type: 'tool_use', id: 'e2', name: 'apply-patch', input: { path: 'src/a.ts' } },
    ];
    const review = reviewTranscript(events, 'a'.repeat(64), {
      allowedEditPaths: ['src/a.ts'],
    });
    expect(review.observations.edits).toBe(2);
    expect(review.observations.rereadsAfterCompaction).toBe(1);
    expect(
      review.findings.filter((finding) => finding.category === 'scope-excursion'),
    ).toHaveLength(1);
  });
});
