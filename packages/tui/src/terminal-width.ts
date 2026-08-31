import stringWidth from 'string-width';

/**
 * Terminal-column measurement helpers.
 *
 * JavaScript string length counts UTF-16 code units, not terminal cells. That
 * is especially visible in status bars: emoji are normally two columns,
 * combining marks are zero columns, and Nerd Font private-use glyphs are one.
 * Keep chrome layout on this small, ANSI-aware primitive instead of `.length`.
 */

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const ANSI_CONTROL_STRING_RE = /\x1b[P^_X][\s\S]*?\x1b\\/g;
const ANSI_ESCAPE_RE = /\x1b[ -/]*[@-~]/g;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const LIGATURE_PAIRS = new Set(['->', '<-', '=>', '<=', '>=', '!=', '==', '~>', '<~']);
const LIGATURE_SEPARATOR = ' ';

export function stripAnsi(value: string): string {
  return value
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CONTROL_STRING_RE, '')
    .replace(ANSI_RE, '')
    .replace(ANSI_ESCAPE_RE, '');
}

/**
 * Prevent programming-font ligatures with a visible, measured separator.
 * Ink's painter allocates at least one cell even for zero-width code points,
 * so U+200B/U+200C would make Yoga and the output grid disagree.
 */
export function breakTerminalLigatures(value: string): string {
  if (!/[-<=>!~]/.test(value)) return value;
  let safe = '';
  let previous = '';
  for (const char of value) {
    if (previous && LIGATURE_PAIRS.has(`${previous}${char}`)) safe += LIGATURE_SEPARATOR;
    safe += char;
    previous = char;
  }
  return safe;
}

/**
 * Convert untrusted command/tool text into terminal-safe printable content.
 *
 * Ink measures control characters differently from a physical terminal: a
 * literal tab is effectively zero-width to Yoga but expands to the next tab
 * stop when Windows Terminal receives it. Cursor/erase escape sequences are
 * worse because they can paint outside the component that owns the text.
 * Normalize tabs to a small fixed separator, remove terminal escapes, and
 * retain only printable characters plus newlines before layout is measured.
 */
export function sanitizeTerminalText(value: string, tabWidth = 2): string {
  const tab = ' '.repeat(Math.max(1, Math.min(8, Math.floor(tabWidth))));
  const withoutEscapes = value
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CONTROL_STRING_RE, '')
    .replace(ANSI_RE, '')
    .replace(ANSI_ESCAPE_RE, '')
    .replace(/\t/g, tab)
    .replace(/\r/g, '');

  let safe = '';
  for (const char of withoutEscapes) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\n' || (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))) {
      safe += char;
    }
  }
  return safe;
}

export function displayWidth(value: string): number {
  // Ink 7 measures and paints with string-width 8. Keeping the application on
  // the same implementation prevents Yoga allocation and physical output from
  // disagreeing for emoji clusters, CJK, combining marks and zero-width text.
  return stringWidth(value);
}

export function truncateDisplay(value: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(value) <= maxWidth) return value;
  const ellipsisWidth = displayWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) return ellipsis;
  let out = '';
  let used = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    const segmentWidth = displayWidth(segment);
    if (used + segmentWidth + ellipsisWidth > maxWidth) break;
    out += segment;
    used += segmentWidth;
  }
  return `${out}${ellipsis}`;
}

export function truncateDisplayStart(value: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(value) <= maxWidth) return value;
  const ellipsisWidth = displayWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) return ellipsis;
  const segments = [...GRAPHEME_SEGMENTER.segment(value)].map(({ segment }) => segment);
  let out = '';
  let used = 0;
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index] ?? '';
    const segmentWidth = displayWidth(segment);
    if (used + segmentWidth + ellipsisWidth > maxWidth) break;
    out = `${segment}${out}`;
    used += segmentWidth;
  }
  return `${ellipsis}${out}`;
}

