// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCENT_PALETTES,
  DEFAULT_ACCENT_COLOR,
  applyAccentPalette,
  getAccentPalette,
  isAccentColor,
} from '@/lib/accent-colors';

describe('accent-colors', () => {
  const REQUIRED_TOKEN_KEYS = [
    'primary',
    'primaryForeground',
    'accent',
    'accentForeground',
    'ring',
    'running',
  ] as const;

  afterEach(() => {
    // Reset CSS variables on the test root after each call.
    document.documentElement.removeAttribute('style');
  });

  describe('ACCENT_PALETTES contract', () => {
    it('exports a non-empty list of palettes', () => {
      expect(ACCENT_PALETTES.length).toBeGreaterThan(0);
    });

    it('every palette has unique id, labelKey, and full light/dark token sets', () => {
      const ids = new Set<string>();
      const labelKeys = new Set<string>();
      for (const palette of ACCENT_PALETTES) {
        expect(ids.has(palette.id)).toBe(false);
        expect(labelKeys.has(palette.labelKey)).toBe(false);
        ids.add(palette.id);
        labelKeys.add(palette.labelKey);

        for (const mode of ['light', 'dark'] as const) {
          for (const key of REQUIRED_TOKEN_KEYS) {
            const tokens = palette[mode] as Record<string, string>;
            expect(typeof tokens[key]).toBe('string');
            expect(tokens[key].length).toBeGreaterThan(0);
          }
        }
      }
    });

    it('DEFAULT_ACCENT_COLOR points to a real palette', () => {
      expect(isAccentColor(DEFAULT_ACCENT_COLOR)).toBe(true);
      expect(getAccentPalette(DEFAULT_ACCENT_COLOR).id).toBe(DEFAULT_ACCENT_COLOR);
    });
  });

  describe('isAccentColor', () => {
    it('accepts known palette ids', () => {
      for (const palette of ACCENT_PALETTES) {
        expect(isAccentColor(palette.id)).toBe(true);
      }
    });

    it('rejects unknown values', () => {
      expect(isAccentColor('not-a-real-color')).toBe(false);
      expect(isAccentColor(null)).toBe(false);
      expect(isAccentColor(undefined)).toBe(false);
      expect(isAccentColor(123)).toBe(false);
      expect(isAccentColor('')).toBe(false);
    });
  });

  describe('getAccentPalette', () => {
    it('returns the matching palette for a known id', () => {
      const first = ACCENT_PALETTES[0];
      expect(getAccentPalette(first.id).id).toBe(first.id);
    });

    it('falls back to the first palette for unknown values', () => {
      expect(getAccentPalette('nope').id).toBe(ACCENT_PALETTES[0].id);
      expect(getAccentPalette(null).id).toBe(ACCENT_PALETTES[0].id);
      expect(getAccentPalette(undefined).id).toBe(ACCENT_PALETTES[0].id);
    });
  });

  describe('applyAccentPalette', () => {
    function readVars(root: HTMLElement): Record<string, string> {
      const style = root.getAttribute('style') ?? '';
      const map: Record<string, string> = {};
      for (const decl of style.split(';')) {
        const trimmed = decl.trim();
        if (!trimmed) continue;
        const sep = trimmed.indexOf(':');
        if (sep <= 0) continue;
        const name = trimmed.slice(0, sep).trim();
        const value = trimmed.slice(sep + 1).trim();
        map[name] = value;
      }
      return map;
    }

    it('sets all six CSS custom properties on the root for light mode', () => {
      const root = document.documentElement;
      const palette = ACCENT_PALETTES[0];
      applyAccentPalette(root, palette.id, 'light');

      const vars = readVars(root);
      for (const key of REQUIRED_TOKEN_KEYS) {
        const cssVar = key === 'primaryForeground' ? '--primary-foreground' : `--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
        const expected = palette.light[key as keyof typeof palette.light];
        expect(vars[cssVar]).toBe(expected);
      }
    });

    it('sets all six CSS custom properties on the root for dark mode', () => {
      const root = document.documentElement;
      const palette = ACCENT_PALETTES[0];
      applyAccentPalette(root, palette.id, 'dark');

      const vars = readVars(root);
      const expected = palette.dark;
      expect(vars['--primary']).toBe(expected.primary);
      expect(vars['--primary-foreground']).toBe(expected.primaryForeground);
      expect(vars['--accent']).toBe(expected.accent);
      expect(vars['--accent-foreground']).toBe(expected.accentForeground);
      expect(vars['--ring']).toBe(expected.ring);
      expect(vars['--running']).toBe(expected.running);
    });

    it('overwrites previous palette values when called twice', () => {
      const root = document.documentElement;
      const first = ACCENT_PALETTES[0];
      const second = ACCENT_PALETTES[ACCENT_PALETTES.length - 1];

      applyAccentPalette(root, first.id, 'light');
      applyAccentPalette(root, second.id, 'light');

      const vars = readVars(root);
      const expected = second.light;
      expect(vars['--primary']).toBe(expected.primary);
      expect(vars['--running']).toBe(expected.running);
    });
  });
});