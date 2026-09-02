import { describe, expect, it } from 'vitest';
import { isPossiblyContradictory } from '../src/store-helpers.js';

/**
 * Direct unit coverage of the shared contradiction heuristic (used by both
 * the remember merge path and the hygiene pass). Edge cases: strict-superset
 * negation vs qualifier, contraction stems, ambiguous standalone words, and
 * the conservative thresholds.
 */
describe('isPossiblyContradictory (shared heuristic)', () => {
  it('flags near-identical claims with opposite polarity', () => {
    expect(
      isPossiblyContradictory(
        { text: 'the database driver caches query results' },
        { text: 'the database driver does not cache query results' },
      ),
    ).toBe(true);
  });

  it('flags a strict superset whose extras are a hard negation', () => {
    expect(
      isPossiblyContradictory(
        { text: 'the build is stable when tests pass' },
        { text: 'the build is not stable when tests pass' },
      ),
    ).toBe(true);
  });

  it('does not flag a strict superset whose extras are a qualifier', () => {
    expect(
      isPossiblyContradictory(
        { text: 'the retry logic is safe to run twice' },
        { text: 'the retry logic is safe to run twice without concurrent writers' },
      ),
    ).toBe(false);
  });

  it('recognizes contraction stems (doesn’t / hasn’t / don’t / haven’t)', () => {
    expect(
      isPossiblyContradictory(
        { text: 'the driver caches query results by default' },
        { text: "the driver doesn't cache query results by default" },
      ),
    ).toBe(true);
    expect(
      isPossiblyContradictory(
        { text: 'the suite has fixed the flaky test' },
        { text: "the suite hasn't fixed the flaky test" },
      ),
    ).toBe(true);
    // 'don'/'haven' collide with standalone words — a false positive is only a
    // review candidate, while missing don't/haven't would let the negative
    // claim merge into its positive at write time, so detection wins.
    expect(
      isPossiblyContradictory(
        { text: 'we cache the intermediate build artifacts' },
        { text: "we don't cache the intermediate build artifacts" },
      ),
    ).toBe(true);
    expect(
      isPossiblyContradictory(
        { text: 'the builders finalized the release image' },
        { text: "the builders haven't finalized the release image" },
      ),
    ).toBe(true);
  });

  it('does not flag identical or unrelated texts', () => {
    expect(
      isPossiblyContradictory(
        { text: 'the api caches response data now' },
        { text: 'the api caches response data now' },
      ),
    ).toBe(false);
    expect(
      isPossiblyContradictory(
        { text: 'the api caches response data now' },
        { text: 'the api caches response data here' },
      ),
    ).toBe(false);
  });

  it('requires at least 5 tokens on both sides', () => {
    expect(isPossiblyContradictory({ text: 'not a fact' }, { text: 'a fact' })).toBe(false);
    expect(
      isPossiblyContradictory(
        { text: 'a very short claim here' },
        { text: 'not a very short claim here' },
      ),
    ).toBe(false); // 'a very short claim here' tokenizes to 4 kept tokens
  });
});
