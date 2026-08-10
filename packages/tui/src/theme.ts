// Central TUI palette. Until now colors were hardcoded as Ink color names
// (`color="cyan"`, `borderColor="magenta"`, …) scattered across ~30
// components, so there was no single place to tune the look. This module is
// that place.
//
// The values are now soft *pastel hex* (Catppuccin Mocha) rather than the bare
// 16-color ANSI names. ANSI names render against the terminal's own palette,
// which is typically dark and harsh; pinning truecolor pastels makes the look
// uniformly soft regardless of the host terminal theme.
//
// Most components don't reference `theme` directly — they still pass bare ANSI
// names (`color="red"`). Those are caught at render time by the Ink shim in
// `ink.tsx`, which routes every `color` / `backgroundColor` / `borderColor`
// through {@link softColor}. So this `pastel` map is the single source of truth
// for *both* the semantic tokens below and every hardcoded ANSI name.

import type { ThemePresetId } from '@wrongstack/core/types';

// ─── Pastel palette (Catppuccin Mocha) ──────────────────────────────────────
// Keys are the Ink/ANSI color names a component might pass; values are the
// pastel hex they resolve to. `softColor` maps name → hex and passes anything
// already-hex (or unknown, e.g. 'dim') through untouched.
//
// The extra Catppuccin-named exports below (peach, pink, surface0, etc.) let
// semantic theme tokens and components reference the palette directly without
// hardcoding hex values.
export const pastel = Object.freeze({
  // Base 8
  black: '#11111b',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#cba6f7',
  cyan: '#94e2d5',
  white: '#cdd6f4',
  // Greys
  gray: '#7f849c',
  grey: '#7f849c',
  // Bright variants — a touch lighter / shifted within the same family
  blackBright: '#585b70',
  redBright: '#eba0ac',
  greenBright: '#b8e8b0',
  yellowBright: '#f5e6b8',
  blueBright: '#89dceb',
  magentaBright: '#b4befe',
  cyanBright: '#99e6da',
  whiteBright: '#ffffff',
  // Extended Catppuccin Mocha — semantic palette entries so theme tokens
  // and components can reference them by name.
  peach: '#fab387',
  pink: '#f5c2e7',
  surface0: '#313244',
  surface1: '#45475a',
  subtext0: '#a6adc8',
  flamingo: '#f2cdcd',
} as const);

/**
 * Convenience re-export of individual Catppuccin hex values so themed
 * components (e.g. banner, auth panel) can import them without hardcoding.
 */
export const catppuccin = pastel;

/**
 * Resolve a color value to its pastel equivalent. Known ANSI names map to the
 * {@link pastel} hex; hex/rgb strings and unknown values (e.g. Ink's `'dim'`)
 * pass through unchanged. `undefined` stays `undefined` so callers can spread
 * it without forcing a color.
 */
export function softColor(color?: string): string | undefined {
  if (!color) return color;
  return (pastel as Record<string, string>)[color] ?? color;
}

/**
 * Whether the host terminal can render truecolor backgrounds.
 *
 * Surfaced as `theme.supportsBackground` so diff / status / progress
 * components can opt out of pastel background washes on plain terminals
 * (e.g. `TERM=xterm`, `NO_COLOR=1`, or a piped non-TTY). Detection follows
 * the chalk / supports-color convention: explicit `NO_COLOR` wins, then
 * `COLORTERM=truecolor|24bit`, then a `TERM` substring match. Default is
 * `true` (most modern terminals are truecolor); a missing TTY flips it to
 * `false` so captured output stays clean.
 *
 * Both `env` and `isTTY` are overridable so unit tests can exercise every
 * branch without mutating process state.
 */
