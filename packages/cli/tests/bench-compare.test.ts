import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { benchCmd } from '../src/subcommands/handlers/bench.js';
import type { SubcommandDeps } from '../src/subcommands/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function deps(
  cwd: string,
  flags: Record<string, string | boolean> = {},
  config: { provider?: string; model?: string } = {},
): SubcommandDeps {
  return {
    cwd,
    flags,
    config,
    renderer: {
      write: vi.fn(),
      writeInfo: vi.fn(),
      writeError: vi.fn(),
    },
  } as unknown as SubcommandDeps;
}

async function writeRun(
  dir: string,
  over: { passed: boolean; hash: string; cliVersion?: string },
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const cell = { label: 'opus', provider: 'anthropic', model: 'claude-opus-4-8' };
  const result = {
    taskId: 'smoke/add-banner',
    cell,
    run: {
      status: 'completed',
      finalText: 'done',
      iterations: 2,
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.01,
      elapsedMs: 500,
      exitCode: 0,
    },
    grade: { passed: over.passed },
    tools: { totalCalls: 2, editCalls: 1, editErrors: 0, rateLimitRetries: 0 },
  };
  const summary = {
    suite: 'smoke',
    finishedAt: '2026-09-04T00:00:00Z',
    fingerprint: {
      cliVersion: over.cliVersion ?? '0.320.0',
      toolNames: ['read'],
      maxIterations: 20,
      yolo: true,
      subsetId: 'smoke:abc',
      hash: over.hash,
    },
    cells: [
      {
        cell,
        taskCount: 1,
        gradedCount: 1,
        passRate: over.passed ? 1 : 0,
        editApplyRate: 1,
        avgCostUsd: 0.01,
        avgTokensIn: 10,
        avgTokensOut: 5,
        p50Iterations: 2,
        p50ElapsedMs: 500,
        timeoutRate: 0,
        totalRateLimitRetries: 0,
      },
    ],
  };
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  await fs.writeFile(path.join(dir, 'results.jsonl'), JSON.stringify(result) + '\n', 'utf8');
}

describe('wstack bench compare', () => {
  it('writes compare.md with flipped tasks for two run directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-bench-compare-'));
    tempDirs.push(root);
    const baseline = path.join(root, 'base');
    const candidate = path.join(root, 'cand');
    await writeRun(baseline, { passed: false, hash: 'deadbeef0001' });
    await writeRun(candidate, { passed: true, hash: 'deadbeef0001' });
    const d = deps(root);

    await expect(benchCmd(['compare', 'base', 'cand'], d)).resolves.toBe(0);
    const md = await fs.readFile(path.join(candidate, 'compare.md'), 'utf8');
    expect(md).toContain('**Comparable:**');
    expect(md).toContain('smoke/add-banner');
    expect(d.renderer.write).toHaveBeenCalledWith(expect.stringContaining('Leaderboard deltas'));
  });

  it('requires two run directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-bench-compare-'));
    tempDirs.push(root);
    const d = deps(root);
    await expect(benchCmd(['compare', 'only-one'], d)).resolves.toBe(1);
    expect(d.renderer.writeError).toHaveBeenCalledWith(
      expect.stringContaining('Usage: wstack bench compare'),
    );
  });
});

describe('wstack bench run config resolution', () => {
  it('rejects a malformed --cell spec before spawning', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-bench-cell-'));
    tempDirs.push(root);
    const d = deps(root, { cell: 'not-a-cell' });
    await expect(benchCmd(['run'], d)).resolves.toBe(1);
    expect(d.renderer.writeError).toHaveBeenCalledWith(expect.stringContaining('provider/model'));
  });

  it('errors with a how-to when no cells, config file, or saved model exist', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-bench-run-'));
    tempDirs.push(root);
    const d = deps(root, {}, {});
    await expect(benchCmd(['run'], d)).resolves.toBe(1);
    expect(d.renderer.writeError).toHaveBeenCalledWith(expect.stringContaining('No model cells'));
  });

  it('prints usage including the instant --cell example', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-bench-usage-'));
    tempDirs.push(root);
    const d = deps(root);
    await expect(benchCmd([], d)).resolves.toBe(0);
    expect(d.renderer.write).toHaveBeenCalledWith(expect.stringContaining('--cell'));
    expect(d.renderer.write).toHaveBeenCalledWith(expect.stringContaining('compare'));
  });
});

describe('wstack bench report', () => {
  it('re-renders the matrix from results.jsonl', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-bench-report-'));
    tempDirs.push(root);
    const runDir = path.join(root, 'run');
    await writeRun(runDir, { passed: true, hash: 'deadbeef0001' });
    const d = deps(root);
    await expect(benchCmd(['report', 'run'], d)).resolves.toBe(0);
    const md = await fs.readFile(path.join(runDir, 'report.md'), 'utf8');
    expect(md).toContain('Per-task matrix');
    expect(md).toContain('smoke/add-banner');
  });
});

describe('wstack bench list', () => {
  it('lists the bundled core suite first', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-bench-list-'));
    tempDirs.push(root);
    const d = deps(root);
    await expect(benchCmd(['list'], d)).resolves.toBe(0);
    expect(d.renderer.write).toHaveBeenCalledWith(expect.stringContaining('core'));
  });
});
