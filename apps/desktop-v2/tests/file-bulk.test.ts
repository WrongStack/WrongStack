import { describe, expect, it } from 'vitest';
import {
  batchFailure,
  batchMoveItems,
  bulkDestination,
  bulkSummary,
  relocatedPath,
  runBulk,
  topLevelPaths,
} from '../src/file-bulk';

describe('bulk file actions', () => {
  it('drops items already covered by a selected folder', () => {
    expect(topLevelPaths(['src/a.ts', 'src', 'src-other/b.ts', 'src/deep/c.ts', 'src'])).toEqual([
      'src',
      'src-other/b.ts',
    ]);
  });
  it('relocates exact paths and descendants only', () => {
    expect(relocatedPath('docs', 'docs', 'archive/docs')).toBe('archive/docs');
    expect(relocatedPath('docs/a.md', 'docs', 'archive/docs')).toBe('archive/docs/a.md');
    expect(relocatedPath('docs-old/a.md', 'docs', 'archive/docs')).toBeNull();
  });
  it('keeps dot-folders and treats empty or ./ as the project root', () => {
    expect(bulkDestination('')).toBe('.');
    expect(bulkDestination(' ./ ')).toBe('.');
    expect(bulkDestination('.')).toBe('.');
    expect(bulkDestination('.github/')).toBe('.github');
    expect(bulkDestination('./src/lib//')).toBe('src/lib');
  });
  it('runs every item, records failures, and stops before the next item when asked', async () => {
    const seen: string[] = [];
    const outcome = await runBulk(['a', 'b', 'c'], async (path) => {
      seen.push(path);
      if (path === 'b') throw Error('ENOENT');
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(outcome).toEqual({
      done: ['a', 'c'],
      failed: [{ path: 'b', error: 'ENOENT' }],
      skipped: [],
    });
    expect(bulkSummary('Moved', 3, outcome)).toBe('Moved 2 of 3 items. Failed: b (ENOENT).');
    let stop = false;
    const stopped = await runBulk(
      ['x', 'y', 'z'],
      async () => {
        stop = true;
      },
      () => stop,
    );
    expect(stopped).toEqual({ done: ['x'], failed: [], skipped: ['y', 'z'] });
    expect(bulkSummary('Deleted', 3, stopped)).toBe('Deleted 1 of 3 items. Not attempted: y, z.');
  });
});

describe('all-or-nothing batches', () => {
  it('builds move items keeping names and rename items from the plan', () => {
    expect(batchMoveItems(['src/a.ts', 'docs'], 'lib')).toEqual([
      { from: 'src/a.ts', to: 'lib/a.ts' },
      { from: 'docs', to: 'lib/docs' },
    ]);
    expect(batchMoveItems(['src/a.ts'], '.', new Map([['src/a.ts', 'src/b.ts']]))).toEqual([
      { from: 'src/a.ts', to: 'src/b.ts' },
    ]);
  });
  it('says nothing changed unless the engine reports items it could not restore', () => {
    expect(batchFailure('lib/a.ts already exists.')).toBe(
      'lib/a.ts already exists. No item was changed.',
    );
    expect(batchFailure('EPERM. Nothing was changed.')).toBe('EPERM. No item was changed.');
    expect(batchFailure('EPERM. These items could not be put back: x.')).toMatch(/put back: x/);
  });
});
