import { describe, expect, it } from 'vitest';
import { patternIsLikelyCatastrophic } from '../../src/utils/json-schema-pattern-safety.js';

describe('patternIsLikelyCatastrophic nested groups', () => {
  it('flags a quantified atom hidden inside a nested group of an unbounded group', () => {
    expect(patternIsLikelyCatastrophic('^((a+)a)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^(?:(?:a+)a)+$')).toBe(true);
  });

  it('flags an alternation hidden inside a nested group', () => {
    expect(patternIsLikelyCatastrophic('^((a|aa)b?)+$')).toBe(true);
  });

  it('keeps flat and separator-disambiguated patterns as before', () => {
    expect(patternIsLikelyCatastrophic('^(a+a)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^[a-z0-9]+(?:-[a-z0-9]+)*$')).toBe(false);
    expect(patternIsLikelyCatastrophic('^(?:(?:-[a-z]+))+$')).toBe(false);
  });

  it('does not treat an optional atom as a mandatory separator', () => {
    expect(patternIsLikelyCatastrophic('^(a+b?)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^(\\w+\\s?)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^(?:a+b)+$')).toBe(false);
  });

  it('does not read a named-group name or lookbehind marker as a separator', () => {
    expect(patternIsLikelyCatastrophic('^(?<s>[a-z]+)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^(?<=x)(?:[a-z]+)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^(?<w>-[a-z]+)+$')).toBe(false);
  });

  it('requires every adjacent pair of quantified atoms to be disambiguated and parses [a\\\\]+ and []a]+ classes (F958)', () => {
    expect(patternIsLikelyCatastrophic('^(-a+a+)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^([a\\\\]+)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^([]a]+)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^(-a+-b+)+$')).toBe(false);
  });

  it('consumes full escape widths instead of fabricating separators from hex digits (F973)', () => {
    expect(patternIsLikelyCatastrophic('^(\\u0061+a?)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^(\\u0041+a?)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^(\\x61+a?)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^(\\u{61}+a?)+$')).toBe(true);

    // A decoded literal escape still proves a genuine separator.
    expect(patternIsLikelyCatastrophic('^(?:\\u002d[a-z]+)+$')).toBe(false);
    expect(patternIsLikelyCatastrophic('^(?:\\x2d[a-z]+)+$')).toBe(false);
  });

  it('never treats zero-width assertions or backreferences as separators (F973)', () => {
    expect(patternIsLikelyCatastrophic('^(a+\\Ba?)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^(a+\\ba?)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^(a+\\1a?)+$')).toBe(true);
    expect(patternIsLikelyCatastrophic('^(\\p{L}+a?)+$')).toBe(true);
  });
});
