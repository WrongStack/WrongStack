/**
 * Pre-boot launch banner — the WRONGSTACK brand mark + wordmark rendered
 * as raw ANSI strings for the plain-terminal launch menu.
 *
 * This is a deliberate plain-string twin of the TUI banner
 * (packages/tui/src/components/history/banner.tsx). Importing the TUI
 * component here would drag ink+react into the pre-boot path — which may
 * end up launching WebUI/HQ and never need them. When the TUI glyph
 * tables or palette change, update these in the same commit.
 */

// Canonical palette from website/public/wrongstack.svg.
const STACK_ORANGE = { r: 0xfd, g: 0x9f, b: 0x02 };
const SIGNAL_PINK = { r: 0xfe, g: 0x2e, b: 0x5f };

type Rgb = { r: number; g: number; b: number };

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const clamped = Math.min(1, Math.max(0, t));
  return {
    r: Math.round(a.r + (b.r - a.r) * clamped),
    g: Math.round(a.g + (b.g - a.g) * clamped),
    b: Math.round(a.b + (b.b - a.b) * clamped),
  };
}

function fg(c: Rgb): string {
  return `\x1b[38;2;${c.r};${c.g};${c.b}m`;
}

/**
 * Per-call (not module-load) so tests can toggle NO_COLOR/FORCE_COLOR.
 * Mirrors the semantics of core/utils/color.ts.
 */
function colorsEnabled(): boolean {
  const flag = (value: string | undefined): boolean =>
    value !== undefined && value.trim() !== '' && !/^(0|false|no|off)$/i.test(value.trim());
  if (flag(process.env.NO_COLOR)) return false;
  if (flag(process.env.FORCE_COLOR)) return true;
  return process.stdout.isTTY === true;
}

// ── Packed 5×7 wordmark (see tui banner.tsx for the derivation) ──────────
const WORDMARK_GLYPH_BITS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  W: Object.freeze(['10001', '10001', '10001', '10101', '10101', '10101', '01010']),
  R: Object.freeze(['11110', '10001', '10001', '11110', '10100', '10010', '10001']),
  O: Object.freeze(['01110', '10001', '10001', '10001', '10001', '10001', '01110']),
  N: Object.freeze(['10001', '11001', '11001', '10101', '10011', '10011', '10001']),
  G: Object.freeze(['01110', '10001', '10000', '10111', '10001', '10001', '01110']),
  S: Object.freeze(['01111', '10000', '10000', '01110', '00001', '00001', '11110']),
  T: Object.freeze(['11111', '00100', '00100', '00100', '00100', '00100', '00100']),
  A: Object.freeze(['01110', '10001', '10001', '11111', '10001', '10001', '10001']),
  C: Object.freeze(['01111', '10000', '10000', '10000', '10000', '10000', '01111']),
  K: Object.freeze(['10001', '10010', '10100', '11000', '10100', '10010', '10001']),
});

const WORDMARK = 'WRONGSTACK';
const WORDMARK_PIXEL_ROWS = 7;
const WORDMARK_ROWS = Math.ceil(WORDMARK_PIXEL_ROWS / 2);
const GLYPH_WIDTH = 5;
/** Exported so the menu can decide full vs compact by terminal width. */
export const WORDMARK_WIDTH = WORDMARK.length * GLYPH_WIDTH + WORDMARK.length - 1;

function packedCell(top: string | undefined, bottom: string | undefined): string {
  if (top === '1' && bottom === '1') return '█';
  if (top === '1') return '▀';
  if (bottom === '1') return '▄';
  return ' ';
}

function packedGlyphRow(glyph: ReadonlyArray<string>, row: number): string {
  const top = glyph[row * 2] ?? '';
  const bottom = glyph[row * 2 + 1] ?? '';
  return Array.from({ length: GLYPH_WIDTH }, (_, column) =>
    packedCell(top[column], bottom[column]),
  ).join('');
}

const WORDMARK_LINES: ReadonlyArray<string> = Object.freeze(
  Array.from({ length: WORDMARK_ROWS }, (_, row) =>
    [...WORDMARK]
      .map((letter) => {
        const glyph = WORDMARK_GLYPH_BITS[letter];
        return glyph ? packedGlyphRow(glyph, row) : ' '.repeat(GLYPH_WIDTH);
      })
      .join(' '),
  ),
);

/** Left-to-right orange→pink gradient across the visible glyphs of a line. */
function gradientLine(text: string, colorOn: boolean): string {
  if (!colorOn) return text;
  const length = text.length;
  let out = '\x1b[1m';
  for (let i = 0; i < length; i++) {
    const ch = text[i]!;
    if (ch === ' ') {
      out += ch;
      continue;
    }
    const t = length > 1 ? i / (length - 1) : 0.5;
    out += `${fg(mixRgb(STACK_ORANGE, SIGNAL_PINK, t))}${ch}`;
  }
  return `${out}\x1b[0m`;
}

function dimLine(text: string, colorOn: boolean): string {
  return colorOn ? `\x1b[2m${text}\x1b[22m` : text;
}

// ── Brand mark: five blocks, pink one dropped half a step (resting frame) ─
const MARK_COLS = 5;
const PINK_HOME = 1;
const MARK_WIDTH = MARK_COLS * 2 + (MARK_COLS - 1);

function buildMarkLines(colorOn: boolean): string[] {
  const orange = colorOn ? fg(STACK_ORANGE) : '';
  const pink = colorOn ? fg(SIGNAL_PINK) : '';
  const reset = colorOn ? '\x1b[0m' : '';
  // pinkRow = 1: pink tile occupies rows 1–2 of column 1; orange tiles
  // fill rows 0–1 everywhere else — same as the TUI's resting frame.
  return Array.from({ length: 3 }, (_, row) => {
    const cells = Array.from({ length: MARK_COLS }, (_, column) => {
      if (column === PINK_HOME && (row === 1 || row === 2)) return `${pink}██${reset}`;
      if (row < 2 && column !== PINK_HOME) return `${orange}██${reset}`;
      return '  ';
    });
    return cells.join(' ').trimEnd();
  });
}

/**
 * Build the launch-screen banner as an array of pre-colored lines
 * (no trailing newlines, no indent — the caller owns placement).
 *
 * Full art (mark + wordmark + tagline) when the terminal is wide enough;
 * a one-line gradient fallback otherwise. Honors NO_COLOR / non-TTY by
 * emitting plain text.
 */
export function launchBannerLines(columns: number, version?: string): string[] {
  const colorOn = colorsEnabled();
  const tagline = version
    ? `v${version} · the wrong stack for all the right reasons`
    : 'the wrong stack for all the right reasons';

  if (columns < WORDMARK_WIDTH + 4) {
    const compact = '▐█▌ W R O N G S T A C K';
    return [gradientLine(compact, colorOn), dimLine(tagline, colorOn)];
  }

  const markPad = ' '.repeat(Math.max(0, Math.floor((WORDMARK_WIDTH - MARK_WIDTH) / 2)));
  const tagPad = ' '.repeat(Math.max(0, Math.floor((WORDMARK_WIDTH - tagline.length) / 2)));
  return [
    ...buildMarkLines(colorOn).map((line) => markPad + line),
    '',
    ...WORDMARK_LINES.map((line) => gradientLine(line, colorOn)),
    tagPad + dimLine(tagline, colorOn),
  ];
}
