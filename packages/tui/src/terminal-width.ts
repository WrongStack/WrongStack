/**
 * Terminal-column measurement helpers.
 *
 * JavaScript string length counts UTF-16 code units, not terminal cells. That
 * is especially visible in status bars: emoji are normally two columns,
 * combining marks are zero columns, and Nerd Font private-use glyphs are one.
 * Keep chrome layout on this small, ANSI-aware primitive instead of `.length`.
 */

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const COMBINING_RE = /\p{Mark}/u;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function isWideCodePoint(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1b000 && code <= 0x1b2ff) ||
      (code >= 0x1f200 && code <= 0x1f251) ||
      (code >= 0x20000 && code <= 0x3fffd))
  );
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '');
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(stripAnsi(value))) {
    // Joined emoji (family, profession, skin-tone sequences) occupy one
    // two-column grapheme even though they contain several code points.
    if (EMOJI_RE.test(segment)) {
      width += 2;
      continue;
    }
    for (const char of segment) {
      const code = char.codePointAt(0) ?? 0;
      if (code === 0 || code < 0x20 || (code >= 0x7f && code < 0xa0)) continue;
      if (COMBINING_RE.test(char) || code === 0xfe0e || code === 0xfe0f || code === 0x200d) {
        continue;
      }
      width += isWideCodePoint(code) ? 2 : 1;
    }
  }
  return width;
}

export function truncateDisplay(value: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(value) <= maxWidth) return value;
  const ellipsisWidth = displayWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) return ellipsis;
  let out = '';
  let used = 0;
  for (const char of value) {
    const charWidth = displayWidth(char);
    if (used + charWidth + ellipsisWidth > maxWidth) break;
    out += char;
    used += charWidth;
  }
  return `${out}${ellipsis}`;
}

export function padDisplayEnd(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - displayWidth(value)))}`;
}

export function frameRule(
  width: number,
  leftLabel: string,
  rightLabel = '',
  edge: 'top' | 'bottom' = 'top',
): string {
  const leftCorner = edge === 'top' ? '╭' : '╰';
  const rightCorner = edge === 'top' ? '╮' : '╯';
  if (width <= 2) return `${leftCorner}${rightCorner}`.slice(0, Math.max(0, width));

  const available = width - 2;
  const left = truncateDisplay(leftLabel.trim(), Math.max(1, Math.floor(available * 0.62)));
  const reservedRight = rightLabel ? Math.min(displayWidth(rightLabel.trim()), Math.floor(available * 0.3)) : 0;
  const right = reservedRight > 0 ? truncateDisplay(rightLabel.trim(), reservedRight) : '';
  const prefix = left ? `─ ${left} ` : '';
  const suffix = right ? ` ${right} ─` : '';
  const fill = '─'.repeat(Math.max(0, available - displayWidth(prefix) - displayWidth(suffix)));
  return `${leftCorner}${prefix}${fill}${suffix}${rightCorner}`;
}

/**
 * Structural split of a top/bottom frame rule that reserves — but does not
 * render — the right-hand label slot. Unlike {@link frameRule} (which bakes the
 * right label into a single string), this returns the rule as `head` + `tail`
 * with a fixed-width gap of `reservedRightWidth` columns between them, so a
 * caller can render an animated / per-glyph-colored chip into that gap while
 * keeping the total rule width identical to `frameRule`.
 *
 * Geometry mirrors `frameRule` exactly:
 *   `head` = `╭─ {left} ` + fill + one leading space of the suffix
 *   gap    = `reservedRightWidth` columns (caller fills these)
 *   `tail` = ` ─` + right corner
 *
 * Invariant: `displayWidth(head) + reservedRightWidth + displayWidth(tail) === width`
 * for any `width ≥ 2` and any reserved width (the chip's live content — spinner,
 * rolling word, growing dots — must be padded to exactly `reservedRightWidth` by
 * the caller so the right corner never jitters).
 */
export function frameRuleParts(
  width: number,
  leftLabel: string,
  reservedRightWidth: number,
  edge: 'top' | 'bottom' = 'top',
): { head: string; tail: string } {
  const leftCorner = edge === 'top' ? '╭' : '╰';
  const rightCorner = edge === 'top' ? '╮' : '╯';
  if (width <= 2) {
    // Degenerate: no room for a gap. Emit just the corners, no reserved slot.
    return { head: `${leftCorner}${rightCorner}`.slice(0, Math.max(0, width)), tail: '' };
  }

  const available = width - 2;
  const reserved = Math.max(0, reservedRightWidth);
  const left = truncateDisplay(leftLabel.trim(), Math.max(1, Math.floor(available * 0.62)));
  const prefix = left ? `─ ${left} ` : '';
  // Suffix shape when a slot is reserved: ` {reserved} ─` → width reserved + 3.
  const suffixWidth = reserved > 0 ? reserved + 3 : 0;
  const fill = '─'.repeat(Math.max(0, available - displayWidth(prefix) - suffixWidth));
  if (reserved <= 0) {
    // No reserved slot — behaves like frameRule with an empty right label.
    return { head: `${leftCorner}${prefix}${fill}`, tail: `${rightCorner}` };
  }
  return {
    head: `${leftCorner}${prefix}${fill} `,
    tail: ` ─${rightCorner}`,
  };
}
