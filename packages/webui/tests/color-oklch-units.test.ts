import { describe, expect, it } from 'vitest';
import { oklchToHex } from '../src/lib/color.js';

describe('oklchToHex strict component unit validation (F1876)', () => {
  it('rejects invalid CSS units in L and C components', () => {
    expect(oklchToHex('oklch(0.6px 0.15 240)')).toBeNull();
    expect(oklchToHex('oklch(0.6 0.15foo 240)')).toBeNull();
    expect(oklchToHex('oklch(60%px 0.15 240)')).toBeNull();
    expect(oklchToHex('oklch(0.6 50%bar 240)')).toBeNull();
  });

  it('converts valid OKLCH values with numbers and percentages', () => {
    expect(oklchToHex('oklch(0.6 0.15 240)')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(oklchToHex('oklch(60% 50% 240deg)')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(oklchToHex('oklch(0.5 0.2 0.5turn / 0.8)')).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
