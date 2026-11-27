import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { polyglotInvariantEngine as invariantEngine } from '../src/codebase-index/ast-invariant-engine.js';
import { securityAstScanTool } from '../src/security-ast-scan-tool.js';
import { mkSandbox, type Sandbox } from './fixtures.js';

const spawnMocks = vi.hoisted(() => ({
  next: { stdout: '', stderr: '', exitCode: 0 } as Record<string, unknown>,
}));
vi.mock('../src/_spawn-stream.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  // biome-ignore lint/correctness/useYield: returns the final spawn result only
  spawnStream: async function* () {
    return { truncated: false, ...spawnMocks.next };
  },
}));

const { codebaseTargetedTestTool } = await import(
  '../src/codebase-index/codebase-targeted-test-tool.js'
);

/**
 * Verdicts the codebase tools gave that the evidence did not support
 * (tool pass 2026-11-27).
 */
describe('invariant check catches signature changes callers feel', () => {
  const original = 'export function add(a: number, b: number): number { return a + b; }\n';

  it('flags a return type replaced by an unrelated one (INV-004)', async () => {
    const res = await invariantEngine.evaluate({
      originalCode: original,
      modifiedCode: 'export function add(a: number, b: number): string { return `${a + b}`; }\n',
      lang: 'ts',
    });
    expect(res.valid).toBe(false);
    expect(res.violations.map((v) => v.ruleId)).toContain('INV-004');
  });

  it('accepts a narrowed return type', async () => {
    const res = await invariantEngine.evaluate({
      originalCode: 'export function f(): string | null { return null; }\n',
      modifiedCode: 'export function f(): string { return ""; }\n',
      lang: 'ts',
    });
    expect(res.violations.filter((v) => v.ruleId === 'INV-004')).toEqual([]);
  });

  it('flags a dropped positional parameter (INV-005), but not in plain JS', async () => {
    const dropped = 'export function add(a: number): number { return a; }\n';
    const ts = await invariantEngine.evaluate({
      originalCode: original,
      modifiedCode: dropped,
      lang: 'ts',
    });
    expect(ts.violations.find((v) => v.ruleId === 'INV-005')?.details?.removedParameter).toBe('b');
    const js = await invariantEngine.evaluate({
      originalCode: 'export function add(a, b) { return a + b; }\n',
      modifiedCode: 'export function add(a) { return a; }\n',
      lang: 'js',
    });
    expect(js.violations.filter((v) => v.ruleId === 'INV-005')).toEqual([]);
  });
});

describe('invariant check stays out of ordinary refactors', () => {
  const evaluate = (originalCode: string, modifiedCode: string) =>
    invariantEngine.evaluate({ originalCode, modifiedCode, lang: 'ts' });

  it('ignores a private helper whose return type or parameters change', async () => {
    const res = await evaluate(
      'function helper(a: number, b: number): number { return a + b; }\nexport const x = 1;\n',
      'function helper(a: number): string { return `${a}`; }\nexport const x = 1;\n',
    );
    expect(res.violations).toEqual([]);
  });

  it('treats void → value and Promise<A | B> → Promise<A> as compatible', async () => {
    const voidToValue = await evaluate(
      'export function f(): void {}\n',
      'export function f(): number { return 1; }\n',
    );
    expect(voidToValue.violations).toEqual([]);
    const narrowedPromise = await evaluate(
      'export async function g(): Promise<string | null> { return null; }\n',
      'export async function g(): Promise<string> { return ""; }\n',
    );
    expect(narrowedPromise.violations).toEqual([]);
  });
});

describe('security-ast-scan with nothing to scan', () => {
  it('fails the call instead of reporting "clean"', async () => {
    await expect(
      securityAstScanTool.execute({}, { projectRoot: process.cwd() } as never),
    ).rejects.toThrow(/provide `file`/);
  });
});

describe('codebase-targeted-test separates "runner missing" from "tests failed"', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await mkSandbox();
    await fs.writeFile(path.join(sb.dir, 'a.ts'), 'export const a = 1;\n');
    await fs.writeFile(path.join(sb.dir, 'a.test.ts'), 'import { a } from "./a";\n');
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('throws when npx refused to fetch the runner', async () => {
    spawnMocks.next = {
      stdout: '',
      stderr: 'npm error npx canceled due to missing packages and no YES option: ["vitest@5.1.2"]',
      exitCode: 1,
    };
    await expect(
      codebaseTargetedTestTool.execute({ testFiles: ['a.test.ts'] }, sb.ctx),
    ).rejects.toThrow(/test runner could not start: vitest is not installed/);
  });

  it('throws when the runner binary could not be spawned', async () => {
    spawnMocks.next = { stdout: '', stderr: '', exitCode: null, error: 'spawn npx ENOENT' };
    await expect(
      codebaseTargetedTestTool.execute({ testFiles: ['a.test.ts'] }, sb.ctx),
    ).rejects.toThrow(/could not start: spawn npx ENOENT/);
  });

  it('still reports a red run as failed data', async () => {
    spawnMocks.next = { stdout: ' Tests  1 failed | 2 passed (3)', stderr: '', exitCode: 1 };
    const out = await codebaseTargetedTestTool.execute({ testFiles: ['a.test.ts'] }, sb.ctx);
    expect(out).toMatchObject({ status: 'failed', failed: 1, passed: 2 });
  });
});
