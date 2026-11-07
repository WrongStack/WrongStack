/**
 * String utilities shared across the WrongStack codebase.
 */

/**
 * Truncate a string to at most `max` characters, appending an ellipsis if it
 * was longer. Returns the original string unchanged when it fits.
 */
export function truncate(s: string, max: number): string {
  if (!Number.isFinite(max)) {
    return max === Number.POSITIVE_INFINITY ? s : '';
  }
  const limit = Math.floor(max);
  if (limit <= 0) return '';
  if (s.length <= limit) return s;
  if (limit === 1) return '…';
  let end = limit - 1;
  const lastCode = s.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return `${s.slice(0, end)}…`;
}
