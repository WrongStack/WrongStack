import { describe, expect, it } from 'vitest';
import { oklchToHex } from '../src/lib/color';

describe('oklchToHex overflow guard (F2305)', () => {
  it('returns null instead of #NaNNaNNaN when extreme chroma overflows sRGB conversion', () => {
    expect(oklchToHex('oklch(0.5 1e200 180)')).toBeNull();
  });
});
