import { useCallback } from 'react';
import type { ConfigStore } from '@wrongstack/core/types';
import type { Action } from '../app-reducer.js';
import {
  getActiveThemeName,
  setActiveTheme,
  THEME_OPTIONS,
  type ThemeName,
} from '../theme.js';

interface UseThemePickerHandlerOptions {
  configStore?: ConfigStore | undefined;
  saveThemePreset?: ((theme: ThemeName) => Promise<void>) | undefined;
  dispatch: React.Dispatch<Action>;
  selectedIndex: number;
}

export function useThemePickerHandler({
  configStore,
  saveThemePreset,
  dispatch,
  selectedIndex,
}: UseThemePickerHandlerOptions) {
  const onThemePickerEnter = useCallback(() => {
    const preset = THEME_OPTIONS[Math.max(0, selectedIndex)];
    const presetName: ThemeName | undefined = preset?.id;
    if (!presetName) return;
    setActiveTheme(presetName);
    try {
      configStore?.update({ themePreset: presetName });
      void saveThemePreset?.(presetName).catch((err) => {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'warn',
            text: `Theme applied in-memory but could not persist to disk: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      });
    } catch {
      /* best-effort */
    }
    dispatch({
      type: 'addEntry',
      entry: {
        kind: 'info',
        text: `Theme preset switched to "${presetName}"${
          getActiveThemeName() === presetName ? '' : ` (fallback applied: ${getActiveThemeName()})`
        }.`,
      },
    });
    dispatch({ type: 'themePickerClose' });
  }, [configStore, dispatch, saveThemePreset, selectedIndex]);

  return { onThemePickerEnter };
}
