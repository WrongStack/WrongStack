import type { Mode } from '@wrongstack/core/types';
import { useCallback } from 'react';
import type { Action } from '../app-reducer.js';
import { toModeOptions } from '../components/mode-picker.js';

export interface GetModesResult {
  modes: Mode[];
  activeId: string | null;
}

interface UseModePickerOptions {
  dispatch: React.Dispatch<Action>;
  getModes?: (() => Promise<GetModesResult>) | undefined;
}

export function buildModePickerOptions(result: GetModesResult) {
  return toModeOptions(result.modes, result.activeId);
}

export function useModePicker({
  dispatch,
  getModes,
}: UseModePickerOptions): { openModePicker: () => Promise<void> } {
  const openModePicker = useCallback(async (): Promise<void> => {
    if (!getModes) return;
    const result = await getModes();
    const options = buildModePickerOptions(result);
    dispatch({ type: 'modePickerOpen', modes: options });
  }, [dispatch, getModes]);

  return { openModePicker };
}
