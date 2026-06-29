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
} as const);

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
  /** Diff add/delete background blocks (content highlight). */
  diffAddBg: string;
  diffDelBg: string;
}

// Single tuned pastel palette. Semantic tokens point at the `pastel` hexes
// above, so re-skinning is a one-line edit there that propagates everywhere.
export const theme: Theme = Object.freeze({
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
  // Diff blocks render dark text on a pastel wash (see DiffBlock).
  diffAddBg: pastel.green,
  diffDelBg: pastel.red,
  // Whether the host terminal can render truecolor backgrounds. Diff blocks
  // downgrade to marker-only rendering when this is false (e.g. `TERM=xterm`,
  // `NO_COLOR=1`, captured/piped output).
  supportsBackground: detectSupportsBackground(),
});
