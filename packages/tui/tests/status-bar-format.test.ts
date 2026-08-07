import { describe, expect, it } from 'vitest';
import { dialGlyph, sparkline } from '../src/components/status-bar-format.js';

describe('dialGlyph (morphing load ring)', () => {
  it('renders an empty ring at zero load', () => {
    expect(dialGlyph(0)).toBe('○');
    expect(dialGlyph(-1)).toBe('○');
  });

  it('fills the ring as the ratio rises through the quadrant steps', () => {
    expect(dialGlyph(0.01)).toBe('◔');
    expect(dialGlyph(0.25)).toBe('◑');
    expect(dialGlyph(0.5)).toBe('◕');
    expect(dialGlyph(0.75)).toBe('●');
    expect(dialGlyph(1)).toBe('●');
    expect(dialGlyph(2)).toBe('●');
  });
});

describe('sparkline (8-level block trend)', () => {
  it('renders nothing for an empty history or zero width', () => {
    expect(sparkline([], 10)).toBe('');
    expect(sparkline([0.5], 0)).toBe('');
    expect(sparkline([0.5], -3)).toBe('');
  });

  it('maps extremes to the bottom and top block levels', () => {
    expect(sparkline([0], 4)).toBe('▁');
    expect(sparkline([1], 4)).toBe('█');
  });

  it('renders a flat history as a flat line', () => {
    expect(sparkline([0.5, 0.5, 0.5], 3)).toBe('▅▅▅');
  });

  it('quantizes each value onto one of the eight block levels', () => {
    // 0→▁, 0.25→▃, 0.5→▅, 0.75→▆, 1→█ (round(v * 7), indices into ▁▂▃▄▅▆▇█)
    expect(sparkline([0, 0.25, 0.5, 0.75, 1], 5)).toBe('▁▃▅▆█');
  });

  it('draws only the trailing samples when history exceeds the width', () => {
    expect(sparkline([0, 0.25, 0.5, 0.75, 1], 3)).toBe('▅▆█');
  });

  it('does not pad a short history to the requested width', () => {
    expect(sparkline([0.5, 0.75], 8)).toBe('▅▆');
  });

  it('clamps out-of-range ratios before quantizing', () => {
    expect(sparkline([2, -1, 1.5], 3)).toBe('█▁█');
  });
});
