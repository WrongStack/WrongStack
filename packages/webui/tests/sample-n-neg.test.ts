import { describe, expect, it } from 'vitest';
import { sampleN } from '../src/lib/default-prompt-pools';

describe('sampleN bounds', () => {
  it('returns empty array for negative, zero, or NaN counts', () => {
    expect(sampleN(['a', 'b', 'c'], -1)).toEqual([]);
    expect(sampleN(['a', 'b', 'c'], 0)).toEqual([]);
    expect(sampleN(['a', 'b', 'c'], Number.NaN)).toEqual([]);
    expect(sampleN(['a', 'b', 'c'], 2)).toHaveLength(2);
  });
});
