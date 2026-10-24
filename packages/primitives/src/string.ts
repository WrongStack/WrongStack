/**
 * String utilities shared across the WrongStack codebase.
 */

/**
 * Truncate a string to at most `max` characters, appending an ellipsis if it
 * was longer. Returns the original string unchanged when it fits.
 */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
