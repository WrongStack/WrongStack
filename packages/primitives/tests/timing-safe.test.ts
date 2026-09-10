import { describe, expect, it } from 'vitest';
import { timingSafeTokenEqual } from '../src/timing-safe.js';

describe('timingSafeTokenEqual', () => {
  it('accepts an exact match', () => {
    expect(timingSafeTokenEqual('a3f9c1', 'a3f9c1')).toBe(true);
  });

  it('rejects a different token of the same length', () => {
    expect(timingSafeTokenEqual('a3f9c1', 'a3f9c2')).toBe(false);
  });

  it('rejects on a length mismatch instead of throwing', () => {
    // node's timingSafeEqual throws on unequal lengths; the short-circuit is
    // what keeps a wrong-length guess from crashing the daemon. Length is not
    // the secret — these tokens are fixed-width hex.
    expect(timingSafeTokenEqual('short', 'muchlongertoken')).toBe(false);
    expect(timingSafeTokenEqual('muchlongertoken', 'short')).toBe(false);
  });

  it('never authenticates an absent value', () => {
    // The failure that matters: an unset supplied token must not match an
    // unset expectation and hand out an authenticated session.
    expect(timingSafeTokenEqual(undefined, undefined)).toBe(false);
    expect(timingSafeTokenEqual('', '')).toBe(false);
    expect(timingSafeTokenEqual(null, 'expected')).toBe(false);
    expect(timingSafeTokenEqual('supplied', undefined)).toBe(false);
  });

  it('compares by bytes, not code units', () => {
    // Two strings of equal .length can differ in UTF-8 byte length; the
    // comparison must not throw on them.
    expect(timingSafeTokenEqual('é', 'e')).toBe(false);
  });
});