export function detectSupportsBackground(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY ?? false,
): boolean {
  if (!isTTY) return false;
  if (typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') return false;
  const colorterm = env.COLORTERM ?? '';
  if (/^(truecolor|24bit)$/i.test(colorterm)) return true;
  const term = env.TERM ?? '';
  if (/truecolor|24bit/i.test(term)) return true;
  if (/256(color)?/i.test(term)) return true;
  if (colorterm !== '' && colorterm !== 'false') return true;
  return true;
}

/**
 * Canonical palette preset identifiers. The runtime palette is always one of
 * these five names; the key is also the public CLI/TUI slug (used in
 * `config.themePreset` and the `/theme <preset>` slash command).
 */
export type ThemeName = ThemePresetId;

export interface ThemePickerOption {
  id: ThemeName;
  name: string;
  description: string;
}

export interface Theme {
  /** Primary readable foreground used by framed chrome. */
  textPrimary: string;
  /** Secondary foreground for arguments and supporting labels. */
  textSecondary: string;
  /** Quiet metadata foreground that remains readable without ANSI dim quirks. */
  textMuted: string;
  /** Catppuccin peach — warm brand accent, shared with the startup wordmark. */
  brandPrimary: string;
  /** Catppuccin pink — brand companion accent. */
  brandAccent: string;
  /** Low-contrast panel surface (used only when background support is safe). */
  surface: string;
  /** Raised surface for focused chrome. */
  surfaceRaised: string;
  /** Primary accent — prompts, links, tool names, assistant label. */
  accent: string;
  /** USER: label + the user's own message text marker. */
  user: string;
  /** ASSISTANT: label. */
  assistant: string;
  /** Tool name / tool activity. */
  tool: string;
  /** Success states (✓, passing, added diff lines). */
  success: string;
  /** Warnings, queued items, the user-input label. */
  warn: string;
  /** Errors, failures, deleted diff lines, danger chips. */
  error: string;
  /** Muted/secondary text. `true` maps to Ink's `dimColor`; a color name also works. */
  dim: true | string;
  /**
   * Whether the host terminal can render truecolor backgrounds. Determined
   * at startup from `process.env.TERM` / `COLORTERM` / `NO_COLOR` plus
   * `process.stdout.isTTY`; passed to diff blocks so they can fall back to
   * marker-only colouring when the terminal strips backgrounds.
   */
  supportsBackground: boolean;
  /** Default (quiet) border color for panels. */
  borderDefault: string;
  /**
   * Near-invisible chrome for dense transcript frames (tool result rails).
   * Present enough to structure the block, never loud enough to compete
   * with content or status marks.
   */
  borderSubtle: string;
  /** Active/attention border (confirm prompts, focused frames). */
  borderActive: string;
  /** Banner / brand accent. */
  brand: string;
  /** Per-monitor accent borders so each overlay has a distinct identity. */
  monitor: {
    fleet: string;
    agents: string;
    worktree: string;
    phase: string;
  };
  /**
   * Diff add/delete row washes. Dark, low-luminance tints (deep green /
   * deep maroon) so the row reads as added/removed while the foreground
   * text — including syntax-highlight pastels — keeps full contrast on
   * top. Mirrors the Claude Code diff look rather than a light pastel
   * wash with dark text.
   */
  diffAddBg: string;
  diffDelBg: string;
}

// Active palette — mutable, swapped at runtime by `setActiveTheme()`. Each
// key is overwritten in-place so the 50+ components that import `theme` keep
// their existing references; React picks the new values up via the
// `useActiveTheme()` subscription on the next render. The keys mirror the
// `Theme` interface above, so the type contract is identical.
const baseTheme: Theme = {
  textPrimary: pastel.white,
  textSecondary: '#bac2de',
  textMuted: '#6c7086',
  brandPrimary: pastel.peach,
  brandAccent: pastel.pink,
  surface: '#181825',
  surfaceRaised: '#1e1e2e',
  accent: pastel.cyan,
  user: pastel.yellow,
  assistant: pastel.cyan,
  tool: pastel.cyan,
  success: pastel.green,
  warn: pastel.yellow,
  error: pastel.red,
  dim: true,
  // Subtle slate border — present but never harsh.
  borderDefault: pastel.blackBright,
  // Tool-result outer rail — one step quieter than borderDefault so long
  // transcripts don't read as a stack of heavy boxes.
  borderSubtle: pastel.surface0,
  borderActive: pastel.yellow,
  brand: pastel.magenta,
  monitor: {
    fleet: pastel.cyan,
    agents: pastel.magenta,
    worktree: pastel.green,
    phase: pastel.cyan,
  },
  // Diff rows render deep green/deep maroon tints on the Catppuccin Mocha
  // base (#1e1e2e). Blend the Catppuccin green (#a6e3a1) / red (#f38ba8)
  // accent into the base at ≈22 % saturation so each row carries a clear
  // colour cue — not the subtle ~12 % of the previous values. The foreground
  // stays readable at full contrast on top — see applyWashTokens for the
  // comment-promotion logic that keeps dim/gray tokens visible on these
  // backgrounds.
  diffAddBg: '#1e3b2a',
  diffDelBg: '#3b1f26',
  // Whether the host terminal can render truecolor backgrounds. Diff blocks
  // downgrade to marker-only rendering when this is false (e.g. `TERM=xterm`,
  // `NO_COLOR=1`, captured/piped output).
  supportsBackground: detectSupportsBackground(),
};

// `theme` is the live, mutable bag every component imports. Copying keys from
// `baseTheme` keeps the in-place mutations from leaking into other presets;
// `setActiveTheme()` then writes a preset on top of this same object so the
// imports stay valid. We intentionally do NOT `Object.freeze` it — runtime
// theme switching requires mutate-in-place.
export const theme: Theme = { ...baseTheme };

// Tracks which preset is currently mirrored into `theme`. We can't rely on
// referential equality because in-place mutation means `theme !== preset`
// after the very first swap. `setActiveTheme` writes this in lockstep with
// the `theme` mutation so `getActiveThemeName` stays correct across swaps.
let currentPresetName: ThemeName = 'catppuccin';

/**
 * Snapshot of the active palette. The returned object is the *same* reference
 * the rest of the app sees, so identity checks (`===`) can tell when
 * `setActiveTheme` has actually swapped something. Cheap to call.
 */
export function getActiveTheme(): Theme {
  return theme;
}

/**
 * Mutate `theme` in place to the given preset's palette. Unknown names fall
 * back to `catppuccin` and report the fallback to the caller so the picker can
 * show a hint. Subscribers (see `subscribeToTheme`) are notified synchronously.
 *
 * Returns the name actually applied (always one of `ThemeName`).
 */
export function setActiveTheme(name: string | undefined): ThemeName {
  // Unknown / missing name falls back to the current preset (no-op swap). The
  // resolved preset object is `themePresets[name]` — never `theme` itself, so
  // the in-place write below doesn't echo the previous palette back onto
  // itself. We look up by canonical key to keep the registered name accurate.
  let applied: ThemeName = currentPresetName;
  const preset = name ? (themePresets as Record<string, Theme | undefined>)[name] : undefined;
  if (preset && (name as ThemeName) in themePresets) {
    applied = name as ThemeName;
  }
  if (!preset) {
    return applied;
  }
  // In-place mutation so existing imports of `theme` see the new values
  // without invalidating React references held by 50+ components. Keys mirror
  // the `Theme` interface exactly — TS would catch any drift at compile time.
  const t = theme as unknown as Record<string, unknown>;
  const p = preset as unknown as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    t[k] = p[k];
  }
  currentPresetName = applied;
  // Notify subscribers (see `useActiveTheme`).
  for (const cb of themeSubscribers) {
    try {
      cb(applied);
    } catch {
      // ignore — a broken listener must not break theme switching
    }
  }
  return applied;
}

