import { describe, expect, it } from 'vitest';
import { buildPackageGraphNodes } from '../src/writer-graph-helpers.js';

describe('buildPackageGraphNodes non-finite symbol counts', () => {
  it('treats non-finite and negative symbol counts as 0 instead of poisoning totals', () => {
    const { pkgNodes } = buildPackageGraphNodes(
      [
        { file: 'a/1.ts', n: 5 },
        { file: 'a/2.ts', n: Number.NaN },
        { file: 'a/3.ts', n: -3 },
        { file: 'b/1.ts', n: Number.POSITIVE_INFINITY },
      ],
      [{ file: 'a/1.ts' }],
      (f) => f.split('/')[0]!,
    );
    expect(pkgNodes.get('a')?.symbolCount).toBe(5);
    expect(pkgNodes.get('b')?.symbolCount).toBe(0);
  });
});
