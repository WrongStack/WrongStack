/**
 * grep translates `glob` for ripgrep by prefixing an "any depth" wildcard to
 * every pattern that does not already start with `!`, `*` or a leading wildcard
 * segment. That silently rewrote a root-relative pattern: `src/**` became an
 * any-depth `src/**` match, so `glob: 'src/**'` searched every `src` directory
 * in the tree (this repo: 1 file to 6764 files) while the native fallback and
 * the `glob` tool scope the same pattern to the project-relative `src` tree.
 * Results therefore depended on whether ripgrep happened to be installed.
 *
 * Both engines must select the same files for the same glob, and a pattern
 * containing a path separator must stay anchored to the search root.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __resetRgDetectionForTests, __setRgAvailableForTests, grepTool } from '../src/grep.js';
import { mkSandbox, newSignal, type Sandbox } from './fixtures.js';

let rgInstalled = true;
try {
  execFileSync('rg', ['--version'], { stdio: 'ignore' });
} catch {
  rgInstalled = false;
}

let sb: Sandbox;
beforeAll(async () => {
  sb = await mkSandbox();
  const put = async (rel: string) => {
    await fs.mkdir(path.dirname(path.join(sb.dir, rel)), { recursive: true });
    await fs.writeFile(path.join(sb.dir, rel), 'SCOPED_MARKER\n');
  };
  await put('src/nested/target.ts');
  await put('src/sibling.ts');
  await put('pkg/src/other.ts');
  await put('pkg/deep/src/deeper.ts');
  await put('root.ts');
});
afterAll(async () => {
  __resetRgDetectionForTests();
  await sb.cleanup();
});

const search = async (rg: boolean, glob?: string) => {
  __setRgAvailableForTests(rg);
  const out = await grepTool.execute(
    {
      pattern: 'SCOPED_MARKER',
      ...(glob === undefined ? {} : { glob }),
      output_mode: 'files_with_matches',
    },
    sb.ctx,
    { signal: newSignal() },
  );
  return out.matches.map((m) => m.replace(/\\/g, '/')).sort();
};

describe('grep: a glob with a path separator scopes to the search root', () => {
  it('native walker anchors src/** to the project-relative src tree', async () => {
    expect(await search(false, 'src/**')).toEqual(['src/nested/target.ts', 'src/sibling.ts']);
  });

  it.skipIf(!rgInstalled)('rg anchors src/** to the project-relative src tree too', async () => {
    // Control: without the glob the nested `src` trees are in scope, so an
    // rg engine that returns them under `src/**` really did widen the filter.
    expect(await search(true)).toContain('pkg/src/other.ts');
    expect(await search(true, 'src/**')).toEqual(['src/nested/target.ts', 'src/sibling.ts']);
  });

  it.skipIf(!rgInstalled)('both engines select the same files for src/**', async () => {
    expect(await search(true, 'src/**')).toEqual(await search(false, 'src/**'));
  });

  it.skipIf(!rgInstalled)('a bare filename glob still matches at any depth', async () => {
    // The unanchored case the `**​/` prefix exists for must keep working.
    expect(await search(true, '*.ts')).toEqual(await search(false, '*.ts'));
    expect(await search(true, '*.ts')).toEqual([
      'pkg/deep/src/deeper.ts',
      'pkg/src/other.ts',
      'root.ts',
      'src/nested/target.ts',
      'src/sibling.ts',
    ]);
  });
});
