import { describe, expect, it } from 'vitest';
import {
  findDuplicates,
  removeInlineComments,
} from '../src/duplicate-code-detector/duplicate-code-analysis.js';

describe('duplicate-code-analysis comment stripping and maxFindings bounds (F1974)', () => {
  it('removes all inline block comments on the same line', () => {
    const stripped = removeInlineComments('const x = /* a */ 1 + /* b */ 2;');
    expect(stripped).not.toContain('/*');
    expect(stripped).toContain('1 +');
  });

  it('clamps negative maxFindings to 0 instead of slicing from the end', () => {
    const block = 'const a = 1;\nconst b = 2;\nconst c = 3;';
    const files = new Map([
      ['a.ts', block],
      ['b.ts', block],
      ['c.ts', 'const d = 4;\nconst e = 5;\nconst f = 6;'],
      ['d.ts', 'const d = 4;\nconst e = 5;\nconst f = 6;'],
    ]);
    expect(findDuplicates(files, 2, -1)).toEqual([]);
    expect(findDuplicates(files, 2, 1)).toHaveLength(1);
  });
});
