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
  // Lifted grey used for comment tokens sitting on a diff wash. `gray` falls
  // below WCAG AA on `diffAddBg`/`diffDelBg`; this clears both. MUST exist in
  // this map — `softColor` passes unknown names through untouched and Ink /
  // chalk then silently drop them, rendering the token with no color at all.
  grayBright: '#a6adc8',
  greyBright: '#a6adc8',
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

// ─── Syntax roles ───────────────────────────────────────────────────────────
// `highlight.ts` emits SEMANTIC role names (`'syntax.keyword'`), never literal
// colors, and stays a pure theme-free tokenizer. The names are resolved here,
// against the LIVE palette, by `softColor` — which every component already
// funnels through via the Ink shim. That is what makes syntax highlighting
// follow `/theme`: the frozen `pastel` map below is theme-independent, so a
// tokenizer emitting `'magenta'` would render Catppuccin purple in Gruvbox.

/** The distinct things `highlightLine` can color. */
export type SyntaxRole =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'commentOnWash'
  | 'number'
  | 'literal'
  | 'property'
  | 'variable'
  | 'command'
  | 'flag'
  | 'decorator'
  | 'diffAdd'
  | 'diffDel'
  | 'diffMeta';

export type SyntaxPalette = Record<SyntaxRole, string>;

/**
 * Which existing theme token each syntax role borrows by default.
 *
 * Deriving instead of hand-authoring means all 35 presets get a coherent
 * syntax palette for free, and a new preset needs zero extra colors. The
 * mapping is chosen so the conventional terminal look survives: keywords take
 * the brand (purple/magenta in nearly every scheme), strings take success
 * (green), numbers take warn (yellow), identifiers take the accent (cyan/blue).
 *
 * `commentOnWash` is the lifted variant used when a comment sits on a diff
 * wash — `textMuted` is chosen to recede against `surface` and falls below
 * WCAG AA on `diffAddBg`/`diffDelBg`, so the wash path swaps in the brighter
 * `textSecondary`. See `applyWashTokens` in `history/code-block.tsx`.
 */
const SYNTAX_TOKEN: Readonly<Record<SyntaxRole, keyof Theme>> = Object.freeze({
  keyword: 'brand',
  string: 'success',
  comment: 'textMuted',
  commentOnWash: 'textSecondary',
  number: 'warn',
  literal: 'warn',
  property: 'accent',
  variable: 'accent',
  command: 'accent',
  flag: 'warn',
  decorator: 'brand',
  diffAdd: 'success',
  diffDel: 'error',
  diffMeta: 'accent',
});

/** Prefix that marks a color string as a syntax role rather than a literal. */
const SYNTAX_PREFIX = 'syntax.';

// ─── Bare ANSI names → semantic tokens ──────────────────────────────────────
// ~179 call sites still pass bare Ink color names (`color="cyan"`). Resolving
// those against the frozen `pastel` map made them theme-INDEPENDENT: picking
// Gruvbox recoloured the tokenized chrome but left every one of these sitting
// at its Catppuccin value, so no preset ever fully applied.
//
// These six names are mapped to the token that carries the same meaning. The
// mapping is deliberately limited to names whose Catppuccin token value is
// BYTE-IDENTICAL to their `pastel` entry (accent===pastel.cyan, error===
// pastel.red, …), which is what makes this a guaranteed no-op on the default
// preset while every other preset gains 172 of the 179 sites.
//
// `gray`, `blue` and the *Bright variants are intentionally absent: no token
// equals them on Catppuccin (`textMuted` is #6c7086, `pastel.gray` is #7f849c),
// so mapping them would shift the default theme. They keep the frozen floor.
const ANSI_TOKEN: Readonly<Record<string, keyof Theme>> = Object.freeze({
  cyan: 'accent',
  yellow: 'warn',
  green: 'success',
  red: 'error',
  magenta: 'brand',
  white: 'textPrimary',
});

