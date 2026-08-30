import { describe, expect, it } from 'vitest';
import { matchAny, matchGlob } from '../../src/utils/glob-match.js';

describe('glob-match', () => {
  it('matches *', () => {
    expect(matchGlob('*.ts', 'foo.ts')).toBe(true);
    expect(matchGlob('*.ts', 'src/foo.ts')).toBe(false);
  });

  it('matches **', () => {
    expect(matchGlob('**/*.ts', 'src/foo.ts')).toBe(true);
    expect(matchGlob('**/*.ts', 'foo.ts')).toBe(true);
    expect(matchGlob('src/**', 'src/foo/bar.ts')).toBe(true);
  });

  it('matches ?', () => {
    expect(matchGlob('a?c', 'abc')).toBe(true);
    expect(matchGlob('a?c', 'a/c')).toBe(false);
  });

  it('character classes', () => {
    expect(matchGlob('[abc].txt', 'a.txt')).toBe(true);
    expect(matchGlob('[abc].txt', 'd.txt')).toBe(false);
  });

  it('matchAny short-circuits', () => {
    expect(matchAny(['*.js', '*.ts'], 'foo.ts')).toBe(true);
    expect(matchAny(['*.js', '*.go'], 'foo.ts')).toBe(false);
  });

  it('character class negation works with [!...] (shell convention)', () => {
    expect(matchGlob('[!abc].txt', 'd.txt')).toBe(true);
    expect(matchGlob('[!abc].txt', 'a.txt')).toBe(false);
  });

  it('character class negation works with [^...] (regex convention)', () => {
    expect(matchGlob('[^abc].txt', 'd.txt')).toBe(true);
    expect(matchGlob('[^abc].txt', 'a.txt')).toBe(false);
  });

  it('character class supports ranges', () => {
    expect(matchGlob('file[0-9].txt', 'file7.txt')).toBe(true);
    expect(matchGlob('file[0-9].txt', 'fileA.txt')).toBe(false);
    expect(matchGlob('file[a-z].txt', 'fileq.txt')).toBe(true);
  });

  it('treats unclosed bracket as literal bracket rather than synthesizing an invalid wildcard', () => {
    expect(matchGlob('file[1.txt', 'file[1.txt')).toBe(true);
    expect(matchGlob('file[1.txt', 'filet')).toBe(false);
  });

  it('an over-long pattern is inert, not throwing — one bad trust entry must not break other commands (#20)', () => {
    // A >1024-char trust pattern (e.g. a long one-liner auto-trusted in
    // YOLO/Auto mode) used to throw out of every permission check, failing
    // unrelated commands like `true`/`ls`. It must now degrade to a non-match.
    const longPattern = `git log ${'A'.repeat(1100)}`;
    expect(longPattern.length).toBeGreaterThan(1024);
    expect(() => matchGlob(longPattern, 'true')).not.toThrow();
    expect(matchGlob(longPattern, 'true')).toBe(false);
    // And it must not poison matchAny for the other (valid) patterns.
    expect(() => matchAny([longPattern, 'ls', 'true'], 'true')).not.toThrow();
    expect(matchAny([longPattern, 'ls', 'true'], 'true')).toBe(true);
    expect(matchAny([longPattern, 'ls'], 'echo hello')).toBe(false);
  });
});
