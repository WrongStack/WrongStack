import { describe, expect, it } from 'vitest';
import { MAX_DIFF_TOKENS, wordDiff } from '../src/word-diff';

const side = (parts: NonNullable<ReturnType<typeof wordDiff>>, drop: 'add' | 'remove') =>
  parts
    .filter((part) => part.kind !== drop)
    .map((part) => part.text)
    .join('');

describe('word diff', () => {
  it('reconstructs both texts exactly and marks only changed words', () => {
    const before = 'fix the parser\nplease';
    const after = 'Fix the parser for empty input.\nplease';
    const parts = wordDiff(before, after)!;
    expect(side(parts, 'add')).toBe(before);
    expect(side(parts, 'remove')).toBe(after);
    expect(parts.filter((part) => part.kind === 'remove').map((part) => part.text)).toEqual([
      'fix',
    ]);
    expect(parts.filter((part) => part.kind === 'add').map((part) => part.text)).toEqual([
      'Fix',
      ' for empty input.',
    ]);
    // Adjacent unchanged words merge into one part.
    expect(parts.find((part) => part.kind === 'same')?.text).toBe(' the parser');
  });
  it('reports identical text as a single unchanged part', () => {
    expect(wordDiff('same words', 'same words')).toEqual([{ kind: 'same', text: 'same words' }]);
    expect(wordDiff('', '')).toEqual([]);
  });
  it('declines texts too large to compare instead of stalling', () => {
    const long = Array.from({ length: MAX_DIFF_TOKENS }, (_, i) => `w${i}`).join(' ');
    expect(wordDiff(long, 'short')).toBeNull();
    const a = Array.from({ length: 1200 }, (_, i) => `a${i}`).join(' '),
      b = Array.from({ length: 1200 }, (_, i) => `b${i}`).join(' ');
    // Fewer tokens than the limit per side, but the changed middle is too large a table.
    expect(wordDiff(a, b)).toBeNull();
  });
});