/**
 * Resolve one syntax role against a palette. A preset may pin any role
 * explicitly via its optional `syntax` field (e.g. a scheme whose strings are
 * orange rather than green); otherwise the role borrows the token named in
 * {@link SYNTAX_TOKEN}. O(1) and allocation-free — this runs once per token
 * per rendered line.
 */
export function resolveSyntaxColor(role: SyntaxRole, palette: Theme = theme): string {
  return palette.syntax?.[role] ?? (palette[SYNTAX_TOKEN[role]] as string);
}

/** Materialize the full syntax palette for a theme. Used by tests and tooling. */
export function resolveSyntaxPalette(palette: Theme = theme): SyntaxPalette {
  const out = {} as SyntaxPalette;
  for (const role of Object.keys(SYNTAX_TOKEN) as SyntaxRole[]) {
    out[role] = resolveSyntaxColor(role, palette);
  }
  return out;
}

/**
 * Resolve a color value to a concrete color.
 *
 * Three cases, in order:
 *  - `syntax.<role>` resolves against the ACTIVE theme, so highlighting
 *    follows `/theme` (see {@link resolveSyntaxColor}).
 *  - A known ANSI name maps to its {@link pastel} hex. This map is frozen and
 *    theme-independent by design — it is the floor for the ~177 call sites
 *    that still pass bare names like `color="red"`.
 *  - Anything else (hex, rgb, Ink's `'dim'`, an unknown name) passes through.
 *
 * `undefined` stays `undefined` so callers can spread it without forcing a
 * color. NOTE: an unknown name that reaches Ink is silently DROPPED by chalk —
 * the token renders with no color at all. Never emit a name that isn't
 * resolvable here.
 */
