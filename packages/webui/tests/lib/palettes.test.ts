// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PALETTE,
  PALETTES,
  applyPalette,
  getPalette,
  isPaletteId,
} from '@/lib/palettes';

describe('palettes', () => {
  afterEach(() => {
    // Reset the palette attribute on the test root after each call.
    document.documentElement.removeAttribute('data-palette');
  });

  describe('PALETTES contract', () => {
    it('exports a non-empty list of palettes', () => {
      expect(PALETTES.length).toBeGreaterThan(0);
    });

    it('every palette has unique kebab-case id, unique labelKey, and two swatch colors', () => {
      const ids = new Set<string>();
      const labelKeys = new Set<string>();
      for (const palette of PALETTES) {
        expect(ids.has(palette.id)).toBe(false);
        expect(labelKeys.has(palette.labelKey)).toBe(false);
        ids.add(palette.id);
        labelKeys.add(palette.labelKey);

        expect(palette.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(palette.labelKey).toMatch(/^settings:general\.palette[A-Za-z]+$/);
        for (const swatch of [palette.swatch, palette.swatchSecondary]) {
          expect(typeof swatch).toBe('string');
          expect(swatch.length).toBeGreaterThan(0);
          expect(swatch.startsWith('hsl(')).toBe(true);
        }
      }
    });

    it('DEFAULT_PALETTE points to a real palette and is the first entry', () => {
      expect(isPaletteId(DEFAULT_PALETTE)).toBe(true);
      expect(getPalette(DEFAULT_PALETTE).id).toBe(DEFAULT_PALETTE);
      expect(PALETTES[0].id).toBe(DEFAULT_PALETTE);
    });

    it('exports at least two alternative palettes besides the default', () => {
      const alternatives = PALETTES.filter((palette) => palette.id !== DEFAULT_PALETTE);
      expect(alternatives.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('isPaletteId', () => {
    it('accepts known palette ids', () => {
      for (const palette of PALETTES) {
        expect(isPaletteId(palette.id)).toBe(true);
      }
    });

    it('rejects unknown values', () => {
      expect(isPaletteId('not-a-real-palette')).toBe(false);
      expect(isPaletteId('cyan')).toBe(false);
      expect(isPaletteId(null)).toBe(false);
      expect(isPaletteId(undefined)).toBe(false);
      expect(isPaletteId(123)).toBe(false);
      expect(isPaletteId('')).toBe(false);
    });
  });

  describe('getPalette', () => {
    it('returns the matching palette for a known id', () => {
      const first = PALETTES[0];
      expect(getPalette(first.id).id).toBe(first.id);
    });

    it('falls back to the default palette for unknown values', () => {
      expect(getPalette('nope').id).toBe(DEFAULT_PALETTE);
      expect(getPalette(null).id).toBe(DEFAULT_PALETTE);
      expect(getPalette(undefined).id).toBe(DEFAULT_PALETTE);
    });
  });

  describe('applyPalette', () => {
    it('sets data-palette on the root for a non-default palette', () => {
      const root = document.documentElement;
      const alternative = PALETTES.find((palette) => palette.id !== DEFAULT_PALETTE);
      expect(alternative).toBeDefined();
      applyPalette(root, alternative!.id);
      expect(root.getAttribute('data-palette')).toBe(alternative!.id);
    });

    it('removes data-palette for the default palette', () => {
      const root = document.documentElement;
      applyPalette(root, 'blue-navy');
      expect(root.getAttribute('data-palette')).toBe('blue-navy');
      applyPalette(root, DEFAULT_PALETTE);
      expect(root.hasAttribute('data-palette')).toBe(false);
    });

    it('overwrites a previous palette when called twice', () => {
      const root = document.documentElement;
      applyPalette(root, 'emerald-gold');
      applyPalette(root, 'purple-pink');
      expect(root.getAttribute('data-palette')).toBe('purple-pink');
    });
  });
});