/** Split without bisecting a grapheme cluster; input is expected to be ANSI-free. */
export function splitDisplay(value: string, maxWidth: number): [head: string, tail: string] {
  if (maxWidth <= 0) return ['', value];
  let end = 0;
  let used = 0;
  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(value)) {
    const segmentWidth = displayWidth(segment);
    if (used + segmentWidth > maxWidth) break;
    used += segmentWidth;
    end = index + segment.length;
  }
  return [value.slice(0, end), value.slice(end)];
}

export function padDisplayEnd(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - displayWidth(value)))}`;
}

/**
 * One-line frame rule of exactly `width` display columns for `width >= 6`
 * (labels are truncated to fit; the auxiliary right label yields first).
 * Narrower widths degrade to bare corners narrower than `width`.
 */
export function frameRule(
  width: number,
  leftLabel: string,
  rightLabel = '',
  edge: 'top' | 'bottom' = 'top',
): string {
  const leftCorner = edge === 'top' ? '╭' : '╰';
  const rightCorner = edge === 'top' ? '╮' : '╯';
  // Degenerate: below 6 columns no labeled rule fits (`╭─ x ─╮` needs 6).
  if (width < 6) return `${leftCorner}${rightCorner}`.slice(0, Math.max(0, width));

  const available = width - 2;
  const leftTrimmed = leftLabel.trim();
  const rightTrimmed = rightLabel.trim();
  let left = truncateDisplay(leftTrimmed, Math.max(1, Math.floor(available * 0.62)));
  // The right label is bounded by its own 30% budget AND by the room the left
  // label leaves: labels plus their 3+3 bookend columns must fit `available`
  // or the fill clamps to zero and the rule overflows `width`.
  const rightBudget = rightTrimmed
    ? Math.min(
        displayWidth(rightTrimmed),
        Math.floor(available * 0.3),
        Math.max(0, available - displayWidth(left) - 6),
      )
    : 0;
  const right = rightBudget > 0 ? truncateDisplay(rightTrimmed, rightBudget) : '';
  // Left keeps priority, but its own bookends still have to fit beside the
  // rendered right label (or alone, when the right label was dropped).
  const leftRoom = available - (right ? displayWidth(right) + 3 : 0) - 3;
  if (displayWidth(left) > leftRoom) {
    left = truncateDisplay(leftTrimmed, Math.max(1, leftRoom));
  }
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
 * for every renderable geometry — any `width ≥ 6` with no slot, and any
 * `width ≥ reservedRightWidth + 9` with one (the label prefix needs its
 * `─ ` / ` ` bookends beside the slot). Narrower widths or oversized slots
 * degrade to bare corners. The chip's live content — spinner, rolling word,
 * growing dots — must still be padded to exactly `reservedRightWidth` by
 * the caller so the right corner never jitters.
 */
export function frameRuleParts(
  width: number,
  leftLabel: string,
  reservedRightWidth: number,
  edge: 'top' | 'bottom' = 'top',
): { head: string; tail: string } {
  const leftCorner = edge === 'top' ? '╭' : '╰';
  const rightCorner = edge === 'top' ? '╮' : '╯';
  // Degenerate: below 6 columns no labeled rule fits — bare corners, no slot.
  if (width < 6) {
    return { head: `${leftCorner}${rightCorner}`.slice(0, Math.max(0, width)), tail: '' };
  }

  const available = width - 2;
  const reserved = Math.max(0, reservedRightWidth);
  // The reserved slot and its ` ─` bookends (3 cols) share `available` with
  // the label prefix, so the label budget must clamp to the room that
  // actually remains — otherwise the FILL below clamps to zero instead and
  // head + reserved + tail overflows `width`, breaking the invariant.
  const reservedChrome = reserved > 0 ? reserved + 3 : 0;
  const left = truncateDisplay(
    leftLabel.trim(),
    Math.max(1, Math.min(Math.floor(available * 0.62), available - reservedChrome - 3)),
  );
  const prefix = left ? `─ ${left} ` : '';
  // Suffix shape when a slot is reserved: ` {reserved} ─` → width reserved + 3.
  const suffixWidth = reservedChrome;
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
