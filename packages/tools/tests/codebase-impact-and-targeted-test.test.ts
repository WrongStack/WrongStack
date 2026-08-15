import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codebaseImpactAnalysisTool,
  codebaseTargetedTestTool,
} from '../src/codebase-index/index.js';

describe('codebase-impact-analysis and codebase-targeted-test tools', () => {
  it('codebase-impact-analysis calculates blast radius and produces action plan', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'impact-test-'));

    try {
      const output = await codebaseImpactAnalysisTool.execute(
        { symbol: 'calculateDiscount' },
        { projectRoot: tempDir },
      );

      expect(output.status).toBe('ok');
      expect(output.symbol).toBe('calculateDiscount');
      expect(output.riskLevel).toBeDefined();
      expect(output.recommendedActionPlan.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('codebase-targeted-test locates convention test files and returns test result', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'targeted-test-'));
    const srcDir = path.join(tempDir, 'src');
    const testsDir = path.join(tempDir, 'tests');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(testsDir, { recursive: true });

    const sourceFile = path.join(srcDir, 'calculator.ts');
    const testFile = path.join(testsDir, 'calculator.test.ts');

    await fs.writeFile(sourceFile, 'export function add(a: number, b: number) { return a + b; }', 'utf8');
    await fs.writeFile(testFile, 'import { add } from "../src/calculator.js"; console.log("Test passed");', 'utf8');

    try {
      const result = await codebaseTargetedTestTool.execute(
        { file: 'src/calculator.ts' },
        { projectRoot: tempDir },
      );

      expect(result.discoveredSuites).toContain('tests/calculator.test.ts');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
