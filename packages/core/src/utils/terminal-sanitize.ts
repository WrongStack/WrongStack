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
const ANSI_OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const ANSI_CONTROL_STRING_RE = /\x1b[P^_X][\s\S]*?\x1b\\/g;
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
): { text: string; truncated: boolean } {
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

  return { text: clipped, truncated };
}
