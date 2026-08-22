/**
 * Telegram platform text-formatting utilities.
 *
 * Extracted from bot.ts (card #7A-1) — pure string helpers bound to
 * Telegram's message-length platform contract, with no dependency on the
 * bot's polling, approval, or API-client machinery. Kept separate from
 * ./format.ts (event humanizers) because that module renders host events
 * while this one enforces platform limits.
 */

/**
 * Maximum permitted output length. Telegram rejects messages longer than
 * 4096 characters; we clamp the requested cap at this value so a
 * misconfigured caller cannot silently violate the platform contract.
 */
const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;

/**
 * Truncate text to fit Telegram's 4096-char message limit.
 * Preserves semantic boundaries in this priority order:
 *   1. Paragraph break (double newline)
 *   2. Sentence break (. ! ? followed by space/newline)
 *   3. Word break (space)
 *   4. Hard cut with ellipsis
 *
 * When a clean boundary is found, appends "…" to signal intentional truncation.
 */
export function truncateForTelegram(text: string, maxLen = 4000): string {
  // P1.8 explicit message-length contract: the caller's cap is the
  // binding contract, but it is clamped at Telegram's hard 4096-char
  // limit so a misconfigured `maxLen > 4096` cannot silently produce
  // output that the platform will reject.
  const effectiveMaxLen = Math.min(maxLen, MAX_TELEGRAM_MESSAGE_LENGTH);
  if (text.length <= effectiveMaxLen) return text;

  // Reserve room for truncation suffix
  const cutoff = effectiveMaxLen - 30;
  if (cutoff <= 0) return `${text.slice(0, effectiveMaxLen - 1)}…`;

  // 1. Paragraph boundary (double newline, suffix "\n\n…" is 3 chars)
  const paraSearchEnd = effectiveMaxLen - 3;
  const paraIdx = text.lastIndexOf('\n\n', paraSearchEnd);
  if (paraIdx > cutoff) {
    return `${text.slice(0, paraIdx)}\n\n…`;
  }

  // 2. Single newline boundary (suffix "\n…" is 2 chars)
  const nlSearchEnd = effectiveMaxLen - 2;
  const nlIdx = text.lastIndexOf('\n', nlSearchEnd);
  if (nlIdx > cutoff) {
    return `${text.slice(0, nlIdx)}\n…`;
  }

  // 3. Sentence boundary (. ! ? followed by space or newline, suffix "…" is 1 char)
  const sentenceSearchEnd = effectiveMaxLen - 1;
  const sentenceRe = /[.!?](?=\s)/g;
  let match: RegExpExecArray | null;
  let sentenceIdx = -1;
  match = sentenceRe.exec(text);
  while (match !== null) {
    if (match.index + 1 > sentenceSearchEnd) break;
    if (match.index + 1 > cutoff) sentenceIdx = match.index + 1;
    match = sentenceRe.exec(text);
  }
  if (sentenceIdx > cutoff) {
    return `${text.slice(0, sentenceIdx)}…`;
  }

  // 4. Word boundary (space, suffix " …" is 2 chars)
  const spaceSearchEnd = effectiveMaxLen - 2;
  const spaceIdx = text.lastIndexOf(' ', spaceSearchEnd);
  if (spaceIdx > cutoff) {
    return `${text.slice(0, spaceIdx)} …`;
  }

  // 5. Hard cut bounded strictly
  const hardSlice = text.slice(0, effectiveMaxLen - 20);
  const hardResult = `${hardSlice}…[+${text.length - hardSlice.length} chars]`;
  if (hardResult.length <= effectiveMaxLen) return hardResult;
  return `${text.slice(0, effectiveMaxLen - 1)}…`;
}

/**
 * Escape HTML special chars for Telegram's HTML parse mode.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
