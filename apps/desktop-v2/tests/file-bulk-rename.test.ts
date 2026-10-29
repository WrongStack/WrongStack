import { describe, expect, it } from 'vitest';
import { bulkRenamePlan, copyTarget, EMPTY_SHA256 } from '../src/file-bulk';

describe('bulk rename plan', () => {
  it('replaces literal text in names only and keeps folders in place', () => {
    const plan = bulkRenamePlan(
      ['src/old-a.ts', 'src/lib/old.b.ts', 'README.md', 'old-dir'],
      'old',
      'new',
      true,
    );
    expect(plan.steps).toEqual([
      { from: 'src/old-a.ts', to: 'src/new-a.ts' },
      { from: 'src/lib/old.b.ts', to: 'src/lib/new.b.ts' },
      { from: 'old-dir', to: 'new-dir' },
    ]);
    expect(plan.unchanged).toEqual(['README.md']);
    expect(plan.problems).toEqual([]);
    // Folder names in the path are never touched, and regex characters are literal.
    expect(bulkRenamePlan(['old/x.ts'], 'old', 'new', true).steps).toEqual([]);
    expect(bulkRenamePlan(['a.b.ts'], '.', '_', true).steps).toEqual([
      { from: 'a.b.ts', to: 'a_b_ts' },
    ]);
  });
  it('honours match case', () => {
    expect(bulkRenamePlan(['Old.ts'], 'old', 'new', true).steps).toEqual([]);
    expect(bulkRenamePlan(['Old.ts'], 'old', 'new', false).steps).toEqual([
      { from: 'Old.ts', to: 'new.ts' },
    ]);
  });
  it('reports invalid names, collisions and swaps instead of planning them', () => {
    expect(bulkRenamePlan(['a/x.ts'], 'x.ts', '', true).problems[0]).toContain('not a valid name');
    expect(bulkRenamePlan(['x.ts'], 'x', 'y/z', true).problems[0]).toContain('not a valid name');
    expect(bulkRenamePlan(['x.ts'], 'x.ts', '..', true).problems[0]).toContain('not a valid name');
    const collision = bulkRenamePlan(['a-1.ts', 'a-2.ts'], '-2', '-1', true);
    expect(collision.problems).toEqual(['a-2.ts would take the name of selected item a-1.ts.']);
    const same = bulkRenamePlan(['v1/a.ts', 'v1/A.TS'], 'a', 'b', false);
    expect(same.problems).toEqual(['v1/a.ts and v1/A.TS would both become v1/b.TS.']);
  });
  it('plans nothing until there is text to find', () => {
    expect(bulkRenamePlan(['a.ts'], '', 'b', true)).toEqual({
      steps: [],
      unchanged: ['a.ts'],
      problems: [],
    });
  });
});

describe('bulk copy targets', () => {
  it('keeps the name inside the destination folder or the project root', () => {
    expect(copyTarget('src/a.ts', 'lib')).toBe('lib/a.ts');
    expect(copyTarget('a.ts', '.')).toBe('a.ts');
    expect(copyTarget('deep/x/y.md', 'docs/notes')).toBe('docs/notes/y.md');
  });
  it('binds the first write to empty content', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array());
    expect(
      Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''),
    ).toBe(EMPTY_SHA256);
  });
});
