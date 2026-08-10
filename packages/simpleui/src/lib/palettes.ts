/**
 * Color palette registry — SimpleUI's "main color" system.
 *
 * Users can pick a palette on top of the light/dark theme toggle. The token
 * values live in `styles.css` as `:root[data-palette="…"]` /
 * `:root[data-palette="…"][data-theme="light"]` blocks (rendering is driven
 * by `var(--accent)` etc.), so this module only describes the palettes for
 * the picker UI: id, display name, and two swatch colors that preview the
 * palette's two brand signals. `applyPalette` toggles the `data-palette`
 * attribute on `<html>`.
 *
 * Mirrors the WebUI's `packages/webui/src/lib/palettes.ts` 1:1 in palette
 * ids, swatch colors, and storage key, but uses plain display-name strings
 * instead of i18n keys (SimpleUI has no i18n layer).
 *
 * To add a palette: add a CSS token block in `styles.css`, an entry here (in
 * the same order). The default "signal" palette needs no CSS block — it is
 * the base token set defined in `:root`.
 */
export type PaletteId =
  | 'signal'
  | 'emerald-gold'
  | 'blue-navy'
  | 'purple-pink'
  | 'cyan-teal'
  | 'rose-copper'
  | 'indigo-amber'
  | 'sage-sand'
  | 'slate-violet'
  | 'coral-mint'
  | 'arctic-ember'
  | 'moss-rust';

export interface PaletteDefinition {
  id: PaletteId;
  /** Human-readable palette name shown in the picker. */
  label: string;
  /** CSS color for the main (primary) swatch stripe — dark-mode value so it reads on both themes. */
  swatch: string;
  /** CSS color for the secondary (brand) swatch stripe. */
  swatchSecondary: string;
}

export const DEFAULT_PALETTE: PaletteId = 'signal';

/** localStorage key — kept distinct from the theme key but matches the WebUI
 *  key so a future cross-surface sync could adopt either surface's choice. */
export const PALETTE_STORAGE_KEY = 'wrongstack.simpleui.palette';

export const PALETTES: readonly PaletteDefinition[] = [
  {
    id: 'signal',
    label: 'Signal',
    swatch: 'hsl(345.9 99% 58.8%)',
    swatchSecondary: 'hsl(37.5 98.4% 50%)',
  },
  {
    id: 'emerald-gold',
    label: 'Emerald Gold',
    swatch: 'hsl(152 66% 48%)',
    swatchSecondary: 'hsl(42 96% 54%)',
  },
  {
    id: 'blue-navy',
    label: 'Blue Navy',
    swatch: 'hsl(213 90% 60%)',
    swatchSecondary: 'hsl(36 96% 54%)',
  },
  {
    id: 'purple-pink',
    label: 'Purple Pink',
    swatch: 'hsl(263 82% 66%)',
    swatchSecondary: 'hsl(332 94% 62%)',
  },
  {
    id: 'cyan-teal',
    label: 'Cyan Teal',
    swatch: 'hsl(180 76% 46%)',
    swatchSecondary: 'hsl(36 96% 54%)',
  },
  {
    id: 'rose-copper',
    label: 'Rose Copper',
    swatch: 'hsl(14 82% 56%)',
    swatchSecondary: 'hsl(34 96% 54%)',
  },
  {
    id: 'indigo-amber',
    label: 'Indigo Amber',
    swatch: 'hsl(233 74% 58%)',
    swatchSecondary: 'hsl(38 96% 54%)',
  },
  {
    id: 'sage-sand',
    label: 'Sage Sand',
    swatch: 'hsl(130 28% 55%)',
    swatchSecondary: 'hsl(36 55% 72%)',
  },
  {
    id: 'slate-violet',
    label: 'Slate Violet',
    swatch: 'hsl(248 50% 55%)',
    swatchSecondary: 'hsl(285 52% 62%)',
  },
  {
    id: 'coral-mint',
    label: 'Coral Mint',
    swatch: 'hsl(12 85% 62%)',
    swatchSecondary: 'hsl(162 55% 55%)',
  },
  {
    id: 'arctic-ember',
    label: 'Arctic Ember',
    swatch: 'hsl(195 85% 58%)',
    swatchSecondary: 'hsl(14 85% 55%)',
  },
  {
    id: 'moss-rust',
    label: 'Moss Rust',
    swatch: 'hsl(100 45% 38%)',
    swatchSecondary: 'hsl(18 70% 48%)',
  },
] as const satisfies readonly PaletteDefinition[];

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === 'string' && PALETTES.some((palette) => palette.id === value);
}

export function getPalette(value: unknown): PaletteDefinition {
  return PALETTES.find((palette) => palette.id === value) ?? PALETTES[0];
}

/** Guarded read of a persisted palette id; invalid/missing/blocked storage
 *  falls back to `fallback`. */
export function readStoredPalette(storageKey: string, fallback: PaletteId): PaletteId {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(storageKey);
    return isPaletteId(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

/** Apply a palette to <html> by setting `data-palette`; removes it for the default. */
export function applyPalette(root: HTMLElement, palette: PaletteId): void {
  if (palette === DEFAULT_PALETTE) {
    root.removeAttribute('data-palette');
  } else {
    root.setAttribute('data-palette', palette);
  }
}
