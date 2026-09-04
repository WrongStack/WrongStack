import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resetIndexStateForTesting } from '../src/codebase-index/background-indexer.js';
import { codebaseIndexTool } from '../src/codebase-index/codebase-index-tool.js';
import {
  codebaseImpactAnalysisTool,
  codebaseTargetedTestTool,
} from '../src/codebase-index/index.js';
import { indexStorePool } from '../src/codebase-index/writer.js';

process.env['WRONGSTACK_INDEX_INLINE'] = '1';

describe('codebase-impact-analysis and codebase-targeted-test tools', () => {
  it('codebase-impact-analysis reports a missing symbol instead of a fake zero-risk blast radius', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'impact-test-'));

    try {
      const output = await codebaseImpactAnalysisTool.execute(
        { symbol: 'calculateDiscount' },
        { projectRoot: tempDir } as never,
        { signal: new AbortController().signal },
      );

      expect(output.status).toBe('ok');
      expect(output.symbol).toBe('calculateDiscount');
      expect(output.symbolFound).toBe(false);
      expect(output.totalCallSites).toBe(0);
      expect(output.summary).toMatch(/not found|Index query failed/i);
      expect(output.recommendedActionPlan.length).toBeGreaterThan(0);
      expect(output.recommendedActionPlan.join(' ')).not.toMatch(/0 call sites in 0 prod files/i);
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
      const result = await codebaseTargetedTestTool.execute(
        { file: 'src/calculator.ts' },
        { projectRoot: tempDir } as never,
        { signal: new AbortController().signal },
      );

      expect(result.discoveredSuites).toContain('tests/calculator.test.ts');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
