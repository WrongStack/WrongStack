import { describe, expect, it } from 'vitest';
import { findMatches, MAX_MATCHES, nextMatchIndex, replaceAllMatches } from '../src/editor-find';

describe('editor find and replace', () => {
  it('finds literal, non-overlapping matches with optional case', () => {
    expect(findMatches('aaaa', 'aa', true)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
    expect(findMatches('Foo foo FOO', 'foo', false)).toHaveLength(3);
    expect(findMatches('Foo foo FOO', 'foo', true)).toEqual([{ start: 4, end: 7 }]);
    // Regex characters are literal.
    expect(findMatches('a.b axb', 'a.b', true)).toEqual([{ start: 0, end: 3 }]);
    expect(findMatches('text', '', true)).toEqual([]);
  });
  it('moves forward and backward from the caret, wrapping at the ends', () => {
    const matches = findMatches('x1 x2 x3', 'x', true);
    expect(nextMatchIndex(matches, 0, 1)).toBe(0);
    expect(nextMatchIndex(matches, 1, 1)).toBe(1);
    expect(nextMatchIndex(matches, 8, 1)).toBe(0);
    expect(nextMatchIndex(matches, 4, -1)).toBe(1);
    expect(nextMatchIndex(matches, 0, -1)).toBe(2);
    expect(nextMatchIndex([], 0, 1)).toBe(-1);
  });
  it('replaces every match literally and refuses a capped match list', () => {
    expect(replaceAllMatches('a $1 a', 'a', '$&b', true)).toEqual({ text: '$&b $1 $&b', count: 2 });
    expect(replaceAllMatches('none', 'x', 'y', true)).toEqual({ text: 'none', count: 0 });
    const many = 'z'.repeat(MAX_MATCHES + 5);
    expect(findMatches(many, 'z', true)).toHaveLength(MAX_MATCHES);
    expect(replaceAllMatches(many, 'z', 'y', true)).toEqual({ text: many, count: 0 });
  });
});
