import type { ConfigStore, ThemePresetId } from '@wrongstack/contracts/types';
import { useCallback } from 'react';
import type { Action } from '../app-reducer.js';
import { getActiveThemeName, setActiveTheme, THEME_OPTIONS, type ThemeName } from '../theme.js';
import { filterThemeOptions } from '../theme-picker-rows.js';

interface UseThemePickerHandlerOptions {
  configStore?: ConfigStore | undefined;
  saveThemePreset?: ((theme: ThemeName) => Promise<void>) | undefined;
  dispatch: React.Dispatch<Action>;
  selectedIndex: number;
  /** Active type-to-filter query — `selectedIndex` indexes the FILTERED list. */
  filter?: string | undefined;
  /** Preset that was live when the picker opened — the undo target. */
  previous?: ThemePresetId | undefined;
}

export function useThemePickerHandler({
  configStore,
  saveThemePreset,
  dispatch,
  selectedIndex,
  filter,
  previous,
}: UseThemePickerHandlerOptions) {
  /**
   * Apply a preset, persist it, and report the outcome.
   *
   * Shared by Enter, undo, and the direct `/theme <preset>` path so all three
   * report success and persistence failure identically. The warn entry below is
   * the only feedback a user gets when a disk write fails, so it must not be
   * duplicated per callsite with subtly different wording.
   */
  const applyPreset = useCallback(
    (presetName: ThemeName, verb: string) => {
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
          text: `Theme preset ${verb} "${presetName}"${
            getActiveThemeName() === presetName
              ? ''
              : ` (fallback applied: ${getActiveThemeName()})`
          }.`,
        },
      });
    },
    [configStore, dispatch, saveThemePreset],
  );

  const onThemePickerEnter = useCallback(() => {
    // `selectedIndex` indexes the FILTERED list, so resolve through the same
    // query the reducer used. Reading THEME_OPTIONS directly would apply the
    // wrong preset whenever a filter is active.
    const preset = filterThemeOptions(THEME_OPTIONS, filter ?? '')[Math.max(0, selectedIndex)];
    const presetName: ThemeName | undefined = preset?.id;
    if (!presetName) return;
    applyPreset(presetName, 'switched to');
    dispatch({ type: 'themePickerClose' });
  }, [applyPreset, dispatch, filter, selectedIndex]);

  /**
   * Swap back to the preset that was live when the picker opened.
   *
   * The picker STAYS OPEN: the swap is instant, so keeping it open lets the
   * user keep browsing — or press undo again — instead of making a mis-click
   * cost two commands to recover from. Swapping `previous` means undo toggles
   * between the two most recent palettes rather than becoming a no-op after
   * the first press.
   */
  const onThemePickerUndo = useCallback(() => {
    if (previous === undefined || previous === getActiveThemeName()) return;
    const current = getActiveThemeName();
    applyPreset(previous, 'restored to');
    dispatch({ type: 'themePickerHint', text: `Undid → ${previous} (was ${current})` });
    // Point the undo target at what we just left, so a second press returns.
    dispatch({ type: 'themePickerSwapPrevious' });
  }, [applyPreset, dispatch, previous]);

  return { onThemePickerEnter, onThemePickerUndo };
}
