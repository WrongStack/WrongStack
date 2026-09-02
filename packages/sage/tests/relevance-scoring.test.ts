import { describe, expect, it } from 'vitest';
import { overlapCoefficient, tokenize } from '../src/middleware/turn-memory.js';
import { tokenize as helpersTokenize } from '../src/store-helpers.js';

describe('tokenize', () => {
  it('is the single canonical implementation shared with the stores', () => {
    // turn-memory re-exports the store-helpers tokenizer — if this identity
    // breaks, retrieval scoring and injection scoring silently diverge again.
    expect(tokenize).toBe(helpersTokenize);
  });

  it('splits a simple sentence into lowercase tokens', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('keeps identifier characters (hyphen, underscore, dot) inside tokens', () => {
    expect(tokenize('foo-bar_baz!@#')).toEqual(['foo-bar_baz']);
  });

  it('handles mixed case', () => {
    expect(tokenize('CamelCase SNAKE_CASE')).toEqual(['camelcase', 'snake_case']);
  });

  it('filters out tokens shorter than 3 characters', () => {
    expect(tokenize('a big x tool')).toEqual(['big', 'tool']);
  });

  it('handles numbers (filters tokens shorter than 3 characters)', () => {
    // '2' and 'of' are filtered (length < 3), '4096' survives
    expect(tokenize('version 2 of 4096 chars')).toEqual(['version', '4096', 'chars']);
  });

  it('deduplicates repeated tokens', () => {
    expect(tokenize('test Test TEST')).toEqual(['test']);
  });

  it('collapses multiple spaces', () => {
    expect(tokenize('  multiple    spaces   ')).toEqual(['multiple', 'spaces']);
  });

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('returns empty array for punctuation-only string', () => {
    expect(tokenize('!@#$%^&*()')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(tokenize('   \t\n  ')).toEqual([]);
  });

  it('preserves unicode letters via NFKC instead of stripping them', () => {
    expect(tokenize('café—naïve')).toEqual(['café', 'naïve']);
  });
});

describe('overlapCoefficient', () => {
  it('returns 1 for identical strings', () => {
    expect(overlapCoefficient('memory middleware', 'memory middleware')).toBe(1);
  });

  it('returns 1 when every query token appears in a longer text', () => {
    // Query is a subset of text — overlap coefficient = intersection / min(|A|,|B|) = 3/3
    expect(
      overlapCoefficient('run lifecycle tests', 'always run lifecycle tests before deploy'),
    ).toBe(1);
  });

  it('returns 1 when every text token appears in a longer query', () => {
    // Text is a subset of query — overlap coefficient = intersection / min(|A|,|B|) = 2/2
    expect(overlapCoefficient('lifecycle tests run deploy hooks', 'lifecycle tests')).toBe(1);
  });

  it('returns 0 for completely disjoint token sets', () => {
    expect(overlapCoefficient('database migration', 'frontend styling')).toBe(0);
  });

  it('returns 0 for empty query', () => {
    expect(overlapCoefficient('', 'some memory text')).toBe(0);
  });

  it('returns 0 for empty text', () => {
    expect(overlapCoefficient('some query', '')).toBe(0);
  });

  it('returns 0 when both inputs are empty', () => {
    expect(overlapCoefficient('', '')).toBe(0);
  });

  it('returns 0 for whitespace-only inputs', () => {
    expect(overlapCoefficient('   ', '  \t ')).toBe(0);
  });

  it('returns 0 for punctuation-only inputs', () => {
    expect(overlapCoefficient('!@#', '$%^')).toBe(0);
  });

  it('computes partial overlap correctly', () => {
    // query tokens: {memory, retrieval, scoring} (3)
    // text tokens: {memory, injection, scoring, pipeline} (4)
    // intersection: {memory, scoring} = 2
    // min(3, 4) = 3 → 2/3
    expect(
      overlapCoefficient('memory retrieval scoring', 'memory injection scoring pipeline'),
    ).toBeCloseTo(2 / 3, 10);
  });

  it('handles single-token query that matches', () => {
    expect(overlapCoefficient('middleware', 'memory middleware pipeline')).toBe(1);
  });

  it('handles single-token query that does not match', () => {
    expect(overlapCoefficient('database', 'memory middleware pipeline')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(overlapCoefficient('MEMORY MIDDLEWARE', 'memory middleware')).toBe(1);
  });

  it('deduplicates repeated tokens before computing overlap', () => {
    // query: {the, test} (2 unique), text: {the, test, runs} (3 unique)
    // intersection: {the, test} = 2, min(2, 3) = 2 → 1.0
    expect(overlapCoefficient('the the test test', 'the test runs')).toBe(1);
  });

  it('does not penalize longer text for extra tokens', () => {
    // This is the key property vs Jaccard: a very detailed memory that covers
    // all query tokens should score 1.0 regardless of how many extra tokens it has.
    const query = 'auth token validation';
    const detailedMemory =
      'auth token validation must check expiry signature scope audience issuer ' +
      'clock skew rotation revocation rate limiting ip binding';
    expect(overlapCoefficient(query, detailedMemory)).toBe(1);
  });
});
