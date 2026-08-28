import { useEffect } from 'react';
import type { StatuslineItem } from '../components/statusline-picker.js';

export function statuslineHiddenDiffers(
  hookHidden: readonly StatuslineItem[],
  pickerHidden: readonly StatuslineItem[],
): boolean {
  const currentHidden = new Set<string>(hookHidden);
  const pickerHiddenSet = new Set<string>(pickerHidden);
  return (
    currentHidden.size !== pickerHiddenSet.size ||
    pickerHidden.some((item) => !currentHidden.has(item)) ||
    hookHidden.some((item) => !pickerHiddenSet.has(item))
  );
}

interface UseStatuslineHiddenSyncOptions {
  pickerOpen: boolean;
  pickerHidden: readonly StatuslineItem[];
  hiddenItems: readonly StatuslineItem[];
  setHiddenItems: (items: StatuslineItem[]) => void;
}

/**
 * Mirrors reducer-owned statusline hidden-item changes back into the
 * statusline state hook so the visible status bar updates immediately.
 */
export function useStatuslineHiddenSync({
  pickerOpen,
  pickerHidden,
  hiddenItems,
  setHiddenItems,
}: UseStatuslineHiddenSyncOptions): void {
  useEffect(() => {
    if (!pickerOpen) return;
    if (statuslineHiddenDiffers(hiddenItems, pickerHidden)) {
      setHiddenItems([...pickerHidden]);
    }
  }, [pickerHidden, pickerOpen, setHiddenItems, hiddenItems]);
}
