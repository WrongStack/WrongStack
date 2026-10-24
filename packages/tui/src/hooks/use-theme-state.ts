import type { ConfigStore } from '@wrongstack/contracts/types';
import { THEME_RANDOM_ID } from '@wrongstack/contracts/types';
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
      // The `random` sentinel and an ABSENT value both mean rotation, but they
      // are different states: absent is "nothing was ever configured", while
      // `random` is "the user explicitly asked to rotate". Treating them alike
      // meant pressing Enter on any palette silently pinned it — there was no
      // way back to rotation. The sentinel is what makes the choice explicit.
      if (!preset || preset === THEME_RANDOM_ID) {
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
