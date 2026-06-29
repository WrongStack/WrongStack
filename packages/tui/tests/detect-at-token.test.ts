import { describe, expect, it } from 'vitest';
import { detectAtToken } from '../src/hooks/use-file-search.js';

describe('detectAtToken', () => {
  it('returns null when no @ is present', () => {
    expect(detectAtToken('hello world', 11)).toBeNull();
  });

  it('detects @ at the start of buffer', () => {
    expect(detectAtToken('@src', 4)).toEqual({ start: 0, end: 4, query: 'src' });
  });

  it('detects @ after a space', () => {
    expect(detectAtToken('look at @app', 12)).toEqual({
      start: 8,
      end: 12,
      query: 'app',
    });
  });

  it('does not match @ embedded in a word (email-like)', () => {
    expect(detectAtToken('foo@bar', 7)).toBeNull();
  });

  it('returns empty query right after @', () => {
    expect(detectAtToken('@', 1)).toEqual({ start: 0, end: 1, query: '' });
  });

  it('stops at whitespace inside the token', () => {
    expect(detectAtToken('@src tail', 9)).toBeNull();
  });

  it('handles cursor mid-token (not at end of buffer)', () => {
    // buffer = "see @sr|c here", cursor between r and c
    expect(detectAtToken('see @src here', 7)).toEqual({
      start: 4,
      end: 7,
      query: 'sr',
    });
  });

  it('handles tab and newline as boundaries', () => {
    expect(detectAtToken('hi\t@x', 5)).toEqual({ start: 3, end: 5, query: 'x' });
    expect(detectAtToken('hi\n@x', 5)).toEqual({ start: 3, end: 5, query: 'x' });
  });
});
