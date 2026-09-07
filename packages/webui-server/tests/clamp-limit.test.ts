/**
 * Regression for S10 (H1): the WS surface previously passed a
 * model-controlled `maxNodes` / `limit` / `hops` straight through to
 * the project chronicle, where `chronicle.graph {maxNodes: 1e9}`
 * materialised the entire journal (measured at 7.2 GB / 7 days) and
 * then ran a cubic edge build. The `clampLimit` helper mirrors the
 * existing HTTP chronicle.query cap (10000) and the HTTP graph cap
 * (1000), so a missing clamp in a future route fails this test
 * instead of degrading silently under load.
 */
import { describe, expect, it } from 'vitest';
import { clampLimit } from '../src/server/ws-payload-validation.js';

describe('clampLimit (S10 / H1)', () => {
  it('returns the default for undefined / non-finite / non-number', () => {
    expect(clampLimit(undefined, 50, 1000)).toBe(50);
    expect(clampLimit(null, 50, 1000)).toBe(50);
    expect(clampLimit('100', 50, 1000)).toBe(50);
    expect(clampLimit(NaN, 50, 1000)).toBe(50);
    expect(clampLimit(Infinity, 50, 1000)).toBe(50);
  });

  it('floors non-integer values and floors fractions', () => {
    expect(clampLimit(3.7, 50, 1000)).toBe(3);
    expect(clampLimit(0.5, 50, 1000)).toBe(1); // <1 floors up to 1
  });

  it('enforces a hard ceiling at `max`', () => {
    expect(clampLimit(1e9, 50, 1000)).toBe(1000);
    expect(clampLimit(1_000_000, 50, 1000)).toBe(1000);
  });

  it('enforces a hard floor of 1', () => {
    expect(clampLimit(0, 50, 1000)).toBe(1);
    expect(clampLimit(-5, 50, 1000)).toBe(1);
  });

  it('passes through values inside the range unchanged', () => {
    expect(clampLimit(100, 50, 1000)).toBe(100);
    expect(clampLimit(1, 50, 1000)).toBe(1);
    expect(clampLimit(1000, 50, 1000)).toBe(1000);
  });
});
