import type { SyntaxPalette, SyntaxRole, Theme, ThemeName } from './theme-types.js';
import { baseTheme, themePresets } from './theme-presets.js';
import {
  resolveSyntaxColor as resolveSyntaxColorFn,
  resolveSyntaxPalette as resolveSyntaxPaletteFn,
  softColorWithTheme,
} from './theme-utils.js';

export { catppuccin, detectSupportsBackground, pastel, SYNTAX_TOKEN } from './theme-utils.js';
export { baseTheme, THEME_OPTIONS, themePickerOptions, themePresets } from './theme-presets.js';
export type { SyntaxPalette, SyntaxRole, Theme, ThemeName, ThemePickerOption } from './theme-types.js';

export const theme: Theme = { ...baseTheme };

let currentPresetName: ThemeName = 'catppuccin';

export function resolveSyntaxColor(role: SyntaxRole, palette: Theme = theme): string {
  return resolveSyntaxColorFn(role, palette);
}

export function resolveSyntaxPalette(palette: Theme = theme): SyntaxPalette {
  return resolveSyntaxPaletteFn(palette);
}

export function softColor(color?: string): string | undefined {
  return softColorWithTheme(color, theme);
}

export function getActiveTheme(): Theme {
  return theme;
}

export function setActiveTheme(name: string | undefined): ThemeName {
  let applied: ThemeName = currentPresetName;
  const preset = name ? (themePresets as Record<string, Theme | undefined>)[name] : undefined;
  if (preset && (name as ThemeName) in themePresets) {
    applied = name as ThemeName;
  }
  if (!preset) {
    return applied;
  }
  const t = theme as unknown as Record<string, unknown>;
  const p = preset as unknown as Record<string, unknown>;
  for (const k of Object.keys(t)) {
    if (!(k in p)) delete t[k];
  }
  for (const k of Object.keys(p)) {
    t[k] = p[k];
  }
  currentPresetName = applied;
  for (const cb of themeSubscribers) {
    try {
      cb(applied);
    } catch {
      // ignore
    }
  }
  return applied;
}

type ThemeListener = (name: ThemeName) => void;
const themeSubscribers = new Set<ThemeListener>();

export function subscribeToTheme(cb: ThemeListener): () => void {
  themeSubscribers.add(cb);
  return () => {
    themeSubscribers.delete(cb);
  };
}

export function getActiveThemeName(): ThemeName {
  return currentPresetName;
}
