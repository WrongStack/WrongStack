import { useCallback, useEffect, useState } from 'react';

const THEME_STORAGE_KEY = 'wrongstack.simpleui.theme';

export type Theme = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'system' || saved === 'light' || saved === 'dark') return saved;
    return 'system';
  } catch {
    return 'system';
  }
}

function resolvedFromOs(): ResolvedTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export interface UseThemeResult {
  /** The user's chosen mode, including 'system' (follow the OS). */
  theme: Theme;
  /** The theme actually applied — 'system' resolved against the OS setting. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  /** Cycle system → light → dark → system. */
  toggleTheme: () => void;
}

/**
 * The theme is persisted as the user's CHOICE ('system' | 'light' | 'dark');
 * what gets applied to the DOM and handed to consumers is always the
 * RESOLVED theme — 'system' tracked live against prefers-color-scheme.
 * A missing matchMedia API (jsdom, embedded webviews) degrades to 'dark'.
 */
export function useTheme(): UseThemeResult {
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [resolved, setResolved] = useState<ResolvedTheme>(resolvedFromOs);

  // While following the OS, track prefers-color-scheme changes live so the
  // UI flips the moment the OS does. matchMedia can be missing entirely
  // (jsdom, locked-down webviews) — degrade to the boot-time resolution
  // instead of throwing mid-effect.
  useEffect(() => {
    if (theme !== 'system') return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia('(prefers-color-scheme: light)');
    } catch {
      return;
    }
    const onChange = () => setResolved(mq.matches ? 'light' : 'dark');
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  // Mirror the effective theme onto the document (CSS tokens switch on
  // data-theme; color-scheme keeps form controls native) and persist the
  // choice. Persistence is best-effort: privacy-restricted browsers throw
  // on localStorage access and the theme still works in-memory.
  useEffect(() => {
    const applied = theme === 'system' ? resolved : theme;
    document.documentElement.dataset.theme = applied;
    document.documentElement.style.colorScheme = applied;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Theme persistence is best-effort in privacy-restricted browsers.
    }
  }, [theme, resolved]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) =>
      current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system',
    );
  }, []);

  return { theme, resolvedTheme: theme === 'system' ? resolved : theme, setTheme, toggleTheme };
}
