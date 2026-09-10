/**
 * Error-to-string normalization, with credential redaction built in.
 *
 * WS-SEC-09: `scrubErrorText`/`scrubErrorDetail` were excellent and used at
 * **8** call sites, while this raw helper was used at **587**. Every audit of
 * this repo has found the same shape — a correct helper that most call sites
 * do not reach — and the sanitizer's own docblock records WS-066 being filed
 * because one surface scrubbed and its sibling did not. Fixing 587 call sites
 * individually would only reset the clock, so the redaction moved into the
 * helper they already call.
 *
 * What this does NOT do is rewrite the home directory to `~`. That belongs to
 * {@link scrubErrorText}, which is aimed at text leaving the host; applying it
 * to every error string in the process would mangle paths for callers that
 * parse them back out. The split is deliberate: credentials must never survive
 * anywhere, home paths only matter on the way out.
 *
 * @module utils/error
 */

import { redactText } from './redaction.js';

/**
 * Convert an unknown thrown value to a human-readable string, with
 * credential-shaped substrings redacted.
 *
 * This is the default on purpose. A message reaches logs, transcripts, the
 * TUI, WebSocket frames and crash reports, and no caller wants the provider
 * key a gateway echoed back inside `Incorrect API key provided: sk-…`.
 */
export function toErrorMessage(err: unknown): string {
  return redactText(rawErrorMessage(err));
}

/**
 * The unredacted form, for the rare caller that must compare or re-throw the
 * exact original text (error-code matching, protocol round-trips).
 *
 * Prefer {@link toErrorMessage}. If you reach for this, the value must not
 * reach a log, a transcript, a UI, or a crash report.
 */
export function rawErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
