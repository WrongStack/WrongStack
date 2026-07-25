import { color, stripAnsi } from '@wrongstack/core/utils';

// Picker theme - a small, self-contained palette so the launch model picker
// looks intentional without pulling in the full theme module. The accent is
// amber (WrongStack's brand color); chrome is drawn dim/gray so the content
// carries the emphasis.
export const theme = {
  accent: color.amber,
  chrome: color.gray,
  cursor: (s: string): string => color.amber(color.bold(s)),
  ctx: color.cyan,
  cost: color.green,
  caps: color.magenta,
};

/** Box-drawing glyphs for the picker frame (rounded corners). */
const BOX = {
  tl: '╭',
  tr: '╮',
  bl: '╰',
  br: '╯',
  h: '─',
  v: '│',
} as const;

/**
 * Inner content width of the picker box, in columns. Fixed default used when
 * the terminal width is unknown (non-TTY: CI, piped stdin, tests) so those
 * render paths stay deterministic. Also the lower clamp bound - the box never
 * shrinks below this even in a very narrow terminal, since the model columns
 * (id 34 + ctx 6 + cost 12 + caps) need the room.
 */
const PICKER_MIN_WIDTH = 74;

/**
 * Upper clamp bound. On very wide terminals the box stops growing here so the
 * content (left-aligned columns) doesn't stretch into an unreadable full-screen
 * band; the extra terminal space is left as margin on the right.
 */
const PICKER_MAX_WIDTH = 100;

/**
 * Resolve the box's inner content width from the live terminal. Adapts to
 * `process.stdout.columns` when it's a TTY with a known width, clamped to
 * [PICKER_MIN_WIDTH, PICKER_MAX_WIDTH] and inset by 2 columns so the box (which
 * renders 2 columns wider than its inner width: the left+right borders) fits
 * without wrapping. Falls back to PICKER_MIN_WIDTH when columns is undefined -
 * this keeps non-TTY output (CI, pipes, tests) at a stable, deterministic
 * width. Called by every box helper; within one synchronous render pass the
 * terminal width is stable, so all borders line up.
 */
function pickerWidth(): number {
  const cols = process.stdout.columns;
  if (typeof cols !== 'number' || !Number.isFinite(cols) || cols <= 0) {
    return PICKER_MIN_WIDTH;
  }
  // Reserve 2 columns for the box's own border characters.
  const inner = cols - 2;
  return Math.max(PICKER_MIN_WIDTH, Math.min(PICKER_MAX_WIDTH, inner));
}

/** Visible width of a string, ignoring ANSI color escapes. */
function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

/**
 * Right-pad a (possibly colorized) string to `width` visible columns. ANSI
 * escapes have zero display width, so we measure with `visibleWidth` and add
 * literal spaces after the (already-terminated) colored segment. Truncates
 * with an ellipsis when the visible content is wider than `width`.
 */
export function padVisible(s: string, width: number): string {
  const w = visibleWidth(s);
  if (w === width) return s;
  if (w < width) return s + ' '.repeat(width - w);
  // Too wide: truncate the plain text and re-emit (drops color on overflow,
  // which only happens for pathologically long ids in a narrow terminal).
  const plain = stripAnsi(s);
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

/** Top border with an embedded, accented title: `╭─ Title ───────╮`. */
export function boxTop(title: string): string {
  const width = pickerWidth();
  const label = ` ${title} `;
  const pad = Math.max(0, width - visibleWidth(label) - 1);
  return theme.chrome(
    `${BOX.tl}${BOX.h}${theme.accent(color.bold(label))}${theme.chrome(BOX.h.repeat(pad))}${BOX.tr}`,
  );
}

/** Bottom border. */
export function boxBottom(): string {
  return theme.chrome(`${BOX.bl}${BOX.h.repeat(pickerWidth())}${BOX.br}`);
}

/** A content row wrapped in the box's vertical borders, padded to width. */
export function boxRow(content: string): string {
  return `${theme.chrome(BOX.v)} ${padVisible(content, pickerWidth() - 2)} ${theme.chrome(BOX.v)}`;
}

/** A full-width dim separator row inside the box. */
export function boxDivider(): string {
  return theme.chrome(`${BOX.v}${BOX.h.repeat(pickerWidth())}${BOX.v}`);
}

/**
 * Render a key-hint footer: keys in accent, descriptions dim, ` · ` dim
 * separators. e.g. `↑↓ move · Enter select · Esc clear · Ctrl+C quit`.
 */
export function keyHints(pairs: Array<[string, string]>): string {
  return pairs.map(([k, label]) => `${theme.accent(k)} ${color.dim(label)}`).join(color.dim(' · '));
}
