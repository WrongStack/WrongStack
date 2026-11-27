import * as path from 'node:path';
import { createToolOutputSerializer } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebaseCheckerPaths } from '../src/_bun-typechecker.js';
import { typecheckTool } from '../src/typecheck.js';
import { mkSandbox, type Sandbox } from './fixtures.js';

const opts = () => ({ signal: new AbortController().signal });

/**
 * What the dev tools report must match what the underlying checker found
 * (tool pass 2026-11-27).
 */
describe('typecheck diagnostics point at project files', () => {
  const project = path.resolve('/work/proj');
  const checker = path.resolve('/home/u/.wrongstack/cache/bun-tsc/check-cwd');

  it('rebases checker-relative paths onto the project', () => {
    const fromChecker = path.relative(checker, path.join(project, 'src', 'a.ts'));
    const out = rebaseCheckerPaths(
      `${fromChecker}(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\n` +
        'Found 1 error in 1 file, checked 2 files',
      checker,
      project,
    );
    expect(out).toBe(
      "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
        'Found 1 error in 1 file, checked 2 files',
    );
  });

  it('makes a path outside the project absolute instead of a ../ chain', () => {
    const other = path.resolve('/elsewhere/lib.d.ts');
    const out = rebaseCheckerPaths(
      `${path.relative(checker, other)}(3,1): warning TS6385: deprecated`,
      checker,
      project,
    );
    expect(out).toBe(`${other.split(path.sep).join('/')}(3,1): warning TS6385: deprecated`);
  });

  it('leaves file-less diagnostics alone', () => {
    const line = "error TS5058: The specified path does not exist: 'x'.";
    expect(rebaseCheckerPaths(line, checker, project)).toBe(line);
  });
});

describe('typecheck refuses a named tsconfig that does not exist', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await mkSandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('throws instead of reporting TS5058 as one type error', async () => {
    await expect(
      typecheckTool.execute({ project: 'nope/tsconfig.json' }, sb.ctx, opts()),
    ).rejects.toThrow('typecheck: project "nope/tsconfig.json" does not exist');
  });
});

describe('a passing lint run with warnings shows them', () => {
  const serialize = (value: unknown) =>
    createToolOutputSerializer().serialize(value, { toolName: 'lint', input: {} });

  it('renders the warning diagnostics, not only their count', () => {
    const out = serialize({
      linter: 'biome',
      files_checked: 3,
      errors: 0,
      warnings: 1,
      exit_code: 0,
      output:
        'src/x.ts:1:5 lint/correctness/noUnusedVariables ━━━━\n  ! This variable unused is unused.\nChecked 3 files in 5ms.',
      fix_applied: false,
      truncated: false,
    });
    expect(out).toContain('status=passed');
    expect(out).toContain('warning_context:');
    expect(out).toContain('noUnusedVariables');
    expect(out).toContain('files_checked=3');
  });

  it('stays compact when there is nothing to show', () => {
    const out = serialize({
      linter: 'biome',
      errors: 0,
      warnings: 0,
      exit_code: 0,
      output: 'Checked 3 files in 5ms. No fixes applied.',
    });
    expect(out).not.toContain('warning_context');
  });
});
