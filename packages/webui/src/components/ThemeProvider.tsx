import {
  DEFAULT_PALETTE,
  PALETTE_STORAGE_KEY,
  applyPalette,
  isPaletteId,
  readStoredPalette,
  type PaletteId,
} from '@/lib/palettes';
import { useConfigStore } from '@/stores';
import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme | undefined;
  storageKey?: string | undefined;
  defaultPalette?: PaletteId | undefined;
  paletteStorageKey?: string | undefined;
}

interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  palette: PaletteId;
  setPalette: (palette: PaletteId) => void;
}

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined);

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'wrongstack-theme',
  defaultPalette = DEFAULT_PALETTE,
  paletteStorageKey = PALETTE_STORAGE_KEY,
}: ThemeProviderProps) {
  const setStoreTheme = useConfigStore((s) => s.setTheme);
  const setStorePalette = useConfigStore((s) => s.setPalette);
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem(storageKey) as Theme) || defaultTheme;
    }
    return defaultTheme;
  });
  const [palette, setPalette] = useState<PaletteId>(() =>
    readStoredPalette(paletteStorageKey, defaultPalette),
  );

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }
  }, [theme]);

  // Mirror the chosen palette onto <html> as `data-palette="…"`. The token
  // values live in index.css (`:root[data-palette=…]` / `.dark[data-palette=…]`
  // blocks); removing the attribute restores the default "signal" palette.
  useEffect(() => {
    applyPalette(window.document.documentElement, palette);
  }, [palette]);

  // Keep open tabs in sync: when another tab writes the palette key, adopt it
  // so the DOM attribute and config store don't drift apart.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== paletteStorageKey) return;
      if (isPaletteId(event.newValue)) {
        setPalette(event.newValue);
        setStorePalette(event.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [paletteStorageKey, setStorePalette]);

  const value = {
    theme,
    setTheme: (newTheme: Theme) => {
      localStorage.setItem(storageKey, newTheme);
      setTheme(newTheme);
      setStoreTheme(newTheme);
    },
    palette,
    setPalette: (newPalette: PaletteId) => {
      try {
        localStorage.setItem(paletteStorageKey, newPalette);
      } catch {
        // Storage can be unavailable (private mode, quota); the in-memory
        // state + config store still apply the palette for this session.
      }
      setPalette(newPalette);
      setStorePalette(newPalette);
    },
  };

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
