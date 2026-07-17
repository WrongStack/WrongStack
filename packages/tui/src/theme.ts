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

// Single tuned pastel palette. Semantic tokens point at the `pastel` hexes
// above, so re-skinning is a one-line edit there that propagates everywhere.
export const theme: Theme = Object.freeze({
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
  borderActive: pastel.yellow,
  brand: pastel.magenta,
  monitor: {
    fleet: pastel.cyan,
    agents: pastel.magenta,
    worktree: pastel.green,
    phase: pastel.cyan,
  },
  // Diff rows render Catppuccin text on a dark Catppuccin-tinted wash (see
  // DiffBlock): blend the Catppuccin green/red accent into the Mocha base
  // (#1e1e2e) at ≈12 % so each row carries a subtle colour cue without the
  // harshness of a full-saturation tint. The foreground stays readable at
  // full contrast on top — see applyWashTokens for the comment-promotion
  // logic that keeps dim/gray tokens visible on these backgrounds.
  diffAddBg: '#2e363c',
  diffDelBg: '#382b3d',
  // Whether the host terminal can render truecolor backgrounds. Diff blocks
  // downgrade to marker-only rendering when this is false (e.g. `TERM=xterm`,
  // `NO_COLOR=1`, captured/piped output).
  supportsBackground: detectSupportsBackground(),
});
