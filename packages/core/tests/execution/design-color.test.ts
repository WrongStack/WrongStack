import { describe, expect, it } from 'vitest';
import {
  colorToHex,
  isColorToken,
  oklchToHex,
  parseOklch,
} from '../../src/execution/design-color.js';

describe('design-color — OKLCH conversion', () => {
  it('parses oklch components (percent + bare + alpha)', () => {
    expect(parseOklch('oklch(62% 0.17 145)')).toEqual([0.62, 0.17, 145, 1]);
    expect(parseOklch('oklch(0.62 0.17 145)')).toEqual([0.62, 0.17, 145, 1]);
    const a = parseOklch('oklch(62% 0.17 145 / 0.5)');
    expect(a?.[3]).toBe(0.5);
    expect(parseOklch('#fff')).toBeNull();
  });

  it('scales chroma percentage by the CSS Color 4 reference (100% → 0.4)', () => {
    // Chroma `50%` must parse to 0.20, not 0.50 — L & alpha stay 100% → 1.0.
    expect(parseOklch('oklch(62% 50% 145)')).toEqual([0.62, 0.2, 145, 1]);
    // A percent-chroma token must convert identically to its bare-number twin.
    expect(oklchToHex('oklch(62.79% 64.43% 29.23)')).toBe(oklchToHex('oklch(62.79% 0.2577 29.23)'));
  });

  it('converts achromatic endpoints exactly', () => {
    expect(oklchToHex('oklch(0% 0 0)')).toBe('#000000');
    expect(oklchToHex('oklch(100% 0 0)')).toBe('#ffffff');
  });

  it('converts sRGB primaries within tolerance', () => {
    // sRGB red ≈ oklch(0.6279 0.2577 29.23)
    expect(oklchToHex('oklch(62.79% 0.2577 29.23)')).toBe('#ff0000');
    // sRGB green ≈ oklch(0.8664 0.2948 142.5)
    expect(oklchToHex('oklch(86.64% 0.2948 142.5)')).toBe('#00ff00');
    // sRGB blue ≈ oklch(0.452 0.3132 264.05)
    expect(oklchToHex('oklch(45.2% 0.3132 264.05)')).toBe('#0000ff');
  });

  it('emits alpha hex when alpha < 1', () => {
    expect(oklchToHex('oklch(0% 0 0 / 0.5)')).toBe('#00000080');
  });

  it('normalizes hex + oklch via colorToHex; passes through hex', () => {
    expect(colorToHex('#FFF')).toBe('#ffffff');
    expect(colorToHex('#ABCDEF')).toBe('#abcdef');
    expect(colorToHex('oklch(100% 0 0)')).toBe('#ffffff');
    expect(colorToHex('Inter, sans-serif')).toBeNull();
  });

  it('isColorToken distinguishes colors from non-colors', () => {
    expect(isColorToken('oklch(62% 0.17 145)')).toBe(true);
    expect(isColorToken('#0a0a0a')).toBe(true);
    expect(isColorToken('1.25rem')).toBe(false);
    expect(isColorToken('Inter, system-ui, sans-serif')).toBe(false);
  });
});
