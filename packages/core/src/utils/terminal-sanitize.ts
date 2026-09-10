/**
 * Sanitize untrusted text before it is written to a terminal.
 *
 * Any surface that renders model-supplied, file-supplied or MCP-supplied text
 * into a TTY must run it through here first. Escape sequences in that text can
 * paint outside the region that owns it: `\x1b[2J\x1b[H` clears the screen and
 * homes the cursor, which lets a payload erase a permission prompt's header and
 * repaint a convincing fake above the genuine key prompt. The user then answers
 * the real prompt while reading the attacker's body.
 *
 * Bidi and zero-width controls are stripped for the same reason at a different
 * layer: they reorder or hide characters so the rendered string differs from
 * the string that will actually be executed (the "Trojan Source" class).
 *
 * This is the single source. `@wrongstack/tui` has its own copy for layout
 * measurement; the CLI permission prompt and diff renderer call this one.
 */

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Longest body either string-terminated sequence may carry. Real ones are a
 * window title or a hyperlink target; 4 KiB is far past anything legitimate.
 */
const MAX_STRING_BODY = 4096;

/**
 * OSC and the other string-terminated controls.
 *
 * These were `[\s\S]*?` — a lazy scan for the terminator. Lazy is not linear:
 * for EVERY introducer the engine walks forward looking for a terminator, so
 * input that is nothing but introducers costs O(n²). Measured on 256 KiB of
 * `ESC ]`: 12.5 seconds, which is exactly the diff-render budget, and the
 * permission prompt sanitized its body twice before clipping — so a tool
 * result could freeze the approval UI the user was about to answer.
 *
 * A negated class cannot cross the terminator, so it finds the same end with
 * no backtracking, and the length bound caps the damage of a body that never
 * terminates. Same 256 KiB input: 0.5 ms.
 *
 * One deliberate behaviour change: a body containing a bare `ESC` that is not
 * part of the terminator no longer matches here. It is not left dangerous —
 * the CSI/two-char patterns below strip the escapes and the non-printable
 * filter at the end of {@link sanitizeTerminalText} removes `BEL` — the body
 * text simply survives as visible characters instead of being swallowed
 * whole. Visible is the safer direction for a prompt the user reads.
 */
const ANSI_OSC_RE = new RegExp(`\\x1b\\][^\\x07\\x1b]{0,${MAX_STRING_BODY}}(?:\\x07|\\x1b\\\\)`, 'g');
const ANSI_CONTROL_STRING_RE = new RegExp(
  `\\x1b[P^_X][^\\x1b]{0,${MAX_STRING_BODY}}\\x1b\\\\`,
  'g',
);
/**
 * Catches the two-character forms the CSI pattern above misses — `ESC c` (RIS,
 * a full terminal reset) being the dangerous one.
 */
const ANSI_ESCAPE_RE = /\x1b[ -/]*[@-~]/g;

/**
 * Bidirectional and zero-width formatting controls. These are legal characters
 * with legitimate uses, but in an approval prompt they only serve to make the
 * displayed text diverge from the real one, so they are dropped rather than
 * rendered.
 *
 * U+200B–U+200F zero-width + LTR/RTL marks, U+202A–U+202E embedding/override,
 * U+2066–U+2069 isolates, U+FEFF zero-width no-break space.
 */
const BIDI_AND_ZERO_WIDTH_RE = /[​-‏‪-‮⁦-⁩﻿]/g;

/**
 * Strip terminal escapes, bidi/zero-width controls and non-printable characters
 * from `value`, normalizing tabs to a fixed-width separator.
 *
 * Newlines are preserved; carriage returns are removed so a payload cannot
 * return to the start of a line and overwrite what was already drawn.
 */
export function sanitizeTerminalText(value: string, tabWidth = 2): string {
  const tab = ' '.repeat(Math.max(1, Math.min(8, Math.floor(tabWidth))));
  const withoutEscapes = value
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CONTROL_STRING_RE, '')
    .replace(ANSI_RE, '')
    .replace(ANSI_ESCAPE_RE, '')
    .replace(BIDI_AND_ZERO_WIDTH_RE, '')
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

/**
 * Sanitize and hard-cap untrusted text destined for a terminal preview.
 *
 * A line cap alone is not a bound: a single 200,000-character line passes a
 * 40-line limit untouched and can scroll a prompt off screen. Callers that show
 * a preview of attacker-influenced content should bound both dimensions.
 */
export function sanitizeTerminalPreview(
  value: string,
  opts: { maxLines?: number; maxChars?: number; tabWidth?: number } = {},
): {
  text: string;
  truncated: boolean;
  /**
   * Size of the FULL sanitized text, before clipping. Returned so a caller
   * that wants to report what it withheld does not have to sanitize the whole
   * body a second time to find out — the permission prompt did exactly that,
   * paying two full passes over untrusted input on the approval path.
   */
  sanitizedLength: number;
  sanitizedLines: number;
} {
  const maxLines = opts.maxLines ?? 40;
  const maxChars = opts.maxChars ?? 8_000;

  const safe = sanitizeTerminalText(value, opts.tabWidth);
  let truncated = false;

  let clipped = safe;
  if (clipped.length > maxChars) {
    clipped = clipped.slice(0, maxChars);
    truncated = true;
  }

  const lines = clipped.split('\n');
  if (lines.length > maxLines) {
    clipped = lines.slice(0, maxLines).join('\n');
    truncated = true;
  }

  return {
    text: clipped,
    truncated,
    sanitizedLength: safe.length,
    sanitizedLines: safe.split('\n').length,
  };
}
