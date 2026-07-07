export type AccentThemeMode = 'light' | 'dark';

export type AccentTokens = {
  primary: string;
  primaryForeground: string;
  accent: string;
  accentForeground: string;
  ring: string;
  running: string;
};

export type AccentPalette = {
  id: string;
  labelKey: string;
  light: AccentTokens;
  dark: AccentTokens;
};

export const DEFAULT_ACCENT_COLOR = 'cyan';

export const ACCENT_PALETTES = [
  {
    id: 'cyan',
    labelKey: 'settings:appearance.accentCyan',
    light: {
      primary: '194 84% 38%',
      primaryForeground: '0 0% 100%',
      accent: '166 36% 90%',
      accentForeground: '180 64% 24%',
      ring: '194 84% 38%',
      running: '194 84% 38%',
    },
    dark: {
      primary: '190 86% 54%',
      primaryForeground: '240 7% 7%',
      accent: '164 36% 18%',
      accentForeground: '164 72% 66%',
      ring: '190 86% 54%',
      running: '190 86% 54%',
    },
  },
  {
    id: 'blue',
    labelKey: 'settings:appearance.accentBlue',
    light: {
      primary: '217 88% 48%',
      primaryForeground: '0 0% 100%',
      accent: '214 76% 93%',
      accentForeground: '217 72% 30%',
      ring: '217 88% 48%',
      running: '217 88% 48%',
    },
    dark: {
      primary: '213 94% 68%',
      primaryForeground: '222 47% 11%',
      accent: '218 42% 20%',
      accentForeground: '213 94% 78%',
      ring: '213 94% 68%',
      running: '213 94% 68%',
    },
  },
  {
    id: 'emerald',
    labelKey: 'settings:appearance.accentEmerald',
    light: {
      primary: '151 68% 36%',
      primaryForeground: '0 0% 100%',
      accent: '150 45% 90%',
      accentForeground: '152 70% 24%',
      ring: '151 68% 36%',
      running: '151 68% 36%',
    },
    dark: {
      primary: '151 68% 52%',
      primaryForeground: '156 38% 8%',
      accent: '153 40% 17%',
      accentForeground: '151 70% 68%',
      ring: '151 68% 52%',
      running: '151 68% 52%',
    },
  },
  {
    id: 'violet',
    labelKey: 'settings:appearance.accentViolet',
    light: {
      primary: '262 72% 52%',
      primaryForeground: '0 0% 100%',
      accent: '262 70% 94%',
      accentForeground: '263 70% 38%',
      ring: '262 72% 52%',
      running: '262 72% 52%',
    },
    dark: {
      primary: '263 85% 72%',
      primaryForeground: '260 25% 8%',
      accent: '263 40% 22%',
      accentForeground: '263 88% 80%',
      ring: '263 85% 72%',
      running: '263 85% 72%',
    },
  },
  {
    id: 'rose',
    labelKey: 'settings:appearance.accentRose',
    light: {
      primary: '344 72% 48%',
      primaryForeground: '0 0% 100%',
      accent: '345 78% 94%',
      accentForeground: '344 70% 34%',
      ring: '344 72% 48%',
      running: '344 72% 48%',
    },
    dark: {
      primary: '343 85% 68%',
      primaryForeground: '340 25% 8%',
      accent: '343 44% 20%',
      accentForeground: '343 88% 78%',
      ring: '343 85% 68%',
      running: '343 85% 68%',
    },
  },
  {
    id: 'amber',
    labelKey: 'settings:appearance.accentAmber',
    light: {
      primary: '35 92% 44%',
      primaryForeground: '36 45% 10%',
      accent: '38 86% 91%',
      accentForeground: '32 86% 28%',
      ring: '35 92% 44%',
      running: '35 92% 44%',
    },
    dark: {
      primary: '38 94% 62%',
      primaryForeground: '36 50% 9%',
      accent: '36 42% 20%',
      accentForeground: '38 94% 74%',
      ring: '38 94% 62%',
      running: '38 94% 62%',
    },
  },
] as const satisfies readonly AccentPalette[];

export type AccentColor = (typeof ACCENT_PALETTES)[number]['id'];

export function isAccentColor(value: unknown): value is AccentColor {
  return typeof value === 'string' && ACCENT_PALETTES.some((palette) => palette.id === value);
}

export function getAccentPalette(value: unknown): (typeof ACCENT_PALETTES)[number] {
  return ACCENT_PALETTES.find((palette) => palette.id === value) ?? ACCENT_PALETTES[0];
}

export function applyAccentPalette(
  root: HTMLElement,
  accentColor: AccentColor,
  mode: AccentThemeMode,
): void {
  const palette = getAccentPalette(accentColor);
  const tokens = palette[mode];
  root.style.setProperty('--primary', tokens.primary);
  root.style.setProperty('--primary-foreground', tokens.primaryForeground);
  root.style.setProperty('--accent', tokens.accent);
  root.style.setProperty('--accent-foreground', tokens.accentForeground);
  root.style.setProperty('--ring', tokens.ring);
  root.style.setProperty('--running', tokens.running);
}
