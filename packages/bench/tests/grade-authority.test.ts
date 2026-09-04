import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBenchmark } from '../src/orchestrate.js';
import type { BenchSuite, BenchTask, ModelCell } from '../src/types.js';

/**
 * The headline invariant is that the suite's own tests decide pass/fail. A run
 * that ends abnormally still gets its reason recorded, but only a crash — where
 * nothing meaningful happened in the workdir — may overrule the grader.
 */
let dir: string;
let templateDir: string;

const cell: ModelCell = { label: 'c', provider: 'p', model: 'm' };

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-authority-'));
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

/** Write a fake CLI that prints one `--output-json` line, or exits non-zero. */
async function fakeCli(name: string, payload: unknown | undefined): Promise<string> {
  const file = path.join(dir, `${name}.js`);
  const body =
    payload === undefined
      ? 'process.stderr.write("boom"); process.exit(9);'
      : `process.stdout.write(${JSON.stringify(JSON.stringify(payload))} + "\\n");`;
  await fs.writeFile(file, body, 'utf8');
  return file;
}

async function runOnce(entry: string, sandboxName: string) {
  return runBenchmark({
    suite: suite(),
    grade: async () => ({ passed: true }),
    config: { maxIterations: 5, concurrency: 1, timeoutMs: 30_000, cells: [cell] },
    cliVersion: '1.0.0',
    toolNames: ['read'],
    nodeBin: process.execPath,
    wstackEntry: entry,
    sandboxBaseDir: path.join(dir, sandboxName),
    now: () => '2026-01-01T00:00:00.000Z',
  });
}

describe('grader authority over abnormal runs', () => {
  it('keeps a grader PASS when the agent merely hit the iteration cap', async () => {
    const entry = await fakeCli('capped', {
      status: 'max_iterations',
      usage: { input: 1, output: 1, iterations: 5, cost: 0.001 },
    });
    const report = await runOnce(entry, 'sb-capped');
    const row = report.results[0];

    expect(row?.run.status).toBe('max_iterations');
    // The code in the workdir passes the suite's own tests — that is the verdict.
    expect(row?.grade.passed).toBe(true);
    // …but the report still records why the run ended the way it did.
    expect(row?.grade.detail).toContain('iteration cap after 5 iterations');
    expect(report.cells[0]?.passRate).toBe(1);
  });

  it('overrules the grader only when the agent crashed', async () => {
    const entry = await fakeCli('crashy', undefined);
    const report = await runOnce(entry, 'sb-crashy');
    const row = report.results[0];

    expect(row?.run.status).toBe('crashed');
    expect(row?.grade.passed).toBe(false);
    expect(row?.grade.detail).toContain('agent crashed');
    expect(report.cells[0]?.incompleteCount).toBe(1);
  });
});
