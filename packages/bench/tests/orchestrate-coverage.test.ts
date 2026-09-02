import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBenchmark } from '../src/orchestrate.js';
import type { BenchConfig, BenchSuite, BenchTask } from '../src/types.js';

let dir: string;
let fakeWstack: string;
let templateDir: string;

const config: BenchConfig = {
  maxIterations: 5,
  concurrency: 1,
  timeoutMs: 10_000,
  cells: [{ label: 'opus', provider: 'anthropic', model: 'claude-opus-4-8' }],
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-cov-'));
  fakeWstack = path.join(dir, 'fake-wstack.cjs');
  await fs.writeFile(
    fakeWstack,
    "process.stdout.write(JSON.stringify({status:'completed',finalText:'ok',usage:{input:1,output:1,iterations:1,cost:0}})+'\\n');",
    'utf8',
  );
  templateDir = path.join(dir, 'template');
  await fs.mkdir(templateDir, { recursive: true });
  await fs.writeFile(path.join(templateDir, 'file.txt'), 'x');
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function suiteWith(tasks: BenchTask[]): BenchSuite {
  return {
    id: 'polyglot',
    loadTasks: async () => tasks,
    subsetId: () => 'polyglot:test',
  };
}

const task: BenchTask = {
  id: 'polyglot/x',
  suite: 'polyglot',
  prompt: 'do it',
  templateDir: '',
  meta: {},
};

describe('runBenchmark — coverage gap', () => {
  it('skips sandbox cleanup when keepSandbox is true', async () => {
    const report = await runBenchmark({
      suite: suiteWith([{ ...task, templateDir }]),
      grade: async () => ({ passed: true }),
      config,
      cliVersion: '0.0.0',
      toolNames: ['read'],
      nodeBin: process.execPath,
      wstackEntry: fakeWstack,
      keepSandbox: true, // exercises the `!opts.keepSandbox` false branch in finally
      now: () => '2026-07-04T00:00:00.000Z',
    });
    expect(report.results).toHaveLength(1);
    expect(report.finishedAt).toBe('2026-07-04T00:00:00.000Z');
  });

  it('runs with traceEval on the task', async () => {
    // Provide a task with traceEval spec, along with a minimal session log
    // so evaluateTraceEval can parse something. traceEval exercises the
    // task.traceEval ? await evaluateTraceEval(...) : undefined branch.
    const taskWithTraceEval: BenchTask = {
      ...task,
      templateDir,
      traceEval: {
        source: {
          sessionId: 'sess_test',
          transcriptPath: '/corpus/test.jsonl',
          sha256: 'a'.repeat(64),
          eventStart: 0,
          eventEnd: 0,
        },
        retrieval: [{ toolNames: ['read'], contains: 'legacy' }],
        recall: { toolNames: ['edit'], inputContains: ['handler', 'fix'] },
      },
    };

    const report = await runBenchmark({
      suite: suiteWith([taskWithTraceEval]),
      grade: async () => ({ passed: true }),
      config,
      cliVersion: '0.0.0',
      toolNames: ['read'],
      nodeBin: process.execPath,
      wstackEntry: fakeWstack,
      keepSandbox: true,
      now: () => '2026-07-04T00:00:00.000Z',
    });
    // The traceEval evaluation will run (readSessionLogEvents will find no
    // session JSONL → empty events → retrieval fails → traceEval result
    // has retrievalPassed: false, etc.)
    expect(report.results).toHaveLength(1);
    const traceEval = report.results[0]!.traceEval;
    expect(traceEval).toBeDefined();
    expect(traceEval!.retrievalPassed).toBe(false);
  });
});
