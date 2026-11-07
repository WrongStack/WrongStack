/**
 * A multi-hour run used to die with Ctrl-C: no report, a sandbox left on
 * disk, and no way to finish the missing units. Stopping now drops in-flight
 * rows, reports what finished, and a resume skips every recorded unit.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WIN32_TREE_KILL_BUDGET_MS } from '@wrongstack/core/utils/tree-kill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { heartbeatLine, partitionRerunRows, runBenchmark, unitKey } from '../src/orchestrate.js';
import { readRunDir, writeRunManifest } from '../src/report/json.js';
import { renderMarkdownReport } from '../src/report/markdown.js';
import type { BenchConfig, BenchSuite, BenchTask, TaskResult } from '../src/types.js';

// Production performs one bounded 30s process-table sweep per completed unit
// and one in finally. These integration tests include that actual OS cleanup.
const processSweepBudgetMs = 30_000;
const completedRunDeadlineMs = (completedUnits: number, runs = 1) =>
  process.platform === 'win32' ? (completedUnits + runs) * processSweepBudgetMs + 15_000 : 30_000;

let dir: string;
let templateDir: string;
let fastWstack: string;
let slowWstack: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-stop-'));
  templateDir = path.join(dir, 'template');
  await fs.mkdir(templateDir, { recursive: true });
  await fs.writeFile(path.join(templateDir, 'file.txt'), 'hello', 'utf8');
  const payload =
    'process.stdout.write(JSON.stringify({ status: "completed", finalText: "ok", usage: { iterations: 1 } }) + "\\n");';
  fastWstack = path.join(dir, 'fast-wstack.js');
  await fs.writeFile(fastWstack, payload, 'utf8');
  // Busy for a minute unless killed.
  slowWstack = path.join(dir, 'slow-wstack.js');
  await fs.writeFile(slowWstack, `setTimeout(() => { ${payload} }, 60000);`, 'utf8');
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function suite(ids: string[]): BenchSuite {
  return {
    id: 'polyglot',
    async loadTasks() {
      return ids.map(
        (id): BenchTask => ({ id, suite: 'polyglot', prompt: id, templateDir, meta: {} }),
      );
    },
    subsetId: (tasks) => `test:${tasks.map((t) => t.id).join(',')}`,
  };
}

const config: BenchConfig = {
  maxIterations: 5,
  concurrency: 1,
  timeoutMs: 60_000,
  cells: [{ label: 'only', provider: 'p', model: 'm' }],
};

const base = {
  cliVersion: '1',
  toolNames: [],
  nodeBin: process.execPath,
  bootRetryDelayMs: 0,
  grade: async () => ({ passed: true }),
};

describe('stopping a run', () => {
  it(
    'kills the in-flight agent, drops its row and starts nothing new',
    async () => {
      const stop = new AbortController();
      const persisted: TaskResult[] = [];
      const started = Date.now();
      const report = await runBenchmark({
        ...base,
        suite: suite(['t1', 't2', 't3']),
        config,
        wstackEntry: slowWstack,
        signal: stop.signal,
        onStart: () => {
          setTimeout(() => stop.abort(), 300);
        },
        onResult: (row) => {
          persisted.push(row);
        },
      });
      expect(Date.now() - started).toBeLessThan(
        process.platform === 'win32'
          ? WIN32_TREE_KILL_BUDGET_MS + processSweepBudgetMs + 10_000
          : 20_000,
      );
      expect(report.results).toEqual([]);
      expect(persisted).toEqual([]);
      expect(report.progress).toEqual({ planned: 3, completed: 0, interrupted: true });
    },
    process.platform === 'win32'
      ? WIN32_TREE_KILL_BUDGET_MS + processSweepBudgetMs + 20_000
      : 30_000,
  );
});

describe('resuming a run', () => {
  it(
    'runs only the units without a row and folds the old rows in',
    async () => {
      const prior: TaskResult[] = [
        {
          taskId: 't1',
          cell: config.cells[0]!,
          run: {
            status: 'completed',
            finalText: 'ok',
            iterations: 1,
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
            elapsedMs: 1,
            exitCode: 0,
          },
          grade: { passed: false },
          tools: { totalCalls: 0, editCalls: 0, editErrors: 0, rateLimitRetries: 0 },
        },
      ];
      const ran: string[] = [];
      const progress: string[] = [];
      const report = await runBenchmark({
        ...base,
        suite: suite(['t1', 't2']),
        config,
        wstackEntry: fastWstack,
        priorResults: prior,
        onResult: (row) => {
          ran.push(row.taskId);
        },
        onProgress: (line) => progress.push(line),
      });
      expect(ran).toEqual(['t2']);
      expect(report.results.map((row) => row.taskId)).toEqual(['t1', 't2']);
      expect(report.progress).toEqual({ planned: 2, completed: 2, interrupted: false });
      expect(progress[0]).toContain('resuming: 1 done, 1 to go');
      // The resumed run's counter continues from the old rows.
      expect(progress.some((line) => line.includes('[2/2 · 1 pass]'))).toBe(true);
    },
    completedRunDeadlineMs(1),
  );

  it('drops the rows --rerun names so a resume runs those units again', () => {
    const rows = ['polyglot/java/a', 'polyglot/go/b', 'polyglot/java/c'].map((taskId) => ({
      taskId,
    }));
    const { kept, dropped } = partitionRerunRows(rows, ['polyglot/java/']);
    expect(kept.map((r) => r.taskId)).toEqual(['polyglot/go/b']);
    expect(dropped.map((r) => r.taskId)).toEqual(['polyglot/java/a', 'polyglot/java/c']);
  });

  it('keys a single-attempt row and attempt 1 as the same unit', () => {
    expect(unitKey('t', 'c', undefined)).toBe(unitKey('t', 'c', 1));
    expect(unitKey('t', 'c', 2)).not.toBe(unitKey('t', 'c', 1));
  });
});

describe('last-chance re-grade', () => {
  it(
    'grades a failed row again after the run, without running the agent again',
    async () => {
      const graded: string[] = [];
      const progress: string[] = [];
      let agentRuns = 0;
      const report = await runBenchmark({
        ...base,
        suite: suite(['flaky', 'broken']),
        config,
        wstackEntry: fastWstack,
        // First grades fail; the second grade of `flaky` passes (a harness fault).
        grade: async ({ task }) => {
          graded.push(task.id);
          const second = graded.filter((id) => id === task.id).length > 1;
          return { passed: second && task.id === 'flaky', detail: second ? 'ok' : 'wrong JDK' };
        },
        onResult: () => {
          agentRuns++;
        },
        onProgress: (line) => progress.push(line),
      });
      expect(agentRuns).toBe(2);
      expect(graded.sort()).toEqual(['broken', 'broken', 'flaky', 'flaky']);
      const byId = Object.fromEntries(report.results.map((row) => [row.taskId, row]));
      expect(byId['flaky']?.grade.passed).toBe(true);
      expect(byId['flaky']?.lastChance).toEqual({ passed: true, firstDetail: 'wrong JDK' });
      expect(byId['broken']?.grade).toEqual({ passed: false, detail: 'wrong JDK' });
      expect(byId['broken']?.lastChance).toEqual({ passed: false, firstDetail: 'wrong JDK' });
      expect(report.cells[0]?.passRate).toBe(0.5);
      expect(progress.some((line) => line.includes('1/2 passed on the second grade'))).toBe(true);
      expect(renderMarkdownReport(report)).toContain('**Last chance:** 2 failed run(s)');
    },
    completedRunDeadlineMs(2),
  );

  it(
    'can be turned off, and never re-grades rows a resume carried in',
    async () => {
      const graded: string[] = [];
      const grade = async ({ task }: { task: BenchTask }) => {
        graded.push(task.id);
        return { passed: false };
      };
      await runBenchmark({
        ...base,
        suite: suite(['t1']),
        config,
        wstackEntry: fastWstack,
        grade,
        lastChanceRegrade: false,
      });
      expect(graded).toEqual(['t1']);
      graded.length = 0;
      const prior: TaskResult = {
        taskId: 't1',
        cell: config.cells[0]!,
        run: {
          status: 'completed',
          finalText: 'ok',
          iterations: 1,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          elapsedMs: 1,
          exitCode: 0,
        },
        grade: { passed: false },
        tools: { totalCalls: 0, editCalls: 0, editErrors: 0, rateLimitRetries: 0 },
      };
      await runBenchmark({
        ...base,
        suite: suite(['t1', 't2']),
        config,
        wstackEntry: fastWstack,
        grade,
        priorResults: [prior],
      });
      expect(graded).toEqual(['t2', 't2']);
    },
    completedRunDeadlineMs(2, 2),
  );
});

describe('reading an unfinished run directory', () => {
  it('reports from run.json when the run never wrote summary.json', async () => {
    const runDir = path.join(dir, 'unfinished');
    const cell = config.cells[0]!;
    await writeRunManifest(runDir, {
      suite: 'polyglot',
      startedAt: '2026-10-28T08:01:23.270Z',
      fingerprint: {
        cliVersion: '1',
        toolNames: [],
        maxIterations: 5,
        yolo: true,
        subsetId: 'x',
        hash: 'abc123',
      },
      cells: [cell],
      planned: 4,
      flags: { suite: 'polyglot' },
    });
    const row = {
      taskId: 't1',
      cell,
      run: { status: 'completed', iterations: 1, elapsedMs: 1, costUsd: 0 },
      grade: { passed: true },
      tools: { totalCalls: 0 },
    };
    await fs.writeFile(path.join(runDir, 'results.jsonl'), `${JSON.stringify(row)}\n`);
    const report = await readRunDir(runDir);
    expect(report.progress).toEqual({ planned: 4, completed: 1, interrupted: true });
    expect(report.cells[0]?.cell.label).toBe('only');
    expect(renderMarkdownReport(report)).toContain('**Incomplete:** 1/4 runs recorded');
  });
});

describe('heartbeatLine', () => {
  it('names what has run longest and estimates the rest', () => {
    const now = 1_000_000;
    const line = heartbeatLine({
      completed: 12,
      planned: 20,
      finishedThisRun: 10,
      inflight: new Map([
        ['m · a', now - 30_000],
        ['m · b', now - 425_000],
      ]),
      now,
      startedAt: now - 1_000_000,
    });
    expect(line).toBe('  ⏳ 12/20 done · 2 running · longest m · b 7m05s · ~13m20s left');
  });
});
