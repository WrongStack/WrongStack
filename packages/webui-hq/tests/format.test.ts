/**
 * Unit tests for the shared HQ number/time formatting helpers
 * (`packages/webui-hq/src/lib/format.ts`), consumed by the Cost and Trends
 * views for their token badges.
 */
import { describe, expect, it } from 'vitest';
import { formatCount } from '../src/lib/format.js';

describe('formatCount', () => {
  it('formats plain, kilo and mega magnitudes', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1_000)).toBe('1.0k');
    expect(formatCount(12_345)).toBe('12.3k');
    expect(formatCount(1_000_000)).toBe('1.0M');
    expect(formatCount(1_234_567)).toBe('1.2M');
  });

  it('rejects non-finite input as zero', () => {
    expect(formatCount(Number.NaN)).toBe('0');
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('0');
    expect(formatCount(Number.NEGATIVE_INFINITY)).toBe('0');
  });

  // Regression (elite bug-hunter round 2026-09-05-hq-formatcount-carry): the
  // unit used to be picked from the raw magnitude while the mantissa was
  // rounded afterwards, so every count whose kilo-mantissa rounded up to 1000
  // rendered as "1000.0k" — one full step past its own unit, and smaller than
  // the very next value's "1.0M".
  it('carries a rounded-up 1000.0 mantissa into the next unit', () => {
    expect(formatCount(999_999)).toBe('1.0M');
    expect(formatCount(999_995)).toBe('1.0M');
    expect(formatCount(999_950)).toBe('1.0M');
    expect(formatCount(999_999.6)).toBe('1.0M');
  });

  it('carries for negative counts too', () => {
    expect(formatCount(-999_999)).toBe('-1.0M');
    expect(formatCount(-999_950)).toBe('-1.0M');
  });

  it('keeps the mantissa below its unit across the whole carry band', () => {
    // Swept in one pass so the assertion cost stays out of the suite's budget.
    const offenders: string[] = [];
    for (let value = 999_000; value <= 1_001_000; value += 1) {
      const out = formatCount(value);
      // A one-decimal compact string must never show 1000.0 for the "k" unit.
      if (out === '1000.0k' || out === '-1000.0k') offenders.push(`${value}→${out}`);
    }
    expect(offenders).toEqual([]);
  });

  it('stays monotonic across the carry point', () => {
    const magnitude = (label: string) =>
      Number.parseFloat(label) * (label.endsWith('M') ? 1_000_000 : 1_000);
    expect(magnitude(formatCount(999_949))).toBeLessThan(magnitude(formatCount(999_950)));
    expect(magnitude(formatCount(999_999))).toBeLessThanOrEqual(magnitude(formatCount(1_000_000)));
  });

  it('does not carry a mantissa that only just stays under 1000', () => {
    expect(formatCount(999_949)).toBe('999.9k');
    expect(formatCount(-999_949)).toBe('-999.9k');
    expect(formatCount(-12_345)).toBe('-12.3k');
  });
});
