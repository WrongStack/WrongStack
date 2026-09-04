import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-extra-'));
  fakeWstack = path.join(dir, 'fake-wstack.cjs');
  await fs.writeFile(
    fakeWstack,
    'process.stdout.write(JSON.stringify({status:"completed",finalText:"ok",usage:{input:1,output:1,iterations:1,cost:0}})+"\\n");',
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
  id: 'polyglot/x/y',
  suite: 'polyglot',
  prompt: 'do it',
  templateDir: '',
  meta: {},
};

describe('runBenchmark', () => {
  it('throws when the suite produces no tasks', async () => {
    await expect(
      runBenchmark({
        suite: suiteWith([]),
        grade: async () => ({ passed: true }),
        config,
        cliVersion: '0.0.0',
        toolNames: ['read'],
        nodeBin: process.execPath,
        wstackEntry: fakeWstack,
      }),
    ).rejects.toThrow(/produced no tasks/);
  });

  it('records a grader error as a failed grade with detail', async () => {
    const report = await runBenchmark({
      suite: suiteWith([{ ...task, templateDir }]),
      grade: async () => {
        throw new Error('grader blew up');
      },
      config,
      cliVersion: '0.0.0',
      toolNames: ['read'],
      nodeBin: process.execPath,
      wstackEntry: fakeWstack,
      sandboxBaseDir: path.join(dir, 'sandbox'),
      // no `now` / `onProgress` → exercises the default-clock / no-op progress paths
    });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.grade.passed).toBe(false);
    expect(report.results[0]!.grade.detail).toMatch(/grader error: grader blew up/);
    expect(typeof report.finishedAt).toBe('string');
  });

  it('prefixes grade detail when the agent subprocess crashes', async () => {
    const crashEntry = path.join(dir, 'crash-wstack.cjs');
    await fs.writeFile(
      crashEntry,
      'process.stderr.write("setupProvider failed: unknown provider\\n"); process.exit(2);',
      'utf8',
    );
    const report = await runBenchmark({
      suite: suiteWith([{ ...task, templateDir }]),
      grade: async () => ({
        passed: false,
        detail: 'expected README.md to contain "# WrongStack"',
      }),
      config,
      cliVersion: '0.0.0',
      toolNames: ['read'],
      nodeBin: process.execPath,
      wstackEntry: crashEntry,
      sandboxBaseDir: path.join(dir, 'sandbox-crash'),
    });
    expect(report.results[0]!.run.status).toBe('crashed');
    expect(report.results[0]!.grade.detail).toMatch(/agent crashed:[\s\S]*unknown provider/);
    expect(report.results[0]!.grade.detail).toMatch(/expected README.md/);
  });
});
