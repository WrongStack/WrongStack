import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resetIndexStateForTesting } from '../src/codebase-index/background-indexer.js';
import { isTestFilePath } from '../src/codebase-index/codebase-impact-analysis-tool.js';
import { codebaseIndexTool } from '../src/codebase-index/codebase-index-tool.js';
import { parseTestCounts } from '../src/codebase-index/codebase-targeted-test-tool.js';
import {
  codebaseImpactAnalysisTool,
  codebaseTargetedTestTool,
} from '../src/codebase-index/index.js';
import { indexStorePool } from '../src/codebase-index/writer.js';

process.env['WRONGSTACK_INDEX_INLINE'] = '1';

describe('codebase-impact-analysis and codebase-targeted-test tools', () => {
  it('codebase-impact-analysis fails on a never-built index instead of a fake zero-risk blast radius', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'impact-test-'));
    const indexDir = path.join(tempDir, '.codebase-index');
    resetIndexStateForTesting();

    try {
      await expect(
        codebaseImpactAnalysisTool.execute(
          { symbol: 'calculateDiscount' },
          { projectRoot: tempDir, meta: { codebaseIndexDir: indexDir } } as never,
          { signal: new AbortController().signal },
        ),
      ).rejects.toThrow(/No persisted index|Index query failed/i);
    } finally {
      indexStorePool.evict(tempDir, indexDir);
      resetIndexStateForTesting();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('codebase-impact-analysis reports a missing symbol on a built index', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'impact-miss-'));
    const indexDir = path.join(tempDir, '.codebase-index');
    resetIndexStateForTesting();
    try {
      await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, 'src', 'calc.ts'),
        'export function add(a: number, b: number): number { return a + b; }\n',
      );
      const ctx = { projectRoot: tempDir, meta: { codebaseIndexDir: indexDir } } as never;
      await codebaseIndexTool.execute({ force: true }, ctx, {
        signal: new AbortController().signal,
      });
      const output = await codebaseImpactAnalysisTool.execute(
        { symbol: 'calculateDiscount' },
        ctx,
        { signal: new AbortController().signal },
      );
      expect(output.symbolFound).toBe(false);
      expect(output.totalCallSites).toBe(0);
      expect(output.summary).toMatch(/not found/i);
    } finally {
      indexStorePool.evict(tempDir, indexDir);
      resetIndexStateForTesting();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('codebase-impact-analysis rejects an empty symbol', async () => {
    await expect(
      codebaseImpactAnalysisTool.execute({ symbol: '  ' }, { projectRoot: os.tmpdir() } as never, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/symbol is required/);
  });

  it('isTestFilePath requires a delimited test marker', () => {
    for (const p of [
      'tests/foo.ts',
      'src/__tests__/foo.ts',
      'src/foo.test.ts',
      'src/foo.spec.tsx',
      'pkg/foo_test.go',
      'test_foo.py',
      'fixtures/a.json',
      'src/mocks/db.ts',
      'benchmarks/run.ts',
    ]) {
      expect(isTestFilePath(p), p).toBe(true);
    }
    for (const p of [
      'src/inspect.ts',
      'src/latest/index.ts',
      'src/aspect.ts',
      'src/contest.ts',
      'src/respect_rules.ts',
    ]) {
      expect(isTestFilePath(p), p).toBe(false);
    }
  });

  it('parseTestCounts reads the vitest Tests line, not Test Files', () => {
    const vitest = ' Test Files  1 failed | 2 passed (3)\n      Tests  4 failed | 17 passed (21)\n';
    expect(parseTestCounts(vitest)).toEqual({ passed: 17, failed: 4 });
    expect(parseTestCounts('==== 1 failed, 3 passed in 0.2s ====')).toEqual({
      passed: 3,
      failed: 1,
    });
    expect(parseTestCounts('ok  \texample.com/pkg\t0.01s')).toBeNull();
  });

  it('codebase-targeted-test refuses flag-shaped and out-of-project test paths', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'targeted-guard-'));
    try {
      const ctx = { projectRoot: tempDir } as never;
      const opts = { signal: new AbortController().signal };
      await expect(
        codebaseTargetedTestTool.execute({ testFiles: ['--config=evil.ts'] }, ctx, opts),
      ).rejects.toThrow(/not a flag/);
      await expect(
        codebaseTargetedTestTool.execute({ testFiles: ['../../outside.test.ts'] }, ctx, opts),
      ).rejects.toThrow();
      await expect(codebaseTargetedTestTool.execute({}, ctx, opts)).rejects.toThrow(
        /at least one of/,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('codebase-impact-analysis accepts a project-relative file filter', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'impact-rel-'));
    const indexDir = path.join(tempDir, '.codebase-index');
    resetIndexStateForTesting();
    try {
      await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, 'src', 'calc.ts'),
        'export function add(a: number, b: number): number { return a + b; }\n',
      );
      await fs.writeFile(
        path.join(tempDir, 'src', 'caller.ts'),
        "import { add } from './calc.js';\nexport function runBatch(): number { return add(1, 2); }\n",
      );
      const ctx = {
        projectRoot: tempDir,
        meta: { codebaseIndexDir: indexDir },
      } as never;
      await codebaseIndexTool.execute({ force: true }, ctx, {
        signal: new AbortController().signal,
      });

      const output = await codebaseImpactAnalysisTool.execute(
        { symbol: 'add', file: 'src/calc.ts', transitive: true },
        ctx,
        { signal: new AbortController().signal },
      );

      // `symbolFound` is `true` when the indexed symbol resolved — assert the
      // exact value so an accidentally-`undefined` field (e.g. after an index
      // outage misrouting) fails loudly instead of passing `.not.toBe(false)`.
      expect(output.symbolFound).toBe(true);
      expect(output.totalCallSites).toBeGreaterThanOrEqual(1);
      expect(
        output.affectedProductionFiles.some((file) =>
          file.replace(/\\/g, '/').includes('caller.ts'),
        ),
      ).toBe(true);
    } finally {
      indexStorePool.evict(tempDir, indexDir);
      resetIndexStateForTesting();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('codebase-targeted-test locates convention test files and returns test result', {
    timeout: 120_000,
  }, async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'targeted-test-'));
    const srcDir = path.join(tempDir, 'src');
    const testsDir = path.join(tempDir, 'tests');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(testsDir, { recursive: true });

    const sourceFile = path.join(srcDir, 'calculator.ts');
    const testFile = path.join(testsDir, 'calculator.test.ts');

    await fs.writeFile(
      sourceFile,
      'export function add(a: number, b: number) { return a + b; }',
      'utf8',
    );
    await fs.writeFile(
      testFile,
      'import { add } from "../src/calculator.js"; console.log("Test passed");',
      'utf8',
    );

    try {
      const outcome = await codebaseTargetedTestTool
        .execute({ file: 'src/calculator.ts' }, { projectRoot: tempDir } as never, {
          signal: new AbortController().signal,
        })
        .then(
          (result) => ({ result }),
          (error: Error) => ({ error }),
        );

      if ('result' in outcome) {
        expect(outcome.result.discoveredSuites).toContain('tests/calculator.test.ts');
      } else {
        // This temp project has no vitest: `npx --no` refuses to download it.
        // That is a runner that never started — a failed call naming the
        // suites, not a red test run.
        expect(outcome.error.message).toMatch(/test runner could not start/);
        expect(outcome.error.message).toContain('tests/calculator.test.ts');
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
