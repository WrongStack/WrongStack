/**
 * test-runner-gate test discovery in a monorepo.
 *
 * The default patterns (`tests/{name}.test.ts`, `src/{name}.test.ts`) were
 * tried only at the project root and in the edited file's own directory, so
 * `packages/tools/src/tool-diff.ts` never found `packages/tools/tests/
 * tool-diff.test.ts` (measured on this repository: 0 of 3 real pairs), a
 * co-located `src/foo.test.ts` next to `src/foo.ts` was never found, and the
 * gate silently ran nothing on every edit.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findTestFile, resolveTestFiles } from '../src/test-runner-gate/test-runner.js';

const DEFAULT_PATTERNS = [
  '{dir}/{name}.test.ts',
  'src/{name}.test.ts',
  'tests/{name}.test.ts',
  'tests/{name}-exec.test.ts',
];
let root = '';

async function touch(path: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), '');
}
const norm = (value: string | null) => value?.replaceAll('\\', '/') ?? null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'trg-monorepo-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('test-runner-gate test discovery', () => {
  it('finds the package tests/ directory above a nested source file', async () => {
    await touch('packages/tools/tests/tool-diff.test.ts');
    const found = await findTestFile(
      join(root, 'packages/tools/src/tool-diff.ts'),
      DEFAULT_PATTERNS,
    );
    expect(norm(found)).toBe(norm(join(root, 'packages/tools/tests/tool-diff.test.ts')));
  });

  it('finds a co-located sibling test', async () => {
    await touch('packages/a/src/cart/total.test.ts');
    const found = await findTestFile(join(root, 'packages/a/src/cart/total.ts'), DEFAULT_PATTERNS);
    expect(norm(found)).toBe(norm(join(root, 'packages/a/src/cart/total.test.ts')));
  });

  it('names an index.ts test after its directory', async () => {
    await touch('packages/plugins/tests/type-gate.test.ts');
    const found = await findTestFile(
      join(root, 'packages/plugins/src/type-gate/index.ts'),
      DEFAULT_PATTERNS,
    );
    expect(norm(found)).toBe(norm(join(root, 'packages/plugins/tests/type-gate.test.ts')));
  });

  it('prefers the nearest package over a same-named test elsewhere up the tree', async () => {
    await touch('tests/util.test.ts');
    await touch('packages/b/tests/util.test.ts');
    const found = await findTestFile(join(root, 'packages/b/src/util.ts'), DEFAULT_PATTERNS);
    expect(norm(found)).toBe(norm(join(root, 'packages/b/tests/util.test.ts')));
  });

  it('anchors {dir} patterns to a POSIX absolute source path', () => {
    // A substituted candidate starting with "/" was dropped as an absolute
    // pattern, so on Linux and macOS no co-located test was ever found.
    const candidates = resolveTestFiles('/repo/packages/a/src/cart/total.ts', DEFAULT_PATTERNS);
    expect(candidates.map(norm)).toContain('/repo/packages/a/src/cart/total.test.ts');
  });

  it('still ignores a pattern that is itself absolute', () => {
    const candidates = resolveTestFiles('/repo/src/total.ts', ['/etc/{name}.test.ts']);
    expect(candidates).toEqual([]);
  });
});
