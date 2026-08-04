/**
 * Color palette registry — the WebUI's "main color" system.
 *
 * Users can pick a palette on top of the light/dark theme toggle. The actual
 * token values live in `index.css` as `:root[data-palette="…"]` /
 * `.dark[data-palette="…"]` blocks (rendering is driven by `hsl(var(--token))`),
 * so this module only describes the palettes for the picker UI: id, i18n
 * label, and the two swatch colors that preview the palette's two brand
 * signals. `applyPalette` toggles the `data-palette` attribute on `<html>`.
 *
 * To add a palette: add a CSS token block in `index.css`, an entry here (in
 * the same order), and an i18n label key in all 7 locale files. The default
 * "signal" palette needs no CSS block — it is the base token set.
 */
export type PaletteId = 'signal' | 'emerald-gold' | 'blue-navy' | 'purple-pink';

export interface PaletteDefinition {
  id: PaletteId;
  /** i18n key for the palette name, e.g. 'settings:general.paletteEmeraldGold'. */
  labelKey: string;
  /** CSS color for the main (primary) swatch stripe — dark-mode value so it reads on both themes. */
  swatch: string;
  /** CSS color for the secondary (brand) swatch stripe. */
  swatchSecondary: string;
}

export const DEFAULT_PALETTE: PaletteId = 'signal';

export const PALETTES: readonly PaletteDefinition[] = [
  {
    id: 'signal',
    labelKey: 'settings:general.paletteSignal',
    swatch: 'hsl(345.9 99% 58.8%)',
    swatchSecondary: 'hsl(37.5 98.4% 50%)',
  },
  {
    id: 'emerald-gold',
    labelKey: 'settings:general.paletteEmeraldGold',
    swatch: 'hsl(152 66% 48%)',
    swatchSecondary: 'hsl(42 96% 54%)',
  },
  {
    id: 'blue-navy',
    labelKey: 'settings:general.paletteBlueNavy',
    swatch: 'hsl(213 90% 60%)',
    swatchSecondary: 'hsl(36 96% 54%)',
  },
  {
    id: 'purple-pink',
    labelKey: 'settings:general.palettePurplePink',
    swatch: 'hsl(263 82% 66%)',
    swatchSecondary: 'hsl(332 94% 62%)',
  },
] as const satisfies readonly PaletteDefinition[];

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === 'string' && PALETTES.some((palette) => palette.id === value);
}

export function getPalette(value: unknown): PaletteDefinition {
  return PALETTES.find((palette) => palette.id === value) ?? PALETTES[0];
}

/** Apply a palette to <html> by setting `data-palette`; removes it for the default. */
export function applyPalette(root: HTMLElement, palette: PaletteId): void {
  if (palette === DEFAULT_PALETTE) {
    root.removeAttribute('data-palette');
  } else {
    root.setAttribute('data-palette', palette);
  }
}
