'use client';

import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
export const PALETTES = ['sage', 'ocean', 'amber', 'violet'] as const;
export type Palette = (typeof PALETTES)[number];

export const THEME_KEY = 'wrongstack.vibeui.theme';
export const PALETTE_KEY = 'wrongstack.vibeui.palette';

/** Stored appearance, falling back to dark + sage for anything unrecognised. */
export function readAppearance(stored: { theme: string | null; palette: string | null }): {
  theme: Theme;
  palette: Palette;
} {
  return {
    theme: stored.theme === 'light' ? 'light' : 'dark',
    palette: (PALETTES as readonly string[]).includes(stored.palette ?? '')
      ? (stored.palette as Palette)
      : 'sage',
  };
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Optional preference. */
  }
}

/**
 * Theme and palette: restored from localStorage after mount (the static export
 * renders the dark/sage default first), mirrored onto `<html data-theme/palette>`,
 * and persisted on change.
 */
export function useAppearance() {
  const [theme, setTheme] = useState<string>('dark');
  const [palette, setPalette] = useState<string>('sage');
  useEffect(() => {
    try {
      const saved = readAppearance({
        theme: localStorage.getItem(THEME_KEY),
        palette: localStorage.getItem(PALETTE_KEY),
      });
      setTheme(saved.theme);
      setPalette(saved.palette);
    } catch {
      /* Default theme. */
    }
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    persist(THEME_KEY, theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.palette = palette;
    persist(PALETTE_KEY, palette);
  }, [palette]);
  const toggleTheme = () => setTheme((value) => (value === 'dark' ? 'light' : 'dark'));
  return { theme, palette, setPalette, toggleTheme };
}
