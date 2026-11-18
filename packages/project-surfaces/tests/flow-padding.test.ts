import { describe, expect, it } from 'vitest';
import { fitPadding } from '../src/flow-padding.js';

describe('fitPadding', () => {
  it('keeps React Flow 12 framing as a React Flow 13 per-side percentage', () => {
    // v12 fitted the content into 1 / (1 + p) of the viewport; v13 pads each
    // side by the returned share, so 2 × side must equal p / (1 + p).
    for (const fraction of [0.1, 0.12, 0.15, 0.18, 0.2, 0.24, 0.45]) {
      const side = Number.parseFloat(fitPadding(fraction)) / 100;
      // Rounded to a tenth of a percent per side: at most 0.001 off in total.
      expect(Math.abs(side * 2 - fraction / (1 + fraction))).toBeLessThanOrEqual(0.001);
    }
  });

  it('returns a unit string, never a bare number React Flow 13 would read as pixels', () => {
    expect(fitPadding(0.15)).toBe('6.5%');
    expect(fitPadding(0.25)).toBe('10%');
  });
});
