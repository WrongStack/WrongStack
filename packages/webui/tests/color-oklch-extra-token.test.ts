import { describe, expect, it } from 'vitest';
import { oklchToHex } from '../src/lib/color';

describe('oklchToHex (F2194)', () => {
  it('rejects oklch strings with extra unexpected coordinate tokens', () => {
    expect(oklchToHex('oklch(0.5 0.1 180 bogus)')).toBeNull();
    expect(oklchToHex('oklch(0.5 0.1 180)')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
