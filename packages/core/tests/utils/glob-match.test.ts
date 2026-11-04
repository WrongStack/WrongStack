import { describe, expect, it } from 'vitest';
import {
  compileGlobMatcher,
  matchAny,
  matchAnyCommand,
  matchCommandGlob,
  matchGlob,
} from '../../src/utils/glob-match.js';

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

  it('a literal ] as the first class member is a member, not the terminator ([]] / []a])', () => {
    // `[]]` is the standard glob spelling for class { ']' }. The parser used
    // to terminate the class on that first `]`, compiling an empty class
    // `[]` that could never match — every one of these assertions was false.
    expect(matchGlob('[]]', ']')).toBe(true);
    expect(matchGlob('[]]', 'a')).toBe(false);
    expect(matchGlob('[]a]', ']')).toBe(true);
    expect(matchGlob('[]a]', 'a')).toBe(true);
    expect(matchGlob('[]a]', 'b')).toBe(false);
    expect(matchGlob('*[]]*', 'a]b')).toBe(true);
    expect(matchGlob('*[]]*', 'abc')).toBe(false);
  });

  it('negation with a literal ] member rejects ] only', () => {
    expect(matchGlob('[!]]', 'a')).toBe(true);
    expect(matchGlob('[!]]', ']')).toBe(false);
    expect(matchGlob('[^]a]', 'b')).toBe(true);
    expect(matchGlob('[^]a]', ']')).toBe(false);
    expect(matchGlob('[^]a]', 'a')).toBe(false);
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

describe('compileGlobMatcher required-literal short-circuit', () => {
  const START_ANY_SEGMENT = (i: number, s: string) => i === 0 || s[i - 1] === '/';
  const END_EQ_OR_UNDER = (i: number, s: string) => i === s.length || s[i] === '/';

  it('still matches when the longest literal run sits between wildcards', () => {
    const m = compileGlobMatcher('a*-eval-tr.json?');
    expect(m.test('abc-eval-tr.jsonl')).toBe(true);
    expect(m.test('abc-eval-t.jsonl')).toBe(false);
  });

  it('does not fold a class member into the literal run', () => {
    expect(compileGlobMatcher('[ab]cd').test('bcd')).toBe(true);
    expect(compileGlobMatcher('[ab]cd').test('ccd')).toBe(false);
  });

  it('finds the literal run inside a span, not only at the string start', () => {
    const m = compileGlobMatcher('node_modules');
    expect(m.testSpan('packages/x/node_modules/y', START_ANY_SEGMENT, END_EQ_OR_UNDER)).toBe(true);
    expect(m.testSpan('packages/x/node_module/y', START_ANY_SEGMENT, END_EQ_OR_UNDER)).toBe(false);
  });

  it('matches a pattern with no literals at all', () => {
    expect(compileGlobMatcher('*').test('anything')).toBe(true);
    expect(compileGlobMatcher('**').test('a/b/c')).toBe(true);
  });

  it('handles unclosed leading-!]; and valid []a] character classes in matchGlob (F959)', () => {
    expect(() => matchGlob('[!]a*', '[!]abc')).not.toThrow();
    expect(matchGlob('[!]a*', '[!]abc')).toBe(true);
    expect(matchGlob('[]a]', ']')).toBe(true);
    expect(matchGlob('[]a]', 'a')).toBe(true);
    expect(matchGlob('[]a]', 'b')).toBe(false);
  });

  it('keeps path and command compile caches separate for NUL-bearing patterns (F972)', () => {
    // A command-mode pattern primes `cmd\u0000<pattern>`; a path pattern that
    // literally starts with `cmd\u0000` must not reuse it.
    expect(matchCommandGlob('f972-*', 'f972-bash')).toBe(true);
    expect(matchGlob('cmd\u0000f972-*', 'f972-bash')).toBe(false);
    expect(matchAnyCommand(['f972-*'], 'f972-bash')).toBe(true);
    expect(matchAny(['cmd\u0000f972-*'], 'f972-bash')).toBe(false);

    // And the reverse: a NUL-bearing path pattern must not poison command mode.
    expect(matchGlob('cmd\u0000f972rev*', 'x')).toBe(false);
    expect(matchCommandGlob('f972rev*', 'f972rev')).toBe(true);
  });
});
