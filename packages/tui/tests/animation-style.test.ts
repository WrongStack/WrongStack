import { describe, expect, it } from 'vitest';
import {
  ANIMATION_STYLE_DESCS,
  ANIMATION_STYLES,
  type AnimationStyle,
  BREATHE_FRAMES,
  COLOR_TICK_MS,
  CYCLE_INTERVAL_SECONDS,
  CYCLE_ORDER,
  CYCLE_TICK_INTERVAL_MS,
  colorPhaseFromTime,
  DEFAULT_ANIMATION_STYLE,
  DOTS_FRAMES,
  HUE_WHEEL,
  mixHex,
  pulseColor,
  rainbowColor,
  stripTrailingDots,
  styleForCycleTick,
  waveColor,
} from '../src/components/animation-style.js';

/** Parse a #rrggbb hex into [r, g, b] numbers. Helper for color tests. */
function parseRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

describe('animation-style', () => {
  describe('exports', () => {
    it('exposes 6 renderable styles', () => {
      expect(ANIMATION_STYLES).toEqual(['rainbow', 'wave', 'pulse', 'dots', 'breathe', 'static']);
    });

    it('has a description per style', () => {
      for (const s of ANIMATION_STYLES) {
        expect(ANIMATION_STYLE_DESCS[s]).toEqual(expect.any(String));
        expect(ANIMATION_STYLE_DESCS[s]!.length).toBeGreaterThan(0);
      }
    });

    it('default is rainbow', () => {
      expect(DEFAULT_ANIMATION_STYLE).toBe('rainbow');
    });

    it('cycle order excludes rainbow', () => {
      expect(CYCLE_ORDER).not.toContain('rainbow');
      expect(CYCLE_ORDER.length).toBe(ANIMATION_STYLES.length - 1);
    });

    it('hue wheel has 12 catppuccin stops, each a valid hex', () => {
      expect(HUE_WHEEL).toHaveLength(12);
      for (const c of HUE_WHEEL) {
        expect(c).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });

    it('braille + dots frames are non-empty arrays of strings', () => {
      expect(BREATHE_FRAMES.length).toBeGreaterThan(0);
      for (const f of BREATHE_FRAMES) expect(typeof f).toBe('string');
      expect(DOTS_FRAMES.length).toBeGreaterThan(0);
      for (const f of DOTS_FRAMES) expect(typeof f).toBe('string');
    });

    it('cycle timing constants and color tick are positive integers', () => {
      expect(CYCLE_INTERVAL_SECONDS).toBeGreaterThan(0);
      expect(CYCLE_TICK_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
      expect(COLOR_TICK_MS).toBeGreaterThan(0);
      expect(Number.isInteger(COLOR_TICK_MS)).toBe(true);
    });
  });

  describe('colorPhaseFromTime', () => {
    it('returns 0 at elapsed 0', () => {
      expect(colorPhaseFromTime(0)).toBe(0);
    });

    it('returns 0 before the first tick boundary', () => {
      expect(colorPhaseFromTime(COLOR_TICK_MS - 1)).toBe(0);
    });

    it('returns 1 at the first tick boundary', () => {
      expect(colorPhaseFromTime(COLOR_TICK_MS)).toBe(1);
    });

    it('increments monotonically with elapsed time', () => {
      for (let ms = 0; ms < COLOR_TICK_MS * 10; ms += 7) {
        const phase = colorPhaseFromTime(ms);
        expect(phase).toBeGreaterThanOrEqual(0);
        expect(colorPhaseFromTime(ms + 1)).toBeGreaterThanOrEqual(phase);
      }
    });

    it('clamps negative elapsed to 0', () => {
      expect(colorPhaseFromTime(-500)).toBe(0);
    });
  });

  describe('styleForCycleTick', () => {
    it('returns the first style at tick 0', () => {
      expect(styleForCycleTick(0)).toBe(CYCLE_ORDER[0]);
    });

    it('returns the second style after one full interval', () => {
      expect(styleForCycleTick(CYCLE_INTERVAL_SECONDS)).toBe(CYCLE_ORDER[1]);
    });

    it('wraps around at the cycle length', () => {
      const fullCycle = CYCLE_INTERVAL_SECONDS * CYCLE_ORDER.length;
      expect(styleForCycleTick(fullCycle)).toBe(CYCLE_ORDER[0]);
      expect(styleForCycleTick(fullCycle + CYCLE_INTERVAL_SECONDS)).toBe(CYCLE_ORDER[1]);
    });

    it('handles negative ticks defensively (treats as 0)', () => {
      expect(styleForCycleTick(-5)).toBe(CYCLE_ORDER[0]);
    });

    it('only ever returns a member of the cycle order', () => {
      for (let i = 0; i < CYCLE_INTERVAL_SECONDS * CYCLE_ORDER.length * 2; i += 7) {
        const s = styleForCycleTick(i);
        expect((CYCLE_ORDER as readonly string[]).includes(s)).toBe(true);
      }
    });
  });

  describe('mixHex', () => {
    it('returns the first color at t=0', () => {
      expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    });

    it('returns the second color at t=1', () => {
      expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    });

    it('returns ~halfway color at t=0.5', () => {
      expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    });

    it('clamps t outside [0,1]', () => {
      expect(mixHex('#000000', '#ffffff', -1)).toBe('#000000');
      expect(mixHex('#000000', '#ffffff', 2)).toBe('#ffffff');
    });

    it('falls back to the second color on invalid input', () => {
      expect(mixHex('not-a-color', '#ffffff', 0.5)).toBe('#ffffff');
    });
  });

  describe('waveColor', () => {
    it('returns a valid hex for any inputs', () => {
      for (let i = 0; i < 10; i++) {
        for (let phase = 0; phase < 40; phase++) {
          expect(waveColor(i, phase, 10)).toMatch(/^#[0-9a-f]{6}$/i);
        }
      }
    });

    it('handles length 0 without throwing', () => {
      expect(waveColor(0, 0, 0)).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });

  describe('pulseColor', () => {
    it('returns a valid hex for any phase', () => {
      for (let phase = 0; phase < 100; phase++) {
        expect(pulseColor(phase)).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });

    it('is periodic over 16 phases', () => {
      expect(pulseColor(0)).toBe(pulseColor(16));
      expect(pulseColor(0)).toBe(pulseColor(32));
    });
  });

  describe('stripTrailingDots', () => {
    it('removes trailing periods', () => {
      expect(stripTrailingDots('thinking...')).toBe('thinking');
    });

    it('removes trailing spaces and ellipsis', () => {
      expect(stripTrailingDots('thinking … ')).toBe('thinking');
    });

    it('leaves interior punctuation untouched', () => {
      expect(stripTrailingDots('thinking. about. it')).toBe('thinking. about. it');
    });

    it('returns empty string for an all-trailing input', () => {
      expect(stripTrailingDots('...')).toBe('');
    });

    it('returns empty string unchanged', () => {
      expect(stripTrailingDots('')).toBe('');
    });
  });

  describe('AnimationStyle type', () => {
    it('is assignable to the union', () => {
      const s: AnimationStyle = 'wave';
      expect(s).toBe('wave');
    });
  });

  describe('rainbowColor', () => {
    it('returns valid hex for any glyph index and phase', () => {
      for (let i = 0; i < 15; i++) {
        for (let phase = 0; phase < 40; phase++) {
          expect(rainbowColor(i, phase)).toMatch(/^#[0-9a-f]{6}$/i);
        }
      }
    });

    it('starts on the Catppuccin palette stops', () => {
      for (let i = 0; i < HUE_WHEEL.length; i++) {
        expect(rainbowColor(i, 0)).toBe(HUE_WHEEL[i]);
      }
    });

    it('blends only between neighbouring Catppuccin stops', () => {
      expect(rainbowColor(0, 1)).toBe(mixHex(HUE_WHEEL[11]!, HUE_WHEEL[0]!, 0.75));
      expect(rainbowColor(5, 2)).toBe(mixHex(HUE_WHEEL[4]!, HUE_WHEEL[5]!, 0.5));
      expect(rainbowColor(9, 3)).toBe(mixHex(HUE_WHEEL[8]!, HUE_WHEEL[9]!, 0.25));
    });

    it('moves the whole gradient from left to right at a constant speed', () => {
      for (let phase = 0; phase < 48; phase++) {
        for (let i = 0; i < 12; i++) {
          expect(rainbowColor(i + 1, phase + 4)).toBe(rainbowColor(i, phase));
        }
      }
    });

    it('loops seamlessly after one full palette pass', () => {
      for (let i = 0; i < 12; i++) {
        expect(rainbowColor(i, 48)).toBe(rainbowColor(i, 0));
      }
    });

    it('produces pastel tones (not pure primaries)', () => {
      for (let phase = 0; phase < 48; phase++) {
        const [r, g, b] = parseRgb(rainbowColor(3, phase));
        expect(r).toBeGreaterThan(0);
        expect(r).toBeLessThan(255);
        expect(g).toBeGreaterThan(0);
        expect(g).toBeLessThan(255);
        expect(b).toBeGreaterThan(0);
        expect(b).toBeLessThan(255);
      }
    });

    it('is deterministic', () => {
      expect(rainbowColor(4, 7)).toBe(rainbowColor(4, 7));
    });
  });
});
