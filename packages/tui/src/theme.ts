import { baseTheme, themePresets } from './theme-presets.js';
import type {
  SyntaxPalette,
  SyntaxRole,
  Theme,
  ThemeListener,
  ThemeName,
} from './theme-types.js';
import {
  mixHexColors,
  resolveSyntaxColor as resolveSyntaxColorFn,
  resolveSyntaxPalette as resolveSyntaxPaletteFn,
  softColorWithTheme,
} from './theme-utils.js';

export { baseTheme, THEME_OPTIONS, themePickerOptions, themePresets } from './theme-presets.js';
export type {
  SyntaxPalette,
  SyntaxRole,
  Theme,
  ThemeName,
  ThemePickerOption,
} from './theme-types.js';
export {
  catppuccin,
  detectSupportsBackground,
  mixHexColors,
  pastel,
  SYNTAX_TOKEN,
} from './theme-utils.js';

export const theme: Theme = { ...baseTheme };

/**
 * "Tinted" surface for the right sidebar's cards. We mix the theme's plain
 * `surface` with its `accent` (and a touch of `surfaceRaised`) so each card
 * reads as a colored "plate" rather than blending into the background.
 * Tuned to roughly 12% accent — enough to be unmistakable, not so much
 * that it competes with the body text.
 *
 * Kept as a top-level constant (not a theme token) so the tint follows the
 * active theme automatically: changing themes retints every card without
 * any extra wiring. The other helpers (cardTopEdge, cardHairline) derive
 * their colors from this same mix so a single source of truth drives the
 * whole "raised surface" treatment.
 */
export const sidebarCardSurface = (current: Theme = theme): string =>
  mixHexColors(current.accent, current.surface, 0.12);

/** Bold top edge / leading-rail color for sidebar cards. The accent at
 *  full saturation draws the eye down the rail and doubles as a "live
 *  state" signal — a green rail = healthy, red = alerting, etc. */
export const sidebarCardEdge = (current: Theme = theme): string => current.accent;

/** Hairline color used between body rows inside a card. Tinted toward
 *  `borderActive` (the "live" border color) so dividers feel alive
 *  instead of dead. */
export const sidebarCardHairline = (current: Theme = theme): string =>
  mixHexColors(current.borderActive, current.surface, 0.55);

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

function isThemeName(name: string): name is ThemeName {
  return name in themePresets;
}

export function setActiveTheme(name: string | undefined): ThemeName {
  if (name === undefined || !isThemeName(name)) {
    // Unknown or absent preset: keep the current palette untouched and
    // report what is actually active so callers can persist a valid name.
    return currentPresetName;
  }
  const preset = themePresets[name];
  // Drop keys the new preset does not define (e.g. an optional `syntax`
  // override left behind by the previous preset), then copy the preset
  // into the shared mutable `theme` so every module-level reader picks up
  // the new palette without re-importing.
  const mutable = theme as Partial<Record<keyof Theme, unknown>>;
  for (const key of Object.keys(theme) as (keyof Theme)[]) {
    if (!(key in preset)) delete mutable[key];
  }
  Object.assign(theme, preset);
  currentPresetName = name;
  for (const cb of themeSubscribers) {
    try {
      cb(name);
    } catch {
      // A throwing subscriber must never break the theme swap for the rest.
    }
  }
  return name;
}

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
