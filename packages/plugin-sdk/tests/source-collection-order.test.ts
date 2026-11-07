import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoundedSet, collectSourceFiles, collectSourceFilesAsync } from '../src/runtime/index.js';

let root = '';
const expected = () => ['alpha.ts', 'Beta.ts', 'zeta.ts'].map((name) => join(root, name));

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sdk-source-order-'));
  mkdirSync(join(root, 'nested'));
  for (const name of ['zeta.ts', 'Beta.ts', 'alpha.ts']) writeFileSync(join(root, name), '');
  writeFileSync(join(root, 'nested', 'leaf.ts'), '');
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('source collection locale order', () => {
  it('async collection uses locale ordering and respects depth zero', async () => {
    expect(await collectSourceFilesAsync(root, { extensions: ['.ts'], maxDepth: 0 })).toEqual(
      expected(),
    );
  });

  it('sync collection honors the documented locale-aware ordering', () => {
    expect(
      collectSourceFiles(root, { extensions: ['.ts'], maxDepth: 0 }),
      'FAIL: synchronous source collection must use locale-aware ordering',
    ).toEqual(expected());
  });

  it('sync and async collectors keep the same ordering when recursing', async () => {
    const options = { extensions: ['ts'], maxDepth: 1 };
    const asynchronous = await collectSourceFilesAsync(root, options);
    expect(asynchronous).toContain(join(root, 'nested', 'leaf.ts'));
    expect(collectSourceFiles(root, options), 'FAIL: sync/async source order diverged').toEqual(
      asynchronous,
    );
  });

  it('normalizes relative single-file roots to absolute paths and tolerates missing roots (F83)', async () => {
    const targetFile = join(root, 'alpha.ts');
    const relFile = relative(process.cwd(), targetFile);
    const syncFiles = collectSourceFiles(relFile, { extensions: ['.ts'] });
    const asyncFiles = await collectSourceFilesAsync(relFile, { extensions: ['.ts'] });
    expect(syncFiles).toEqual([resolve(relFile)]);
    expect(isAbsolute(syncFiles[0]!)).toBe(true);
    expect(asyncFiles).toEqual([resolve(relFile)]);

    const missing = join(root, 'does-not-exist.ts');
    expect(collectSourceFiles(missing, { extensions: ['.ts'] })).toEqual([]);
    expect(await collectSourceFilesAsync(missing, { extensions: ['.ts'] })).toEqual([]);
  });

  it('promotes accessed BoundedSet entries in LRU order on has() (F83)', () => {
    const set = new BoundedSet<string>({ max: 2 });
    set.add('hot');
    set.add('cold');
    expect(set.has('hot')).toBe(true);
    set.add('newest');
    expect(set.has('hot')).toBe(true);
    expect(set.has('cold')).toBe(false);
    expect(set.has('newest')).toBe(true);
  });
});
