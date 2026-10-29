import {
  type BrandPaletteId,
  brandDefaultPalette,
  brandNeutrals,
  brandPalettes,
} from './brand-palettes';

export const appearanceModes = ['system', 'light', 'dark'] as const;
/** System follows the OS "more contrast" preference; "more" forces stronger text and borders. */
export const contrastModes = ['system', 'standard', 'more'] as const;
export const accentThemes = brandPalettes;
export interface Appearance {
  mode: (typeof appearanceModes)[number];
  accent: BrandPaletteId;
  contrast: (typeof contrastModes)[number];
}
export const defaultAppearance: Appearance = {
  mode: 'system',
  accent: brandDefaultPalette,
  contrast: 'system',
};
const legacyPalettes: Record<string, string> = {
  moss: 'moss-rust',
  ocean: 'blue-navy',
  copper: 'rose-copper',
  rose: 'purple-pink',
};
export function parseAppearance(raw: string | null | undefined): Appearance {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (!value || typeof value !== 'object') return defaultAppearance;
    const candidate = value as Record<string, unknown>;
    const accent =
      typeof candidate['accent'] === 'string'
        ? (legacyPalettes[candidate['accent']] ?? candidate['accent'])
        : undefined;
    return {
      mode: appearanceModes.find((mode) => mode === candidate['mode']) ?? defaultAppearance.mode,
      accent: accentThemes.find((theme) => theme.id === accent)?.id ?? defaultAppearance.accent,
      contrast:
        contrastModes.find((mode) => mode === candidate['contrast']) ?? defaultAppearance.contrast,
    };
  } catch {
    return defaultAppearance;
  }
}
export function resolvedContrast(appearance: Appearance, systemMore: boolean): 'standard' | 'more' {
  return appearance.contrast === 'system'
    ? systemMore
      ? 'more'
      : 'standard'
    : appearance.contrast;
}
export function resolvedMode(appearance: Appearance, systemDark: boolean): 'dark' | 'light' {
  return appearance.mode === 'system' ? (systemDark ? 'dark' : 'light') : appearance.mode;
}
/** Xterm accepts concrete CSS colors; resolve canonical HSL triples without DOM access. */
export function hslHex(triple: string): string {
  const [hue = 0, saturation = 0, lightness = 0] = triple.split(/\s+/).map(Number.parseFloat);
  const s = saturation / 100,
    l = lightness / 100;
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (
    '#' + [channel(0), channel(8), channel(4)].map((v) => v.toString(16).padStart(2, '0')).join('')
  );
}
function luminance(hex: string) {
  const values = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
}
function readableText(background: string, preferred: string) {
  const a = luminance(background),
    b = luminance(preferred);
  if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5) return preferred;
  return (a + 0.05) / 0.05 >= 1.05 / (a + 0.05) ? '#000000' : '#ffffff';
}
export function paletteColors(appearance: Appearance, systemDark: boolean) {
  const mode = resolvedMode(appearance, systemDark);
  const palette = accentThemes.find((theme) => theme.id === appearance.accent) ?? accentThemes[0];
  const tokens = palette[mode],
    neutral = brandNeutrals[mode];
  return {
    background: hslHex(neutral.background),
    foreground: hslHex(neutral.foreground),
    primary: hslHex(tokens.primary),
    onPrimary: readableText(hslHex(tokens.primary), hslHex(tokens['primary-foreground'])),
    secondary: hslHex(
      palette.id === 'coral-mint' ? tokens['accent-foreground'] : tokens['brand-orange'],
    ),
  };
}
export function applyAppearance(appearance: Appearance, systemDark: boolean, systemMore = false) {
  const root = document.documentElement;
  root.dataset['mode'] = resolvedMode(appearance, systemDark);
  root.dataset['contrast'] = resolvedContrast(appearance, systemMore);
  root.dataset['accent'] = appearance.accent;
  if (appearance.accent === 'signal') delete root.dataset['palette'];
  else root.dataset['palette'] = appearance.accent;
  const colors = paletteColors(appearance, systemDark);
  root.style.setProperty('--on-accent', colors.onPrimary);
  root.style.setProperty('--brand-secondary', colors.secondary);
  root.style.setProperty('--terminal-background', colors.background);
  root.style.setProperty('--terminal-foreground', colors.foreground);
  root.style.setProperty('--terminal-cursor', colors.primary);
  // Xterm's color parser requires a concrete value, rather than color-mix()/var().
  const mixed = [1, 3, 5]
    .map((i) =>
      Math.round(
        Number.parseInt(colors.primary.slice(i, i + 2), 16) * 0.24 +
          Number.parseInt(colors.background.slice(i, i + 2), 16) * 0.76,
      )
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
  root.style.setProperty('--terminal-selection', '#' + mixed);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors.background);
}
