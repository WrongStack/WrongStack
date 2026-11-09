/**
 * The one place VibeUI turns a thrown value into text for the screen.
 *
 * Errors here come from the engine (whose messages are already redacted
 * server-side by `toErrorMessage`) or from the browser itself. Keeping every
 * component on this helper means a future redaction rule for the browser
 * lands in one file instead of a hand-written copy per component.
 */
export function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
