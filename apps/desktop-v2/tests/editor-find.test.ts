import { describe, expect, it } from 'vitest';
import {
  findMatches,
  MAX_MATCHES,
  matchLines,
  nextMatchIndex,
  replaceAllMatches,
} from '../src/editor-find';

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
  it('maps matches back to original indices when lowering lengthens a character (İ)', () => {
    // U+0130 İ lowercases to i + combining dot (2 units), so lowered-space indices
    // stop addressing the original text; every match after an İ was shifted before
    // the index map, and replace-all then corrupted text instead of replacing.
    expect(findMatches('\u0130x', 'x', false)).toEqual([{ start: 1, end: 2 }]);
    expect(findMatches('\u0130xx', 'xx', false)).toEqual([{ start: 1, end: 3 }]);
    expect(findMatches('\u0130 a x', 'a', false)).toEqual([{ start: 2, end: 3 }]);
    expect(replaceAllMatches('\u0130x', 'x', 'foo', false)).toEqual({
      text: '\u0130foo',
      count: 1,
    });
    // A needle matching inside the lengthened İ consumes the whole character.
    expect(findMatches('\u0130', 'i', false)).toEqual([{ start: 0, end: 1 }]);
    expect(replaceAllMatches('\u0130', 'i', 'I', false)).toEqual({ text: 'I', count: 1 });
    // The needle's own lowering can also lengthen: its lowered width bounds the match.
    expect(findMatches('i\u0307 x', '\u0130', false)).toEqual([{ start: 0, end: 2 }]);
    expect(replaceAllMatches('i\u0307 x', '\u0130', '\u0130', false)).toEqual({
      text: '\u0130 x',
      count: 1,
    });
  });
});

describe('match lines', () => {
  it('lists each matching line once, in order', () => {
    const text = 'a x x\nb\nx c\n\nx';
    expect(matchLines(text, findMatches(text, 'x', true))).toEqual([1, 3, 5]);
    expect(matchLines(text, [])).toEqual([]);
    expect(matchLines('ab\ncd', findMatches('ab\ncd', 'b\nc', true))).toEqual([1]);
  });
});