type ThemeListener = (name: ThemeName) => void;
const themeSubscribers = new Set<ThemeListener>();

/**
 * Subscribe to active-theme changes. Returns an unsubscribe function. Used by
 * `useActiveTheme()` so React re-renders when the palette swaps. Callers from
 * outside React (e.g. host boot wiring) can use it to persist + reapply.
 */
export function subscribeToTheme(cb: ThemeListener): () => void {
  themeSubscribers.add(cb);
  return () => {
    themeSubscribers.delete(cb);
  };
}

/**
 * Returns the name of the currently active theme preset, tracked via
 * `currentPresetName` (kept in lockstep with `setActiveTheme` mutations).
 * Cheap O(1). Always returns one of the canonical `ThemeName` values.
 */
export function getActiveThemeName(): ThemeName {
  return currentPresetName;
}

export const themePresets: Record<ThemeName, Theme> = Object.freeze({
  // `catppuccin` MUST be an independent frozen snapshot — sharing the live
  // `theme` reference here means `setActiveTheme('catppuccin')` mutates the
  // same object it reads from, so it can never restore the original palette
  // after a different preset was applied. Each preset entry is a self-contained
  // snapshot; the live `theme` is a separate mutable overlay synthesized by
  // `setActiveTheme`.
  //
  // Sub-objects (e.g. `monitor`) are also cloned per preset — sharing them
  // across presets would let a future mutation on one preset leak into the
  // others even though the top-level preset is frozen.
  catppuccin: Object.freeze({ ...baseTheme, monitor: { ...baseTheme.monitor } }),
  'tokyo-night': Object.freeze({
    ...baseTheme,
    brandPrimary: '#ff9e64',
    brandAccent: '#bb9af7',
    accent: '#7dcfff',
    user: '#e0af68',
    assistant: '#7dcfff',
    tool: '#7dcfff',
    success: '#9ece6a',
    warn: '#e0af68',
    error: '#f7768e',
    borderDefault: '#414868',
    borderSubtle: '#24283b',
    borderActive: '#ff9e64',
    brand: '#bb9af7',
    surface: '#16161e',
    surfaceRaised: '#1a1b26',
    monitor: { ...baseTheme.monitor, fleet: '#7dcfff', agents: '#bb9af7', goal: '#9ece6a' },
  }),
  nord: Object.freeze({
    ...baseTheme,
    brandPrimary: '#d08770',
    brandAccent: '#b48ead',
    accent: '#88c0d0',
    user: '#ebcb8b',
    assistant: '#81a1c1',
    tool: '#88c0d0',
    success: '#a3be8c',
    warn: '#ebcb8b',
    error: '#bf616a',
    borderDefault: '#4c566a',
    borderSubtle: '#3b4252',
    borderActive: '#88c0d0',
    brand: '#b48ead',
    surface: '#2e3440',
    surfaceRaised: '#3b4252',
    monitor: { ...baseTheme.monitor, fleet: '#88c0d0', agents: '#b48ead', goal: '#a3be8c' },
  }),
  cyberpunk: Object.freeze({
    ...baseTheme,
    brandPrimary: '#ff0055',
    brandAccent: '#00ffcc',
    accent: '#00f0ff',
    user: '#ffe600',
    assistant: '#00f0ff',
    tool: '#00f0ff',
    success: '#00ff66',
    warn: '#ffe600',
    error: '#ff0055',
    borderDefault: '#3a3a5c',
    borderSubtle: '#1a1a2e',
    borderActive: '#00f0ff',
    brand: '#ff00aa',
    surface: '#0d0d1a',
    surfaceRaised: '#16162a',
    monitor: { ...baseTheme.monitor, fleet: '#00f0ff', agents: '#ff00aa', goal: '#00ff66' },
  }),
  dracula: Object.freeze({
    ...baseTheme,
    brandPrimary: '#ffb86c',
    brandAccent: '#ff79c6',
    accent: '#8be9fd',
    user: '#f1fa8c',
    assistant: '#8be9fd',
    tool: '#8be9fd',
    success: '#50fa7b',
    warn: '#f1fa8c',
    error: '#ff5555',
    borderDefault: '#6272a4',
    borderSubtle: '#44475a',
    borderActive: '#bd93f9',
    brand: '#ff79c6',
    surface: '#282a36',
    surfaceRaised: '#44475a',
    monitor: { ...baseTheme.monitor, fleet: '#8be9fd', agents: '#ff79c6', goal: '#50fa7b' },
  }),
  'gruvbox-dark': Object.freeze({
    ...baseTheme,
    brandPrimary: '#fe8019',
    brandAccent: '#d3869b',
    accent: '#83a598',
    user: '#fabd2f',
    assistant: '#83a598',
    tool: '#8ec07c',
    success: '#b8bb26',
    warn: '#fabd2f',
    error: '#fb4934',
    borderDefault: '#504945',
    borderSubtle: '#3c3836',
    borderActive: '#fe8019',
    brand: '#d3869b',
    surface: '#282828',
    surfaceRaised: '#3c3836',
    diffAddBg: '#1f3a1f',
    diffDelBg: '#3a1f1f',
    monitor: { ...baseTheme.monitor, fleet: '#83a598', agents: '#d3869b', goal: '#b8bb26' },
  }),
  'solarized-dark': Object.freeze({
    ...baseTheme,
    brandPrimary: '#cb4b16',
    brandAccent: '#6c71c4',
    accent: '#268bd2',
    user: '#b58900',
    assistant: '#2aa198',
    tool: '#2aa198',
    success: '#859900',
    warn: '#b58900',
    error: '#dc322f',
    borderDefault: '#586e75',
    borderSubtle: '#073642',
    borderActive: '#b58900',
    brand: '#d33682',
    surface: '#002b36',
    surfaceRaised: '#073642',
    diffAddBg: '#0e3a30',
    diffDelBg: '#3a1a1a',
    monitor: { ...baseTheme.monitor, fleet: '#268bd2', agents: '#d33682', goal: '#859900' },
  }),
  'one-dark': Object.freeze({
    ...baseTheme,
    brandPrimary: '#e5c07b',
    brandAccent: '#c678dd',
    accent: '#61afef',
    user: '#e5c07b',
    assistant: '#56b6c2',
    tool: '#61afef',
    success: '#98c379',
    warn: '#e5c07b',
    error: '#e06c75',
    borderDefault: '#3e4452',
    borderSubtle: '#2c313c',
    borderActive: '#61afef',
    brand: '#c678dd',
    surface: '#21252b',
    surfaceRaised: '#282c34',
    diffAddBg: '#1f3a26',
    diffDelBg: '#3a2226',
    monitor: { ...baseTheme.monitor, fleet: '#61afef', agents: '#c678dd', goal: '#98c379' },
  }),
  monokai: Object.freeze({
    ...baseTheme,
    brandPrimary: '#fd971f',
    brandAccent: '#ae81ff',
    accent: '#66d9ef',
    user: '#f4bf75',
    assistant: '#66d9ef',
    tool: '#a1efe4',
    success: '#a6e22e',
    warn: '#f4bf75',
    error: '#f92672',
    borderDefault: '#75715e',
    borderSubtle: '#3e3d32',
    borderActive: '#fd971f',
    brand: '#ae81ff',
    surface: '#1e1f1c',
    surfaceRaised: '#272822',
    diffAddBg: '#1f3318',
    diffDelBg: '#3a1f25',
    monitor: { ...baseTheme.monitor, fleet: '#66d9ef', agents: '#ae81ff', goal: '#a6e22e' },
  }),
  'rose-pine': Object.freeze({
    ...baseTheme,
    brandPrimary: '#f6c177',
    brandAccent: '#ebbcba',
    accent: '#9ccfd8',
    user: '#f6c177',
    assistant: '#c4a7e7',
    tool: '#9ccfd8',
    success: '#31748f',
    warn: '#f6c177',
    error: '#eb6f92',
    borderDefault: '#524f67',
    borderSubtle: '#26233a',
    borderActive: '#ebbcba',
    brand: '#c4a7e7',
    surface: '#191724',
    surfaceRaised: '#1f1d2e',
    diffAddBg: '#1f3538',
    diffDelBg: '#3a2530',
    monitor: { ...baseTheme.monitor, fleet: '#9ccfd8', agents: '#c4a7e7', goal: '#31748f' },
  }),
  kanagawa: Object.freeze({
    ...baseTheme,
    brandPrimary: '#dca561',
    brandAccent: '#957fb8',
    accent: '#7fb4ca',
    user: '#e98a57',
    assistant: '#7fb4ca',
    tool: '#658594',
    success: '#98bb6e',
    warn: '#dca561',
    error: '#c34043',
    borderDefault: '#54546d',
    borderSubtle: '#36364a',
    borderActive: '#d27e99',
    brand: '#957fb8',
    surface: '#16161d',
    surfaceRaised: '#1f1f28',
    diffAddBg: '#1f2d1f',
    diffDelBg: '#321e22',
    monitor: { ...baseTheme.monitor, fleet: '#7fb4ca', agents: '#957fb8', goal: '#98bb6e' },
  }),
  'ayu-dark': Object.freeze({
    ...baseTheme,
    brandPrimary: '#ff8f40',
    brandAccent: '#d4b5ff',
    accent: '#59c2ff',
    user: '#ffaa33',
    assistant: '#95e6cb',
    tool: '#59c2ff',
    success: '#aad94c',
    warn: '#ffaa33',
    error: '#f07178',
    borderDefault: '#3d414c',
    borderSubtle: '#1f2128',
    borderActive: '#ff8f40',
    brand: '#d4b5ff',
    surface: '#0f1419',
    surfaceRaised: '#14181f',
    diffAddBg: '#1c2a1f',
    diffDelBg: '#2e1c20',
    monitor: { ...baseTheme.monitor, fleet: '#59c2ff', agents: '#d4b5ff', goal: '#aad94c' },
  }),
  everforest: Object.freeze({
    ...baseTheme,
    brandPrimary: '#e69875',
    brandAccent: '#d699b6',
    accent: '#7fbbb3',
    user: '#dbbc7f',
    assistant: '#83c092',
    tool: '#7fbbb3',
    success: '#a7c080',
    warn: '#dbbc7f',
    error: '#e67e80',
    borderDefault: '#475258',
    borderSubtle: '#343f44',
    borderActive: '#e69875',
    brand: '#d699b6',
    surface: '#2d353b',
    surfaceRaised: '#343f44',
    diffAddBg: '#1f3326',
    diffDelBg: '#331f25',
    monitor: { ...baseTheme.monitor, fleet: '#7fbbb3', agents: '#d699b6', goal: '#a7c080' },
  }),
  'night-owl': Object.freeze({
    ...baseTheme,
    brandPrimary: '#f78c6c',
    brandAccent: '#c792ea',
    accent: '#82aaff',
    user: '#ecc48d',
    assistant: '#82aaff',
    tool: '#7fdbca',
    success: '#c3e88d',
    warn: '#ecc48d',
    error: '#ff5874',
    borderDefault: '#1d3b53',
    borderSubtle: '#0b253a',
    borderActive: '#82aaff',
    brand: '#c792ea',
    surface: '#011627',
    surfaceRaised: '#0b253a',
    diffAddBg: '#0e2e26',
    diffDelBg: '#2e1722',
    monitor: { ...baseTheme.monitor, fleet: '#82aaff', agents: '#c792ea', goal: '#c3e88d' },
  }),
  synthwave: Object.freeze({
    ...baseTheme,
    brandPrimary: '#ff7edb',
    brandAccent: '#b56cff',
    accent: '#36f9f6',
    user: '#fffc6e',
    assistant: '#36f9f6',
    tool: '#42f6e3',
    success: '#72f1b8',
    warn: '#fffc6e',
    error: '#fe4450',
    borderDefault: '#241b46',
    borderSubtle: '#1a103a',
    borderActive: '#ff7edb',
    brand: '#b56cff',
    surface: '#1a103a',
    surfaceRaised: '#241b46',
    diffAddBg: '#1f3530',
    diffDelBg: '#3a1f30',
    monitor: { ...baseTheme.monitor, fleet: '#36f9f6', agents: '#b56cff', goal: '#72f1b8' },
  }),
} as Record<ThemeName, Theme>);

