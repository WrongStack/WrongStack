/**
 * Bidi and zero-width controls, dropped from everything an approval shows: in
 * an approval they only make the displayed text diverge from the real one (a
 * U+202E reorders the command, Tag characters carry invisible text). Same
 * character set as core's sanitizeTerminalText, which the TUI dialog uses.
 */
const HIDDEN_TEXT_RE = /[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/gu;

/** `value` with every string (keys included) stripped of hidden text. */
export function withoutHiddenText<T>(value: T): T {
  if (typeof value === 'string') return value.replace(HIDDEN_TEXT_RE, '') as T;
  if (Array.isArray(value)) return value.map(withoutHiddenText) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k.replace(HIDDEN_TEXT_RE, ''), withoutHiddenText(v)]),
    ) as T;
  }
  return value;
}
