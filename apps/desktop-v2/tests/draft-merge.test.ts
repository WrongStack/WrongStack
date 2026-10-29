import { describe, expect, it } from 'vitest';
import { mergedText, mergeSegments } from '../src/draft-merge';

describe('selective draft merge', () => {
  const mine = 'a\nmine one\nb\nc\nmine tail\n';
  const stored = 'a\nstored one\nb\nc\nstored tail\nextra\n';
  it('splits the drafts into shared lines and numbered changes', () => {
    const segments = mergeSegments(mine, stored);
    expect(segments.filter((segment) => segment.kind === 'change')).toEqual([
      { kind: 'change', id: 0, mine: ['mine one'], stored: ['stored one'] },
      { kind: 'change', id: 1, mine: ['mine tail'], stored: ['stored tail', 'extra'] },
    ]);
  });
  it('rebuilds either draft exactly and mixes choices per change', () => {
    const segments = mergeSegments(mine, stored);
    expect(mergedText(segments, {})).toBe(mine);
    expect(mergedText(segments, { 0: 'stored', 1: 'stored' })).toBe(stored);
    expect(mergedText(segments, { 0: 'stored' })).toBe('a\nstored one\nb\nc\nmine tail\n');
    expect(mergedText(segments, { 1: 'both' })).toBe(
      'a\nmine one\nb\nc\nmine tail\nstored tail\nextra\n',
    );
  });
  it('handles identical, empty and one-sided drafts', () => {
    expect(mergeSegments('x', 'x')).toEqual([{ kind: 'same', lines: ['x'] }]);
    const added = mergeSegments('', 'new');
    expect(mergedText(added, {})).toBe('');
    expect(mergedText(added, { 0: 'stored' })).toBe('new');
  });
});
