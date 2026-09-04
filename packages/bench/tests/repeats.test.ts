import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregateCell } from '../src/aggregate.js';
import { parseBenchConfig } from '../src/config.js';
import { runBenchmark } from '../src/orchestrate.js';
import { renderMarkdownReport } from '../src/report/markdown.js';
import type {
  BenchSuite,
  BenchTask,
  HarnessFingerprint,
  ModelCell,
  TaskResult,
} from '../src/types.js';

const cell: ModelCell = { label: 'cellA', provider: 'p', model: 'm' };

const fingerprint: HarnessFingerprint = {
  cliVersion: '1.0.0',
  toolNames: ['read'],
  maxIterations: 10,
  yolo: true,
  subsetId: 'core:x',
  hash: 'abc123',
};

function row(
  taskId: string,
  attempt: number,
  passed: boolean,
  over: Partial<TaskResult> = {},
): TaskResult {
  return {
    taskId,
    cell,
    attempt,
    run: {
      status: 'completed',
      finalText: null,
      iterations: 3,
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.01,
      elapsedMs: 1000,
      exitCode: 0,
    },
    grade: { passed },
    tools: { totalCalls: 1, editCalls: 1, editErrors: 0, rateLimitRetries: 0 },
    ...over,
  };
}

const timedOutRun: TaskResult['run'] = {
  status: 'timeout',
  finalText: null,
  iterations: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  elapsedMs: 60_000,
  exitCode: null,
};

describe('config repeats', () => {
  it('defaults to a single attempt', () => {
    expect(parseBenchConfig({ cells: [{ provider: 'p', model: 'm' }] }).repeats).toBe(1);
  });

  it('accepts a positive integer and rejects anything else', () => {
    expect(parseBenchConfig({ cells: [{ provider: 'p', model: 'm' }], repeats: 5 }).repeats).toBe(
      5,
    );
    expect(() => parseBenchConfig({ cells: [{ provider: 'p', model: 'm' }], repeats: 0 })).toThrow(
      /repeats must be a positive number/,
    );
  });
});

describe('aggregateCell with repeats', () => {
  it('separates attempt-level pass@1 from task-level pass@k and flakiness', () => {
    const results = [
      // t1: solved every time.
      row('t1', 1, true),
      row('t1', 2, true),
      // t2: flaky — one of two attempts passed.
      row('t2', 1, true),
      row('t2', 2, false),
      // t3: never solved.
      row('t3', 1, false),
      row('t3', 2, false),
    ];
    const folded = aggregateCell(cell, results);

    expect(folded.taskCount).toBe(3);
    expect(folded.attemptCount).toBe(6);
    expect(folded.repeats).toBe(2);
    // 3 of 6 attempts passed.
    expect(folded.passRate).toBeCloseTo(0.5);
    // t1 + t2 were solved at least once.
    expect(folded.passAnyRate).toBeCloseTo(2 / 3);
    // Only t1 passed every attempt.
    expect(folded.passAllRate).toBeCloseTo(1 / 3);
    expect(folded.flakyTaskCount).toBe(1);
    // Averages divide by attempts, not tasks.
    expect(folded.avgCostUsd).toBeCloseTo(0.01);
  });

  it('excludes entirely ungraded tasks from pass@k, all-pass and flakiness', () => {
    const ungraded = row('t2', 1, false, { grade: { passed: false, graded: false } });
    const folded = aggregateCell(cell, [row('t1', 1, true), ungraded]);
    expect(folded.taskCount).toBe(2);
    expect(folded.gradedCount).toBe(1);
    expect(folded.passAnyRate).toBe(1);
    expect(folded.passAllRate).toBe(1);
    expect(folded.flakyTaskCount).toBe(0);
  });

  it('counts attempts that never reported usage so the cost column reads as a floor', () => {
    const folded = aggregateCell(cell, [
      row('t1', 1, true),
      row('t1', 2, false, { run: timedOutRun }),
    ]);
    expect(folded.incompleteCount).toBe(1);
    expect(folded.timeoutRate).toBeCloseTo(0.5);
  });
});

describe('markdown report with repeats', () => {
  it('shows pass@k, flakiness, an under-reported-cost warning and the failure detail', () => {
    const failing = row('t1', 2, false, {
      grade: { passed: false, detail: 'agent timed out (killed; telemetry unrecoverable)' },
      run: timedOutRun,
    });
    const results = [row('t1', 1, true), failing];
    const md = renderMarkdownReport({
      suite: 'core',
      finishedAt: '2026-01-01T00:00:00.000Z',
      fingerprint,
      cells: [aggregateCell(cell, results)],
      results,
    });

    expect(md).toContain('**Attempts/task:** 2');
    expect(md).toContain('Pass@2');
    expect(md).toContain('Flaky tasks');
    expect(md).toContain('lower bounds');
    expect(md).toContain('## Failures');
    expect(md).toContain('agent timed out');
  });

  it('keeps the single-attempt table unchanged and omits the failure section when nothing failed', () => {
    const md = renderMarkdownReport({
      suite: 'core',
      finishedAt: '2026-01-01T00:00:00.000Z',
      fingerprint,
      cells: [aggregateCell(cell, [row('t1', 1, true)])],
      results: [row('t1', 1, true)],
    });
    expect(md).not.toContain('**Attempts/task:**');
    expect(md).not.toContain('## Failures');
    expect(md).not.toContain('lower bounds');
  });

  it('clamps a long failure detail instead of pasting a whole test log', () => {
    const noisy = row('t1', 1, false, {
      grade: {
        passed: false,
        detail: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'),
      },
    });
    const md = renderMarkdownReport({
      suite: 'core',
      finishedAt: '2026-01-01T00:00:00.000Z',
      fingerprint,
      cells: [aggregateCell(cell, [noisy])],
      results: [noisy],
    });
    expect(md).toContain('line 11');
    expect(md).not.toContain('line 12');
    expect(md).toContain('28 more line(s)');
  });
});

