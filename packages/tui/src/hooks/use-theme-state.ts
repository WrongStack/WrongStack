import type { ConfigStore } from '@wrongstack/core/types';
import { useEffect } from 'react';
import { getActiveThemeName, setActiveTheme } from '../theme.js';

/**
 * Boot-time theme wiring: reads `config.themePreset` once on mount, applies it
 * via `setActiveTheme()`, and subscribes to the live `ConfigStore` so any
 * in-session update (e.g. from the REPL or a future hot-reload) is mirrored
 * into the visible palette immediately.
 *
 * Falls back to the current preset (catppuccin at first mount) if the config
 * has no `themePreset` set — that's the legacy behaviour for users without an
 * explicit choice, and it makes the picker UI immediately meaningful on first
 * run because the active row is highlighted.
 */
export function useThemeState({ configStore }: { configStore: ConfigStore | undefined }): void {
  useEffect(() => {
    if (!configStore) return;
    // Initial load — the store is already populated by the time App mounts.
    const initial = configStore.get().themePreset;
    if (initial && initial !== getActiveThemeName()) {
      setActiveTheme(initial);
    }
    // Subscribe to subsequent writes (CLI REPL / future settings UI).
    const unsubscribe = configStore.watch((next) => {
      const nextName = next.themePreset;
      if (nextName && nextName !== getActiveThemeName()) {
        setActiveTheme(nextName);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [configStore]);
}
