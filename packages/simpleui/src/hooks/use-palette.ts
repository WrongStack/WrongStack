import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_PALETTE,
  PALETTE_STORAGE_KEY,
  applyPalette,
  isPaletteId,
  type PaletteId,
} from '../lib/palettes.js';

export interface UsePaletteResult {
  palette: PaletteId;
  /** Replace the current palette. Also persists to localStorage and the DOM. */
  setPalette: (palette: PaletteId) => void;
}

/**
 * Resolve the initial palette without throwing in privacy-restricted browsers.
 * Falls back to the default "signal" palette when storage is unavailable.
 */
function initialPalette(): PaletteId {
  try {
    const stored = localStorage.getItem(PALETTE_STORAGE_KEY);
    return isPaletteId(stored) ? stored : DEFAULT_PALETTE;
  } catch {
    return DEFAULT_PALETTE;
  }
}

/**
 * Owns the color-palette lifecycle: initial resolution, DOM side-effects
 * (`data-palette` attribute on `<html>`), and persistence to `localStorage`.
 *
 * Mirrors `useTheme` in behavioural contract:
 *  - Privacy-restricted browsers (localStorage throws) never crash; they fall
 *    back to `DEFAULT_PALETTE` and skip persistence.
 *  - The DOM attribute is kept in sync on every change, not only on mount.
 *  - Persistence is best-effort: a thrown `setItem` is swallowed so the UI
 *    keeps working even when storage is full or blocked.
 */
export function usePalette(): UsePaletteResult {
  const [palette, setPaletteState] = useState<PaletteId>(initialPalette);

  useEffect(() => {
    applyPalette(document.documentElement, palette);
  }, [palette]);

  const setPalette = useCallback((next: PaletteId) => {
    setPaletteState(next);
    try {
      localStorage.setItem(PALETTE_STORAGE_KEY, next);
    } catch {
      // Palette persistence is best-effort in privacy-restricted browsers.
    }
  }, []);

  return { palette, setPalette };
}
