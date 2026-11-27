import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetRgDetectionForTests, __setRgAvailableForTests, grepTool } from '../src/grep.js';
import { mkSandbox, newSignal, type Sandbox } from './fixtures.js';

// A shell-style `path` (`packages/{a,b}/src`) used to fail with
// `path "…" does not exist`; it now expands to concrete search roots.
describe.each([
  ['rg', undefined],
  ['native', false],
] as const)('grep path expansion (%s)', (_label, rgAvailable) => {
  let sb: Sandbox;
  beforeEach(async () => {
    __resetRgDetectionForTests();
    if (rgAvailable === false) __setRgAvailableForTests(false);
    sb = await mkSandbox();
    for (const pkg of ['runtime', 'cli', 'tui', 'other']) {
      await fs.mkdir(path.join(sb.dir, 'packages', pkg, 'src'), { recursive: true });
      await fs.writeFile(path.join(sb.dir, 'packages', pkg, 'src', 'x.ts'), `needle ${pkg}\n`);
    }
  });
  afterEach(async () => {
    __resetRgDetectionForTests();
    await sb.cleanup();
  });

  const files = (matches: string[]) =>
    matches.map((m) => m.replace(/\\/g, '/').replace(/:.*$/, '')).sort();

  it('expands brace alternation and skips missing alternatives', async () => {
    const out = await grepTool.execute(
      {
        pattern: 'needle',
        path: 'packages/{runtime,cli,tui,webui-server}/src',
        output_mode: 'files_with_matches',
      },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(files(out.matches)).toEqual([
      'packages/cli/src/x.ts',
      'packages/runtime/src/x.ts',
      'packages/tui/src/x.ts',
    ]);
    expect(out.count).toBe(3);
  });

  it('expands single-segment wildcards', async () => {
    const out = await grepTool.execute(
      { pattern: 'needle', path: 'packages/*/src', output_mode: 'files_with_matches' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(files(out.matches)).toHaveLength(4);
  });

  it('shares the limit across expanded roots', async () => {
    const out = await grepTool.execute(
      { pattern: 'needle', path: 'packages/{runtime,cli,tui}/src', limit: 2 },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(out.matches).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it('prefers an existing literal path containing braces', async () => {
    await fs.mkdir(path.join(sb.dir, '{a,b}'));
    await fs.writeFile(path.join(sb.dir, '{a,b}', 'f.txt'), 'needle literal\n');
    const out = await grepTool.execute(
      { pattern: 'needle', path: '{a,b}', output_mode: 'files_with_matches' },
      sb.ctx,
      { signal: newSignal() },
    );
    expect(files(out.matches)).toEqual(['{a,b}/f.txt']);
  });

  it('still rejects when no expansion exists', async () => {
    await expect(
      grepTool.execute({ pattern: 'needle', path: 'packages/{nope,gone}/src' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/matched no existing file or directory/);
  });

  it('points `**` in path at the glob argument', async () => {
    await expect(
      grepTool.execute({ pattern: 'needle', path: 'packages/**/src' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/glob/);
  });
});
