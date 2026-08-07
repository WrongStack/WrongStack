import { describe, expect, it } from 'vitest';
import {
  normalizeTokenSavingTier,
  resolveTokenSavingTier,
  type TokenSavingTier,
} from '../../src/types/config.js';

describe('normalizeTokenSavingTier', () => {
  describe('boolean input (backward compatibility)', () => {
    it('returns "off" for undefined', () => {
      expect(normalizeTokenSavingTier(undefined)).toBe('off');
    });

    it('returns "off" for false', () => {
      expect(normalizeTokenSavingTier(false)).toBe('off');
    });

    it('returns "medium" for true', () => {
      expect(normalizeTokenSavingTier(true)).toBe('medium');
    });
  });

  describe('string input (tier values)', () => {
    it('returns "off" for "off"', () => {
      expect(normalizeTokenSavingTier('off')).toBe('off');
    });

    it('returns "minimal" for "minimal"', () => {
      expect(normalizeTokenSavingTier('minimal')).toBe('minimal');
    });

    it('returns "light" for "light"', () => {
      expect(normalizeTokenSavingTier('light')).toBe('light');
    });

    it('returns "medium" for "medium"', () => {
      expect(normalizeTokenSavingTier('medium')).toBe('medium');
    });

    it('returns "aggressive" for "aggressive"', () => {
      expect(normalizeTokenSavingTier('aggressive')).toBe('aggressive');
    });
  });

  describe('invalid string input → "off"', () => {
    it('returns "off" for unknown tier string', () => {
      expect(normalizeTokenSavingTier('tiny')).toBe('off');
      expect(normalizeTokenSavingTier('MAX')).toBe('off');
      expect(normalizeTokenSavingTier('')).toBe('off');
    });

    it('returns "off" for random garbage', () => {
      expect(normalizeTokenSavingTier('foobar' as TokenSavingTier)).toBe('off');
    });
  });

  describe('return type is always TokenSavingTier', () => {
    it('all valid inputs produce valid TokenSavingTier values', () => {
      const tiers: TokenSavingTier[] = ['off', 'minimal', 'light', 'medium', 'aggressive'];
      for (const t of tiers) {
        expect(normalizeTokenSavingTier(t)).toBe(t);
      }
      // Boolean inputs
      expect(normalizeTokenSavingTier(true)).toBe('medium');
      expect(normalizeTokenSavingTier(false)).toBe('off');
      expect(normalizeTokenSavingTier(undefined)).toBe('off');
    });
  });

  describe("'auto' uses a bounded baseline for non-prompt consumers", () => {
    it("normalizeTokenSavingTier('auto') → 'medium'", () => {
      expect(normalizeTokenSavingTier('auto')).toBe('medium');
    });
  });
});

describe('resolveTokenSavingTier (window-based auto-tier for the prompt)', () => {
  it("expands 'auto' from the context window (modern thresholds)", () => {
    expect(resolveTokenSavingTier('auto', 8_000)).toBe('medium'); // <32k
    expect(resolveTokenSavingTier('auto', 31_999)).toBe('medium');
    expect(resolveTokenSavingTier('auto', 32_000)).toBe('light'); // <128k
    expect(resolveTokenSavingTier('auto', 96_000)).toBe('light');
    expect(resolveTokenSavingTier('auto', 127_999)).toBe('light');
    expect(resolveTokenSavingTier('auto', 128_000)).toBe('minimal'); // ≥128k
    expect(resolveTokenSavingTier('auto', 200_000)).toBe('minimal');
    expect(resolveTokenSavingTier('auto', 1_000_000)).toBe('minimal');
  });

  it("'auto' with an unknown/zero window → 'off' (never guess a lean prompt)", () => {
    expect(resolveTokenSavingTier('auto', undefined)).toBe('off');
    expect(resolveTokenSavingTier('auto', 0)).toBe('off');
    expect(resolveTokenSavingTier('auto', Number.NaN)).toBe('off');
  });

  it('respects explicit concrete tiers verbatim, regardless of window', () => {
    expect(resolveTokenSavingTier('off', 8_000)).toBe('off');
    expect(resolveTokenSavingTier('medium', 1_000_000)).toBe('medium');
    expect(resolveTokenSavingTier('aggressive', 200_000)).toBe('aggressive');
    expect(resolveTokenSavingTier(true, 8_000)).toBe('medium'); // boolean back-compat
    expect(resolveTokenSavingTier(undefined, 8_000)).toBe('off');
  });
});