export const THEME_OPTIONS: readonly ThemePickerOption[] = [
  {
    id: 'catppuccin',
    name: 'Catppuccin Mocha',
    description: 'Warm pastel — the original WrongStack default',
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: 'Cool blue-purple, calm low-contrast coding palette',
  },
  { id: 'nord', name: 'Nord', description: 'Arctic, muted blues and greens — easy on the eyes' },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    description: 'Hot pink + neon cyan, high-contrast night mode',
  },
  { id: 'dracula', name: 'Dracula', description: 'Classic purple-on-black, vivid accents' },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    description: 'Warm earthy retro palette — orange, olive and muted aqua',
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    description: 'Precision contrast, base16 classic with teal undertones',
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    description: "Atom's iconic dark palette — blue-led with warm accents",
  },
  {
    id: 'monokai',
    name: 'Monokai',
    description: 'Sublime Text classic — vivid magenta, cyan and lime',
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    description: 'Aesthetic pine & foam — soft pastel evening tones',
  },
  {
    id: 'kanagawa',
    name: 'Kanagawa',
    description: 'Hokusai-inspired waves — sumi ink on washi',
  },
  {
    id: 'ayu-dark',
    name: 'Ayu Dark',
    description: 'Simple, pleasant dark — warm orange + cool blue mix',
  },
  {
    id: 'everforest',
    name: 'Everforest',
    description: 'Green-based comfort palette — forest greens and warm tans',
  },
  {
    id: 'night-owl',
    name: 'Night Owl',
    description: "Sarah Drasner's night theme — deep navy with bold accents",
  },
  {
    id: 'synthwave',
    name: "Synthwave '84",
    description: 'Hot pink + neon cyan on deep purple — 80s retro glow',
  },
];
