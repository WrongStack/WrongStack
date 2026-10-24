/**
 * ChatGPT-backend (openai-codex) error details the generic parser cannot know.
 *
 * Classification itself is NOT here — the machine codes this backend shares
 * with the OpenAI API (`usage_not_included`, `server_is_overloaded`, …) are
 * taught to `classifyProviderError` once, for every wire. This module only
 * fills in what is specific to the ChatGPT backend: the quota headers every
 * failure carries, the reset time a `usage_limit_reached` body carries, and a
 * readable message for the two failures whose raw text does not say what the
 * user has to do.
 */

import type { ProviderError, ProviderErrorBody } from '@wrongstack/contracts/types';
import {
  type ProviderQuotaSnapshot,
  quotaResetInMs,
  recordProviderQuota,
} from '@wrongstack/core/quota';
import { type HeadersLike, parseProviderHttpError } from './error-parse.js';
import { isPlainObject } from './object-utils.js';
import { codexBlockingWindow, parseCodexRateLimitHeaders } from './openai-codex-rate-limits.js';

export type { HeadersLike } from './error-parse.js';

/** Same ceiling as core's prose reset hints (`MAX_RESET_HINT_MS`): one week. */
const MAX_BODY_RESET_MS = 7 * 24 * 60 * 60 * 1_000;

const USAGE_NOT_INCLUDED_MESSAGE =
  'This ChatGPT plan does not include Codex usage — upgrade the plan or use an OpenAI API-key provider instead.';
/**
 * Why the ChatGPT backend serves another model than the one asked for. The
 * official client attaches exactly this explanation to every server-model
 * mismatch (codex-rs core `maybe_warn_on_server_model_mismatch`).
 */
export const CODEX_REROUTE_REASON =
  'The account was flagged for potentially high-risk cyber activity, so the backend routed ' +
  'this request to a fallback model. Apply for trusted access at https://chatgpt.com/cyber ' +
  '(details: https://developers.openai.com/codex/concepts/cyber-safety).';
const CLOUDFLARE_BLOCKED_MESSAGE =
  'Access blocked by Cloudflare. This usually happens when connecting from a restricted region.';

function errorObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return undefined;
    const error = parsed['error'];
    return isPlainObject(error) ? error : undefined;
  } catch {
    // Truncated or non-JSON bodies carry no structured reset.
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Milliseconds until a `usage_limit_reached` body says the plan reopens.
 *
 * The `x-codex-*-reset-at` headers are the primary source; this is the fallback
 * for a 429 that arrives without them. `resets_at` is epoch SECONDS (the
 * official client parses it with `from_timestamp(seconds, 0)`);
 * `resets_in_seconds` is the relative form older backends sent. Clamped like
 * every other body-derived hint so a corrupt value cannot park a model for
 * longer than a week.
 */
export function codexUsageLimitResetMs(
  raw: string | undefined,
  now: number = Date.now(),
): number | undefined {
  const error = errorObject(raw);
  if (error?.['type'] !== 'usage_limit_reached') return undefined;
  const resetsAt = finiteNumber(error['resets_at']);
  const resetsIn = finiteNumber(error['resets_in_seconds']);
  const ms =
    resetsAt !== undefined
      ? resetsAt * 1000 - now
      : resetsIn !== undefined
        ? resetsIn * 1000
        : undefined;
  if (ms === undefined || ms <= 0) return undefined;
  return Math.min(Math.round(ms), MAX_BODY_RESET_MS);
}

/**
 * A readable replacement message, when the backend's own says nothing useful.
 *
 * `usage_not_included` often arrives with no message at all, and a Cloudflare
 * region block is an HTML page whose text is noise; both leave the user with
 * a bare status line and no idea what to do.
 */
export function codexErrorMessage(status: number, body: ProviderErrorBody): string | undefined {
  const codes = [body.type, body.code];
  if (codes.includes('usage_not_included') && !body.message?.trim()) {
    return USAGE_NOT_INCLUDED_MESSAGE;
  }
  const raw = body.raw ?? '';
  if (status === 403 && raw.includes('Cloudflare') && raw.includes('blocked')) {
    return CLOUDFLARE_BLOCKED_MESSAGE;
  }
  return undefined;
}

/**
 * Translate a ChatGPT-backend HTTP failure, and mine the quota headers off it.
 *
 * A 429 is the response that matters most here: it carries the quota headers
 * like any other, and its `x-codex-*-reset-at` is an EXACT epoch for when the
 * window reopens. Without it the waiting room falls back to exponential backoff
 * and re-probes a five-hour (or weekly) cap every few minutes — every probe a
 * request against an account that has none left. With it, the model parks
 * until the published reset and wakes once. The WebSocket transport's wrapped
 * `{"type":"error","status":…,"headers":…}` frames come through here too.
 */
export function translateCodexHttpError(
  providerId: string,
  status: number,
  text: string,
  headers: HeadersLike | undefined,
): ProviderError {
  const error = parseProviderHttpError(providerId, status, text, headers);
  if (error.body) {
    const message = codexErrorMessage(status, error.body);
    if (message !== undefined) error.body.message = message;
  }

  const snapshots = headers ? parseCodexRateLimitHeaders(headers) : [];
  if (snapshots.length > 0) recordProviderQuota(providerId, snapshots);

  if (!error.body || error.body.retryAfterMs !== undefined) return error;
  // Headers first: they carry the exact window state. The body's own
  // `resets_at` covers a 429 that arrived without them.
  const resetIn = codexResetHintMs(snapshots) ?? codexUsageLimitResetMs(text);
  if (resetIn !== undefined) error.body.retryAfterMs = resetIn;
  return error;
}

/**
 * When the request that just hit a limit can go through again.
 *
 * A meter stays blocked until its LAST exhausted window reopens — a 5h window
 * resetting sooner does not help while the weekly one is still full. The meter
 * the backend named (`x-codex-active-limit`, marked with `reachedWindowId`)
 * decides; when none was named, the meter that unblocks first does, so an
 * unnamed limit costs at most one extra probe and never an over-long park. A
 * window with room left is never waited on: parking a model until a 60% window
 * resets would be a self-inflicted outage.
 */
function codexResetHintMs(snapshots: readonly ProviderQuotaSnapshot[]): number | undefined {
  const named = snapshots.find((snapshot) => snapshot.reachedWindowId !== undefined);
  if (named) return quotaResetInMs(codexBlockingWindow(named));
  let soonest: number | undefined;
  for (const snapshot of snapshots) {
    const ms = quotaResetInMs(codexBlockingWindow(snapshot));
    if (ms !== undefined && (soonest === undefined || ms < soonest)) soonest = ms;
  }
  return soonest;
}

/**
 * Does this 400 blame a replayed reasoning item?
 *
 * The Responses API's reasoning validation errors all name the item type or a
 * `rs_`-prefixed id ("Item 'rs_…' of type 'reasoning' was provided without its
 * required following item"). Matching narrowly matters: a 400 for a malformed
 * tool schema must keep surfacing as an error, not be silently retried with
 * reasoning stripped and then fail again with a confusing second message.
 */
export function isReasoningReplayRejection(err: ProviderError): boolean {
  const message = `${err.message} ${JSON.stringify(err.body ?? '')}`;
  return /reasoning item|item\s+['"]?rs_[\w-]+|required following item/i.test(message);
}