export function softColor(color?: string): string | undefined {
  if (!color) return color;
  if (color.startsWith(SYNTAX_PREFIX)) {
    const role = color.slice(SYNTAX_PREFIX.length) as SyntaxRole;
    return role in SYNTAX_TOKEN ? resolveSyntaxColor(role) : color;
  }
  // A bare ANSI name whose meaning a token already carries follows the ACTIVE
  // theme (see ANSI_TOKEN). Everything else falls through to the frozen floor.
  const token = ANSI_TOKEN[color];
  if (token !== undefined) {
    const resolved = theme[token];
    if (typeof resolved === 'string') return resolved;
  }
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
  /**
   * Per-preset syntax-highlight overrides. OPTIONAL and normally omitted —
   * every role has a sensible default derived from the tokens above (see
   * `SYNTAX_TOKEN`), so a preset only pins a role when its scheme genuinely
   * disagrees. Example: VS Code Dark+ colors strings orange, not green, so
   * `dark-plus` pins `string`.
   */
  syntax?: Partial<SyntaxPalette> | undefined;
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
  // without invalidating React references held by 50+ components.
  //
  // Keys the OUTGOING preset had and the incoming one does not must be
  // DELETED, not just left alone. `Theme` has optional fields (`syntax`), so
  // a copy-only swap is not a full replacement: selecting `dark-plus` and then
  // any other preset used to leave VS Code's orange-string override behind,
  // silently re-coloring every theme chosen afterwards. Deleting first makes
  // the swap a true assignment regardless of which fields are optional today.
  const t = theme as unknown as Record<string, unknown>;
  const p = preset as unknown as Record<string, unknown>;
  for (const k of Object.keys(t)) {
    if (!(k in p)) delete t[k];
  }
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
    diffAddBg: '#1c3326',
    diffDelBg: '#37202b',
    monitor: { fleet: '#7dcfff', agents: '#bb9af7', worktree: '#9ece6a', phase: '#7dcfff' },
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
    diffAddBg: '#2f4034',
    diffDelBg: '#442f35',
    monitor: { fleet: '#88c0d0', agents: '#b48ead', worktree: '#a3be8c', phase: '#88c0d0' },
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
    diffAddBg: '#0d2e1f',
    diffDelBg: '#2e0d1c',
    monitor: { fleet: '#00f0ff', agents: '#ff00aa', worktree: '#00ff66', phase: '#00f0ff' },
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
    diffAddBg: '#26402e',
    diffDelBg: '#43262e',
    monitor: { fleet: '#8be9fd', agents: '#ff79c6', worktree: '#50fa7b', phase: '#8be9fd' },
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
    monitor: { fleet: '#83a598', agents: '#d3869b', worktree: '#b8bb26', phase: '#83a598' },
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
    monitor: { fleet: '#268bd2', agents: '#d33682', worktree: '#859900', phase: '#268bd2' },
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
    monitor: { fleet: '#61afef', agents: '#c678dd', worktree: '#98c379', phase: '#61afef' },
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
    monitor: { fleet: '#66d9ef', agents: '#ae81ff', worktree: '#a6e22e', phase: '#66d9ef' },
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
    monitor: { fleet: '#9ccfd8', agents: '#c4a7e7', worktree: '#31748f', phase: '#9ccfd8' },
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
    monitor: { fleet: '#7fb4ca', agents: '#957fb8', worktree: '#98bb6e', phase: '#7fb4ca' },
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
    monitor: { fleet: '#59c2ff', agents: '#d4b5ff', worktree: '#aad94c', phase: '#59c2ff' },
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
    monitor: { fleet: '#7fbbb3', agents: '#d699b6', worktree: '#a7c080', phase: '#7fbbb3' },
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
    monitor: { fleet: '#82aaff', agents: '#c792ea', worktree: '#c3e88d', phase: '#82aaff' },
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
    monitor: { fleet: '#36f9f6', agents: '#b56cff', worktree: '#72f1b8', phase: '#36f9f6' },
  }),
  'github-dark': Object.freeze({
    ...baseTheme,
    textPrimary: '#c9d1d9',
    textSecondary: '#b1bac4',
    textMuted: '#8b949e',
    brandPrimary: '#d29922',
    brandAccent: '#bc8cff',
    accent: '#58a6ff',
    user: '#d29922',
    assistant: '#58a6ff',
    tool: '#39c5cf',
    success: '#3fb950',
    warn: '#d29922',
    error: '#f85149',
    borderDefault: '#30363d',
    borderSubtle: '#21262d',
    borderActive: '#58a6ff',
    brand: '#bc8cff',
    surface: '#0d1117',
    surfaceRaised: '#161b22',
    diffAddBg: '#0d2f18',
    diffDelBg: '#3d1418',
    monitor: { fleet: '#58a6ff', agents: '#bc8cff', worktree: '#3fb950', phase: '#39c5cf' },
  }),
  'material-ocean': Object.freeze({
    ...baseTheme,
    textPrimary: '#a6accd',
    textSecondary: '#8f93a2',
    textMuted: '#4b526d',
    brandPrimary: '#f78c6c',
    brandAccent: '#c792ea',
    accent: '#89ddff',
    user: '#ffcb6b',
    assistant: '#89ddff',
    tool: '#82aaff',
    success: '#c3e88d',
    warn: '#ffcb6b',
    error: '#f07178',
    borderDefault: '#3b3f51',
    borderSubtle: '#1f2233',
    borderActive: '#89ddff',
    brand: '#c792ea',
    surface: '#0f111a',
    surfaceRaised: '#1a1c25',
    diffAddBg: '#17301f',
    diffDelBg: '#331b21',
    monitor: { fleet: '#89ddff', agents: '#c792ea', worktree: '#c3e88d', phase: '#82aaff' },
  }),
  nightfox: Object.freeze({
    ...baseTheme,
    textPrimary: '#cdcecf',
    textSecondary: '#aeafb0',
    textMuted: '#71839b',
    brandPrimary: '#f4a261',
    brandAccent: '#9d79d6',
    accent: '#719cd6',
    user: '#dbc074',
    assistant: '#63cdcf',
    tool: '#719cd6',
    success: '#81b29a',
    warn: '#dbc074',
    error: '#c94f6d',
    borderDefault: '#39506d',
    borderSubtle: '#29394f',
    borderActive: '#719cd6',
    brand: '#9d79d6',
    surface: '#192330',
    surfaceRaised: '#212e3f',
    diffAddBg: '#1d3025',
    diffDelBg: '#33202a',
    monitor: { fleet: '#719cd6', agents: '#9d79d6', worktree: '#81b29a', phase: '#63cdcf' },
  }),
  oxocarbon: Object.freeze({
    ...baseTheme,
    textPrimary: '#f2f4f8',
    textSecondary: '#dde1e6',
    textMuted: '#82868b',
    brandPrimary: '#ff7eb6',
    brandAccent: '#be95ff',
    accent: '#78a9ff',
    user: '#3ddbd9',
    assistant: '#78a9ff',
    tool: '#3ddbd9',
    success: '#42be65',
    warn: '#ff7eb6',
    error: '#ee5396',
    borderDefault: '#393939',
    borderSubtle: '#262626',
    borderActive: '#be95ff',
    brand: '#be95ff',
    surface: '#161616',
    surfaceRaised: '#262626',
    diffAddBg: '#17301f',
    diffDelBg: '#33182a',
    monitor: { fleet: '#78a9ff', agents: '#be95ff', worktree: '#42be65', phase: '#3ddbd9' },
  }),
  'catppuccin-macchiato': Object.freeze({
    ...baseTheme,
    textPrimary: '#cad3f5',
    textSecondary: '#b8c0e0',
    textMuted: '#6e738d',
    brandPrimary: '#f5a97f',
    brandAccent: '#f5bde6',
    accent: '#8bd5ca',
    user: '#eed49f',
    assistant: '#8aadf4',
    tool: '#8bd5ca',
    success: '#a6da95',
    warn: '#eed49f',
    error: '#ed8796',
    borderDefault: '#5b6078',
    borderSubtle: '#363a4f',
    borderActive: '#eed49f',
    brand: '#c6a0f6',
    surface: '#1e2030',
    surfaceRaised: '#24273a',
    diffAddBg: '#26402f',
    diffDelBg: '#3f242c',
    monitor: { fleet: '#8bd5ca', agents: '#c6a0f6', worktree: '#a6da95', phase: '#8aadf4' },
  }),
  'catppuccin-frappe': Object.freeze({
    ...baseTheme,
    textPrimary: '#c6d0f5',
    textSecondary: '#b5bfe2',
    textMuted: '#737994',
    brandPrimary: '#ef9f76',
    brandAccent: '#f4b8e4',
    accent: '#81c8be',
    user: '#e5c890',
    assistant: '#8caaee',
    tool: '#81c8be',
    success: '#a6d189',
    warn: '#e5c890',
    error: '#e78284',
    borderDefault: '#626880',
    borderSubtle: '#414559',
    borderActive: '#e5c890',
    brand: '#ca9ee6',
    surface: '#292c3c',
    surfaceRaised: '#303446',
    diffAddBg: '#2c4034',
    diffDelBg: '#422a32',
    monitor: { fleet: '#81c8be', agents: '#ca9ee6', worktree: '#a6d189', phase: '#8caaee' },
  }),
  'gruvbox-material': Object.freeze({
    ...baseTheme,
    textPrimary: '#d4be98',
    textSecondary: '#c5b18d',
    textMuted: '#928374',
    brandPrimary: '#e78a4e',
    brandAccent: '#d3869b',
    accent: '#7daea3',
    user: '#d8a657',
    assistant: '#89b482',
    tool: '#7daea3',
    success: '#a9b665',
    warn: '#d8a657',
    error: '#ea6962',
    borderDefault: '#45403d',
    borderSubtle: '#3c3836',
    borderActive: '#e78a4e',
    brand: '#d3869b',
    surface: '#282828',
    surfaceRaised: '#32302f',
    diffAddBg: '#26332a',
    diffDelBg: '#3a2426',
    monitor: { fleet: '#7daea3', agents: '#d3869b', worktree: '#a9b665', phase: '#89b482' },
  }),
  'tokyo-night-storm': Object.freeze({
    ...baseTheme,
    textPrimary: '#c0caf5',
    textSecondary: '#a9b1d6',
    textMuted: '#565f89',
    brandPrimary: '#ff9e64',
    brandAccent: '#bb9af7',
    accent: '#7aa2f7',
    user: '#e0af68',
    assistant: '#7dcfff',
    tool: '#73daca',
    success: '#9ece6a',
    warn: '#e0af68',
    error: '#f7768e',
    borderDefault: '#3b4261',
    borderSubtle: '#292e42',
    borderActive: '#7aa2f7',
    brand: '#bb9af7',
    surface: '#1f2335',
    surfaceRaised: '#24283b',
    diffAddBg: '#20372c',
    diffDelBg: '#3b2331',
    monitor: { fleet: '#7aa2f7', agents: '#bb9af7', worktree: '#9ece6a', phase: '#7dcfff' },
  }),
  'rose-pine-moon': Object.freeze({
    ...baseTheme,
    textPrimary: '#e0def4',
    // Between Rosé Pine's `text` and `subtle` — `subtle` (#908caa) alone falls
    // under WCAG AA once a comment is lifted onto a diff wash.
    textSecondary: '#c4c1d8',
    textMuted: '#6e6a86',
    brandPrimary: '#f6c177',
    brandAccent: '#ea9a97',
    accent: '#9ccfd8',
    user: '#f6c177',
    assistant: '#c4a7e7',
    tool: '#3e8fb0',
    success: '#3e8fb0',
    warn: '#f6c177',
    error: '#eb6f92',
    borderDefault: '#44415a',
    borderSubtle: '#393552',
    borderActive: '#ea9a97',
    brand: '#c4a7e7',
    surface: '#232136',
    surfaceRaised: '#2a273f',
    diffAddBg: '#22403e',
    diffDelBg: '#3a2836',
    monitor: { fleet: '#9ccfd8', agents: '#c4a7e7', worktree: '#3e8fb0', phase: '#9ccfd8' },
  }),
  zenburn: Object.freeze({
    ...baseTheme,
    textPrimary: '#dcdccc',
    textSecondary: '#c0c0a8',
    textMuted: '#8f8f7f',
    brandPrimary: '#dfaf8f',
    brandAccent: '#dc8cc3',
    accent: '#8cd0d3',
    user: '#f0dfaf',
    assistant: '#93e0e3',
    tool: '#8cd0d3',
    success: '#7f9f7f',
    warn: '#f0dfaf',
    error: '#cc9393',
    borderDefault: '#5f5f5f',
    borderSubtle: '#4a4a4a',
    borderActive: '#f0dfaf',
    brand: '#dc8cc3',
    surface: '#3f3f3f',
    surfaceRaised: '#4f4f4f',
    // Zenburn's base (#3f3f3f) is the lightest of any preset here, so a wash
    // blended toward it leaves the muted green/red markers under 3:1. These
    // sit well below the base on purpose.
    diffAddBg: '#2b3a2a',
    diffDelBg: '#42292a',
    monitor: { fleet: '#8cd0d3', agents: '#dc8cc3', worktree: '#7f9f7f', phase: '#93e0e3' },
  }),
  palenight: Object.freeze({
    ...baseTheme,
    // Palenight's canonical fg (#a6accd) is dim enough that using it as the
    // PRIMARY leaves no headroom for a readable secondary; shift both up one
    // step and keep #a6accd as the secondary.
    textPrimary: '#babed8',
    textSecondary: '#a6accd',
    textMuted: '#676e95',
    brandPrimary: '#f78c6c',
    brandAccent: '#c792ea',
    accent: '#82aaff',
    user: '#ffcb6b',
    assistant: '#89ddff',
    tool: '#82aaff',
    success: '#c3e88d',
    warn: '#ffcb6b',
    error: '#f07178',
    borderDefault: '#4a4f6a',
    borderSubtle: '#3a3f58',
    borderActive: '#82aaff',
    brand: '#c792ea',
    surface: '#292d3e',
    surfaceRaised: '#34324a',
    diffAddBg: '#2b4033',
    diffDelBg: '#43293a',
    monitor: { fleet: '#82aaff', agents: '#c792ea', worktree: '#c3e88d', phase: '#89ddff' },
  }),
  horizon: Object.freeze({
    ...baseTheme,
    textPrimary: '#d5d8da',
    textSecondary: '#bbbdbf',
    textMuted: '#6c6f93',
    brandPrimary: '#f09383',
    brandAccent: '#ee64ac',
    accent: '#26bbd9',
    user: '#fab795',
    assistant: '#59e1e3',
    tool: '#26bbd9',
    success: '#29d398',
    warn: '#fab795',
    error: '#e95678',
    borderDefault: '#3d3f4c',
    borderSubtle: '#2e303e',
    borderActive: '#e95678',
    brand: '#ee64ac',
    surface: '#1c1e26',
    surfaceRaised: '#232530',
    diffAddBg: '#16362e',
    diffDelBg: '#3a1f2a',
    monitor: { fleet: '#26bbd9', agents: '#ee64ac', worktree: '#29d398', phase: '#59e1e3' },
  }),
  sonokai: Object.freeze({
    ...baseTheme,
    textPrimary: '#e3e1e4',
    textSecondary: '#c9c6cb',
    textMuted: '#848089',
    brandPrimary: '#ef9062',
    brandAccent: '#ab9df2',
    accent: '#7accd7',
    user: '#e5c463',
    assistant: '#7accd7',
    tool: '#9ecd6f',
    success: '#9ecd6f',
    warn: '#e5c463',
    error: '#f85e84',
    borderDefault: '#4b484d',
    borderSubtle: '#3b383e',
    borderActive: '#ef9062',
    brand: '#ab9df2',
    surface: '#2d2a2e',
    surfaceRaised: '#37343a',
    diffAddBg: '#2c3a2b',
    diffDelBg: '#43262f',
    monitor: { fleet: '#7accd7', agents: '#ab9df2', worktree: '#9ecd6f', phase: '#7accd7' },
  }),
  'edge-dark': Object.freeze({
    ...baseTheme,
    textPrimary: '#c5cdd9',
    textSecondary: '#adb6c2',
    textMuted: '#7f8490',
    brandPrimary: '#deb974',
    brandAccent: '#d38aea',
    accent: '#6cb6eb',
    user: '#deb974',
    assistant: '#5dbbc1',
    tool: '#6cb6eb',
    success: '#a0c980',
    warn: '#deb974',
    error: '#ec7279',
    borderDefault: '#464957',
    borderSubtle: '#363a4d',
    borderActive: '#6cb6eb',
    brand: '#d38aea',
    surface: '#2b2d3a',
    surfaceRaised: '#333648',
    diffAddBg: '#29392c',
    diffDelBg: '#3d2830',
    monitor: { fleet: '#6cb6eb', agents: '#d38aea', worktree: '#a0c980', phase: '#5dbbc1' },
  }),
  moonfly: Object.freeze({
    ...baseTheme,
    textPrimary: '#bdbdbd',
    textSecondary: '#a8a8a8',
    textMuted: '#767676',
    brandPrimary: '#de935f',
    brandAccent: '#cf87e8',
    accent: '#80a0ff',
    user: '#e3c78a',
    assistant: '#79dac8',
    tool: '#80a0ff',
    success: '#8cc85f',
    warn: '#e3c78a',
    error: '#ff5454',
    borderDefault: '#3a3a3a',
    borderSubtle: '#262626',
    borderActive: '#80a0ff',
    brand: '#cf87e8',
    surface: '#080808',
    surfaceRaised: '#1c1c1c',
    diffAddBg: '#10301d',
    diffDelBg: '#331414',
    monitor: { fleet: '#80a0ff', agents: '#cf87e8', worktree: '#8cc85f', phase: '#79dac8' },
  }),
  melange: Object.freeze({
    ...baseTheme,
    textPrimary: '#ece1d7',
    textSecondary: '#c1a78e',
    textMuted: '#867462',
    brandPrimary: '#e49b5d',
    brandAccent: '#cf9bc2',
    accent: '#a3a9ce',
    user: '#ebc06d',
    assistant: '#89b3b6',
    tool: '#a3a9ce',
    success: '#85b695',
    warn: '#ebc06d',
    error: '#d47766',
    borderDefault: '#4d4640',
    borderSubtle: '#3a352f',
    borderActive: '#e49b5d',
    brand: '#cf9bc2',
    surface: '#292522',
    surfaceRaised: '#34302c',
    diffAddBg: '#2f3a30',
    diffDelBg: '#3f2b28',
    monitor: { fleet: '#a3a9ce', agents: '#cf9bc2', worktree: '#85b695', phase: '#89b3b6' },
  }),
  poimandres: Object.freeze({
    ...baseTheme,
    // Same shift as palenight — #a6accd becomes the secondary so the lifted
    // on-wash comment clears AA.
    textPrimary: '#c4cbe0',
    textSecondary: '#a6accd',
    textMuted: '#506477',
    brandPrimary: '#f087bd',
    brandAccent: '#a684ff',
    accent: '#5de4c7',
    user: '#fffac2',
    assistant: '#89ddff',
    tool: '#5de4c7',
    success: '#5fb3a1',
    warn: '#fffac2',
    error: '#d0679d',
    borderDefault: '#3b4056',
    borderSubtle: '#252b37',
    borderActive: '#5de4c7',
    brand: '#a684ff',
    surface: '#1b1e28',
    surfaceRaised: '#252b37',
    diffAddBg: '#14352f',
    diffDelBg: '#35202c',
    monitor: { fleet: '#5de4c7', agents: '#a684ff', worktree: '#5fb3a1', phase: '#89ddff' },
  }),
  'vitesse-dark': Object.freeze({
    ...baseTheme,
    textPrimary: '#dbd7ca',
    textSecondary: '#bfbaaa',
    textMuted: '#758575',
    brandPrimary: '#dfab5c',
    brandAccent: '#d3869b',
    accent: '#6394bf',
    user: '#e6cc77',
    assistant: '#5eaab5',
    tool: '#6394bf',
    success: '#4d9375',
    warn: '#e6cc77',
    error: '#cb7676',
    borderDefault: '#333333',
    borderSubtle: '#222222',
    borderActive: '#dfab5c',
    brand: '#d3869b',
    surface: '#121212',
    surfaceRaised: '#1c1c1c',
    diffAddBg: '#16301f',
    diffDelBg: '#331d1d',
    monitor: { fleet: '#6394bf', agents: '#d3869b', worktree: '#4d9375', phase: '#5eaab5' },
  }),
  aura: Object.freeze({
    ...baseTheme,
    textPrimary: '#edecee',
    textSecondary: '#cdccce',
    textMuted: '#6d6d6d',
    brandPrimary: '#ffca85',
    brandAccent: '#f694ff',
    accent: '#82e2ff',
    user: '#ffca85',
    assistant: '#82e2ff',
    tool: '#a277ff',
    success: '#61ffca',
    warn: '#ffca85',
    error: '#ff6767',
    borderDefault: '#3b334b',
    borderSubtle: '#262433',
    borderActive: '#a277ff',
    brand: '#f694ff',
    surface: '#15141b',
    surfaceRaised: '#1c1b22',
    diffAddBg: '#14382c',
    diffDelBg: '#351d23',
    monitor: { fleet: '#82e2ff', agents: '#a277ff', worktree: '#61ffca', phase: '#f694ff' },
  }),
  'dark-plus': Object.freeze({
    ...baseTheme,
    textPrimary: '#d4d4d4',
    textSecondary: '#cccccc',
    textMuted: '#858585',
    brandPrimary: '#ce9178',
    brandAccent: '#c586c0',
    accent: '#569cd6',
    user: '#dcdcaa',
    assistant: '#9cdcfe',
    tool: '#4ec9b0',
    success: '#89d185',
    warn: '#cca700',
    error: '#f44747',
    borderDefault: '#3c3c3c',
    borderSubtle: '#2d2d30',
    borderActive: '#569cd6',
    brand: '#c586c0',
    surface: '#1e1e1e',
    surfaceRaised: '#252526',
    diffAddBg: '#16351f',
    diffDelBg: '#3a1d20',
    monitor: { fleet: '#569cd6', agents: '#c586c0', worktree: '#89d185', phase: '#4ec9b0' },
    // The one preset that genuinely disagrees with the derived defaults:
    // VS Code colors strings orange and comments green, the inverse of the
    // usual green-string / grey-comment convention the defaults assume.
    // `commentOnWash` is a lifted green rather than the default
    // `textSecondary`, so the comment stays green on a diff wash instead of
    // switching to grey mid-file.
    syntax: {
      string: '#ce9178',
      comment: '#6a9955',
      commentOnWash: '#9fc98b',
    },
  }),
});

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
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    description: "GitHub's default dark — crisp blue on near-black",
  },
  {
    id: 'material-ocean',
    name: 'Material Ocean',
    description: 'Deepest Material variant — ink blue with pastel accents',
  },
  {
    id: 'nightfox',
    name: 'Nightfox',
    description: 'Balanced slate blue with muted sage and rose',
  },
  {
    id: 'oxocarbon',
    name: 'Oxocarbon',
    description: 'IBM Carbon-derived — neutral greys, electric blue & pink',
  },
  {
    id: 'catppuccin-macchiato',
    name: 'Catppuccin Macchiato',
    description: 'Warmer, one shade lighter than Mocha',
  },
  {
    id: 'catppuccin-frappe',
    name: 'Catppuccin Frappé',
    description: 'The lightest Catppuccin dark — gentle midday contrast',
  },
  {
    id: 'gruvbox-material',
    name: 'Gruvbox Material',
    description: 'Softened Gruvbox — same warmth, lower eye strain',
  },
  {
    id: 'tokyo-night-storm',
    name: 'Tokyo Night Storm',
    description: 'Tokyo Night on a lifted blue-grey base',
  },
  {
    id: 'rose-pine-moon',
    name: 'Rosé Pine Moon',
    description: 'Rosé Pine at dusk — deeper base, same soft accents',
  },
  {
    id: 'zenburn',
    name: 'Zenburn',
    description: 'The classic low-contrast grey — desaturated and calm',
  },
  {
    id: 'palenight',
    name: 'Palenight',
    description: 'Material Palenight — indigo base, candy accents',
  },
  {
    id: 'horizon',
    name: 'Horizon',
    description: 'Warm coral and mint on charcoal — sunset gradient',
  },
  {
    id: 'sonokai',
    name: 'Sonokai',
    description: 'Monokai Pro descendant — punchy on warm graphite',
  },
  {
    id: 'edge-dark',
    name: 'Edge Dark',
    description: 'Clean, evenly-weighted palette on desaturated navy',
  },
  {
    id: 'moonfly',
    name: 'Moonfly',
    description: 'Near-black base with high-chroma accents — maximum contrast',
  },
  {
    id: 'melange',
    name: 'Melange',
    description: 'Warm sepia and clay — the least blue dark theme here',
  },
  {
    id: 'poimandres',
    name: 'Poimandres',
    description: 'Teal-forward, low-saturation — mint on deep indigo',
  },
  {
    id: 'vitesse-dark',
    name: 'Vitesse Dark',
    description: "Anthony Fu's minimal palette — muted, print-like",
  },
  {
    id: 'aura',
    name: 'Aura Dark',
    description: 'Vivid purple and spring green on near-black violet',
  },
  {
    id: 'dark-plus',
    name: 'VS Code Dark+',
    description: "Visual Studio Code's default — familiar blue/orange/teal",
  },
];
