/**
 * Error text that crosses a process boundary — into an HTTP JSON body, a
 * WebSocket frame, a transcript row — is attacker-observable output, not a
 * developer log line.
 *
 * WS-066: the HQ server had a `sanitizeApiError` for exactly this and the
 * WebUI/SimpleUI servers did not, so the same class of error reached the
 * browser opaque on one surface and verbatim on the other. This module is the
 * single implementation both now use.
 *
 * Two levels, because the two surfaces have genuinely different needs:
 *
 *  - {@link sanitizeApiError} — opaque category only. For HTTP `/api/*` JSON
 *    bodies, which are same-origin reachable and the least authenticated
 *    surface. The detail stays server-side in the caller's log.
 *  - {@link scrubErrorDetail} — keeps the message (a local dev tool is much
 *    less useful without it) but strips embedded credentials and rewrites
 *    home-directory paths to `~`. For WebSocket payloads, which are token and
 *    Origin gated.
 *
 * @module security/error-sanitize
 */

import { homedir } from 'node:os';
import { DefaultSecretScrubber } from './secret-scrubber.js';

const scrubber = new DefaultSecretScrubber();

/** Longest error detail forwarded to a client; longer text is truncated. */
export const ERROR_DETAIL_MAX = 500;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

/**
 * Coerce a thrown value into a safe, opaque message for HTTP/JSON API
 * responses. Raw error strings (file paths, environment details, stack
 * fragments) are never forwarded to the browser — only a stable category.
 * The original error is logged server-side by the caller.
 */
export function sanitizeApiError(err: unknown): string {
  const lower = messageOf(err).toLowerCase();
  // Classify a few well-known shapes without echoing their text verbatim.
  if (lower.includes('enoent') || lower.includes('no such file')) {
    return 'resource not found';
  }
  if (lower.includes('eacces') || lower.includes('permission')) {
    return 'permission denied';
  }
  if (lower.includes('json') && (lower.includes('parse') || lower.includes('unexpected'))) {
    return 'malformed data';
  }
  // Default: a generic label — the detail stays server-side.
  return 'internal error';
}

/**
 * Keep an error message readable but remove what must never leave the host:
 * credentials the message quotes back (a provider echoing an `Authorization`
 * header, a connection string with an inline password) and the absolute home
 * directory, which leaks the OS account name.
 *
 * Use this where the detail has real diagnostic value and the channel is
 * authenticated; use {@link sanitizeApiError} otherwise.
 */
export function scrubErrorDetail(err: unknown): string {
  const out = scrubErrorText(messageOf(err));
  if (out.length <= ERROR_DETAIL_MAX) return out;
  let cut = ERROR_DETAIL_MAX - 1;
  // Do not strand the high half of a surrogate pair in front of the ellipsis.
  const last = out.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  return `${out.slice(0, cut)}…`;
}

/**
 * {@link scrubErrorDetail} for text that is already a string, and WITHOUT the
 * length cap — callers that maintain their own truncation contract (the
 * provider error body keeps 2 KB plus a `truncated`/`rawLength` pair) must not
 * have a second, silent cut applied underneath them.
 */
export function scrubErrorText(text: string): string {
  if (!text) return text;
  let out = scrubber.scrub(text);
  const home = safeHomedir();
  if (home && home.length > 2) {
    out = replaceAllCaseInsensitive(out, home, '~');
    // Windows paths reach us in both separator forms depending on whether the
    // producer went through `path.join` or a shell.
    const alt = home.includes('\\') ? home.replace(/\\/g, '/') : home.replace(/\//g, '\\');
    if (alt !== home) out = replaceAllCaseInsensitive(out, alt, '~');
  }
  return out;
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return '';
  }
}

/**
 * Windows paths are case-insensitive, so a message may spell the home
 * directory with different casing than `os.homedir()` reports. Matched on the
 * original text: lowercasing first shifts every later offset when the message
 * holds a character whose lowercase form is longer (Turkish `İ` → `i̇`), which
 * cut the replacement at the wrong place and left part of the path behind.
 */
function replaceAllCaseInsensitive(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack;
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return haystack.replace(pattern, () => replacement);
}
