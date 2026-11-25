import { describe, expect, it } from 'vitest';
import { buildCompactFileTree } from '../src/lib/compact-file-tree.js';

describe('buildCompactFileTree non-finite line counts (F1878)', () => {
  it('ignores NaN and Infinity added/deleted values when aggregating directory totals', () => {
    const tree = buildCompactFileTree([
      { path: 'src/a.ts', added: 10, deleted: 2 },
      { path: 'src/b.ts', added: Number.NaN, deleted: Number.POSITIVE_INFINITY },
      { path: 'src/c.ts', added: Number.NEGATIVE_INFINITY, deleted: 3 },
    ]);
    const dir = tree[0];
    expect(dir?.kind).toBe('dir');
    if (dir?.kind === 'dir') {
      expect(dir.added).toBe(10);
      expect(dir.deleted).toBe(5);
      expect(dir.fileCount).toBe(3);
    }
  });
});
