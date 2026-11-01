/**
 * The one place the dashboard turns a thrown value into text for the screen.
 *
 * Errors here come from the HQ server (whose messages are already redacted
 * server-side by `toErrorMessage`) or from the browser's own network layer.
 * Keeping every screen on this helper means a future redaction rule for the
 * browser lands in one file instead of a dozen hand-written copies.
 */
export function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
