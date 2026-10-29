import { describe, expect, it } from 'vitest';
import {
  accentThemes,
  hslHex,
  paletteColors,
  parseAppearance,
  resolvedContrast,
  resolvedMode,
} from '../src/appearance';

describe('workspace appearance preferences', () => {
  it('restores canonical palettes and migrates the previous desktop choices', () => {
    for (const [legacy, accent] of Object.entries({
      moss: 'moss-rust',
      ocean: 'blue-navy',
      copper: 'rose-copper',
      rose: 'purple-pink',
    }))
      expect(parseAppearance(JSON.stringify({ mode: 'light', accent: legacy }))).toEqual({
        mode: 'light',
        accent,
        contrast: 'system',
      });
    for (const raw of [null, undefined, '{', 'null', '[]', '"dark"'])
      expect(parseAppearance(raw)).toEqual({
        mode: 'system',
        accent: 'blue-navy',
        contrast: 'system',
      });
    expect(parseAppearance('{"mode":"bright","accent":"purple-pink"}')).toEqual({
      mode: 'system',
      accent: 'purple-pink',
      contrast: 'system',
    });
    expect(parseAppearance('{"mode":"dark","accent":"url(secret)"}')).toEqual({
      mode: 'dark',
      accent: 'blue-navy',
      contrast: 'system',
    });
    for (const theme of accentThemes)
      expect(parseAppearance(JSON.stringify({ mode: 'dark', accent: theme.id }))).toEqual({
        mode: 'dark',
        accent: theme.id,
        contrast: 'system',
      });
  });
  it('follows the OS only in system mode', () => {
    expect(resolvedMode({ mode: 'system', accent: 'signal', contrast: 'system' }, true)).toBe(
      'dark',
    );
    expect(resolvedMode({ mode: 'system', accent: 'signal', contrast: 'system' }, false)).toBe(
      'light',
    );
    expect(resolvedMode({ mode: 'light', accent: 'signal', contrast: 'system' }, true)).toBe(
      'light',
    );
    expect(resolvedMode({ mode: 'dark', accent: 'signal', contrast: 'system' }, false)).toBe(
      'dark',
    );
  });
  it('resolves terminal colors and preserves the same neutral surfaces for every pair', () => {
    expect(hslHex('0 0% 100%')).toBe('#ffffff');
    expect(hslHex('120 100% 50%')).toBe('#00ff00');
    for (const mode of ['light', 'dark'] as const) {
      const colors = accentThemes.map((theme) =>
        paletteColors({ mode, accent: theme.id, contrast: 'system' }, false),
      );
      expect(new Set(colors.map((c) => c.background)).size).toBe(1);
      expect(new Set(colors.map((c) => c.primary)).size).toBe(accentThemes.length);
      for (const color of colors)
        for (const value of Object.values(color)) expect(value).toMatch(/^#[a-f0-9]{6}$/);
    }
  });
  it('keeps a contrast choice and follows the OS only for system', () => {
    expect(parseAppearance('{"mode":"dark","accent":"signal","contrast":"more"}').contrast).toBe(
      'more',
    );
    expect(parseAppearance('{"contrast":"maximum"}').contrast).toBe('system');
    const base = { mode: 'light', accent: 'signal' } as const;
    expect(resolvedContrast({ ...base, contrast: 'system' }, true)).toBe('more');
    expect(resolvedContrast({ ...base, contrast: 'system' }, false)).toBe('standard');
    expect(resolvedContrast({ ...base, contrast: 'standard' }, true)).toBe('standard');
    expect(resolvedContrast({ ...base, contrast: 'more' }, false)).toBe('more');
  });
});
