import type { ConfigStore } from '@wrongstack/core/types';
import { useEffect } from 'react';
import {
  getActiveThemeName,
  RANDOM_THEME_ROTATION_MS,
  setActiveTheme,
  setRandomTheme,
} from '../theme.js';

/**
 * Boot-time theme wiring: applies a configured `themePreset`, or enters random
 * mode when none is configured. Random mode chooses a palette at startup and
 * rotates it every 15 minutes; a later explicit config update stops rotation.
 */
export function useThemeState({ configStore }: { configStore: ConfigStore | undefined }): void {
  useEffect(() => {
    let randomMode = false;
    let rotation: ReturnType<typeof setInterval> | undefined;

    const stopRotation = () => {
      if (rotation !== undefined) {
        clearInterval(rotation);
        rotation = undefined;
      }
    };

    const startRandomMode = () => {
      if (randomMode) return;
      randomMode = true;
      setRandomTheme();
      rotation = setInterval(() => {
        setRandomTheme();
      }, RANDOM_THEME_ROTATION_MS);
    };

    const syncTheme = (preset: string | undefined) => {
      if (!preset) {
        startRandomMode();
        return;
      }

      randomMode = false;
      stopRotation();
      if (preset !== getActiveThemeName()) {
        setActiveTheme(preset);
      }
    };

    // The store is populated before App mounts. An absent store has the same
    // semantics as an unset preset: the TUI owns a temporary random palette.
    syncTheme(configStore?.get().themePreset);
    const unsubscribe = configStore?.watch((next) => {
      syncTheme(next.themePreset);
    });

    return () => {
      stopRotation();
      unsubscribe?.();
    };
  }, [configStore]);
}