describe('runBenchmark repeats', () => {
  let dir: string;
  let fakeWstack: string;
  let templateDir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-repeats-'));
    fakeWstack = path.join(dir, 'fake-wstack.js');
    // Records the cwd it was launched in, so the test can prove every attempt
    // got its own workdir — a shared one would corrupt concurrent attempts and
    // make the session log they are read back from ambiguous.
    await fs.writeFile(
      fakeWstack,
      [
        'const fs = require("node:fs");',
        'fs.appendFileSync(process.env.BENCH_CWD_LOG, process.cwd() + "\\n");',
        'const usage = { input: 1, output: 1, iterations: 1, cost: 0.001 };',
        'process.stdout.write(JSON.stringify({ status: "completed", finalText: "ok", usage }) + "\\n");',
      ].join('\n'),
      'utf8',
    );
    templateDir = path.join(dir, 'template');
    await fs.mkdir(templateDir, { recursive: true });
    await fs.writeFile(path.join(templateDir, 'file.txt'), 'hello', 'utf8');
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function suite(): BenchSuite {
    return {
      id: 'polyglot',
      async loadTasks() {
        const tasks: BenchTask[] = [
          { id: 't1', suite: 'polyglot', prompt: 'do it', templateDir, meta: {} },
        ];
        return tasks;
      },
      subsetId: () => 'test:t1',
    };
  }

  it('runs each task N times in its own workdir and streams every row to onResult', async () => {
    const cwdLog = path.join(dir, 'cwds.log');
    await fs.writeFile(cwdLog, '', 'utf8');
    const streamed: TaskResult[] = [];

    const report = await runBenchmark({
      suite: suite(),
      grade: async () => ({ passed: true }),
      config: { maxIterations: 5, concurrency: 2, timeoutMs: 30_000, repeats: 3, cells: [cell] },
      cliVersion: '1.0.0',
      toolNames: ['read'],
      nodeBin: process.execPath,
      wstackEntry: fakeWstack,
      sandboxBaseDir: path.join(dir, 'sandbox'),
      env: { BENCH_CWD_LOG: cwdLog },
      onResult: (r) => {
        streamed.push(r);
      },
      now: () => '2026-01-01T00:00:00.000Z',
    });

    expect(report.results).toHaveLength(3);
    expect(report.results.map((r) => r.attempt).sort()).toEqual([1, 2, 3]);
    expect(streamed).toHaveLength(3);

    const cwds = (await fs.readFile(cwdLog, 'utf8')).split('\n').filter(Boolean);
    expect(cwds).toHaveLength(3);
    expect(new Set(cwds).size).toBe(3);

    expect(report.cells[0]?.taskCount).toBe(1);
    expect(report.cells[0]?.attemptCount).toBe(3);
    expect(report.cells[0]?.repeats).toBe(3);
  });

  it('never lets an onResult failure take the run down', async () => {
    const report = await runBenchmark({
      suite: suite(),
      grade: async () => ({ passed: true }),
      config: { maxIterations: 5, concurrency: 1, timeoutMs: 30_000, cells: [cell] },
      cliVersion: '1.0.0',
      toolNames: ['read'],
      nodeBin: process.execPath,
      wstackEntry: fakeWstack,
      sandboxBaseDir: path.join(dir, 'sandbox2'),
      env: { BENCH_CWD_LOG: path.join(dir, 'cwds2.log') },
      onResult: () => {
        throw new Error('disk full');
      },
      now: () => '2026-01-01T00:00:00.000Z',
    });
    expect(report.results).toHaveLength(1);
    // Single-attempt runs stay free of the attempt marker.
    expect(report.results[0]?.attempt).toBeUndefined();
  });

  it('folds the sandbox config hash into the fingerprint unless the caller supplies one', async () => {
    const base = {
      suite: suite(),
      grade: async () => ({ passed: true }),
      config: { maxIterations: 5, concurrency: 1, timeoutMs: 30_000, cells: [cell] },
      cliVersion: '1.0.0',
      toolNames: ['read'],
      nodeBin: process.execPath,
      wstackEntry: fakeWstack,
      env: { BENCH_CWD_LOG: path.join(dir, 'cwds3.log') },
      now: () => '2026-01-01T00:00:00.000Z',
    };
    const auto = await runBenchmark({ ...base, sandboxBaseDir: path.join(dir, 'sandbox3') });
    const explicit = await runBenchmark({
      ...base,
      sandboxBaseDir: path.join(dir, 'sandbox4'),
      configHash: 'caller-supplied',
    });

    expect(auto.fingerprint.configHash).toBeTruthy();
    expect(explicit.fingerprint.configHash).toBe('caller-supplied');
    expect(auto.fingerprint.hash).not.toBe(explicit.fingerprint.hash);
  });
});
