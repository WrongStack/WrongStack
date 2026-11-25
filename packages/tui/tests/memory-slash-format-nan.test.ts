import { describe, expect, it } from 'vitest';
import { daysAgo, recencyLabel } from '../src/memory-slash-format.js';

describe('memory-slash-format non-finite guards', () => {
  it('returns fallback labels and null for non-finite numbers', () => {
    expect(recencyLabel(3)).toBe('3d ago');
    expect(recencyLabel(Number.NaN)).toBe('—');
    expect(recencyLabel(Number.POSITIVE_INFINITY)).toBe('—');
    expect(daysAgo('2026-01-01T00:00:00.000Z', Number.NaN)).toBeNull();
    expect(daysAgo('2026-01-01T00:00:00.000Z', Number.POSITIVE_INFINITY)).toBeNull();
  });
});
