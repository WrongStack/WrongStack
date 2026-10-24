import type { ProviderErrorBody } from '@wrongstack/contracts/types';
import {
  classifyProviderError,
  isRetryableKind,
  isSafetyPolicyCode,
  ProviderError,
  SAFETY_POLICY_GUIDANCE,
} from '@wrongstack/contracts/types';
import { scrubErrorText } from '@wrongstack/core/security';
import { isPlainObject } from './object-utils.js';

/**
 * Provider HTTP error bodies come in three or four shapes depending on
 * vendor. Rather than dump the raw JSON into the error message (which is
 * what was shipped to the user log before this module existed), we parse
 * out the fields we care about — `type`, `message`, `requestId` — and put
 * them on `ProviderError.body` for `describe()` and downstream rendering.
 *
 * The function is intentionally tolerant: anything we can't parse falls
 * back to a truncated raw string, never throws.
 */
export function parseProviderHttpError(
  providerId: string,
  status: number,
  rawText: string,
  headers?: HeadersLike,
): ProviderError {
  const body = parseProviderErrorBody(rawText);
  // Prefer an explicit Retry-After HTTP header (the authoritative wire signal).
  const headerHint = retryAfterMsFromHeaders(headers);
  if (headerHint !== undefined) body.retryAfterMs = headerHint;
  // When no header was present, try to extract a reset time from the body
  // message text. Many Chinese providers (Z.AI, MiniMax, Moonshot) embed
  // "Your limit will reset at YYYY-MM-DD HH:mm:ss" in the JSON body instead
  // of sending an HTTP Retry-After header.
  if (body.retryAfterMs === undefined) {
    const bodyHint = retryAfterMsFromBody(body);
    if (bodyHint !== undefined) body.retryAfterMs = bodyHint;
  }
  const kind = classifyProviderError(status, body);
  const message = safetyRefusalMessage(body) ?? `${providerId} HTTP ${status}`;
  // WS-060: scrub LAST, so classification and Retry-After extraction above
  // still see the provider's original text. The body is not an internal log
  // line — `describe()` renders it to the terminal, the session writer puts it
  // in the JSONL transcript, and HQ forwards it to any connected browser. A
  // gateway that echoes the `Authorization` header back in its 401 body, or a
  // proxy that quotes the upstream URL with an inline key, would otherwise
  // persist that credential everywhere the error travels.
  return new ProviderError(message, status, isRetryableKind(kind), providerId, {
    body: scrubProviderErrorBody(body),
    kind,
  });
}

/** Vendor error types that name a client-side failure explicitly (Anthropic's set). */
const STREAM_ERROR_TYPE_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
};

/**
 * Build a ProviderError from an error envelope delivered INSIDE a 200 stream
 * (Anthropic `event: error`, OpenRouter/OpenAI-compatible `{"error":{…}}`
 * chunks). There is no HTTP status to classify on, so one is derived from the
 * payload: a numeric `code` in 4xx/5xx wins, then the vendor `type`
 * (`overloaded_error` → 529, `rate_limit_error` → 429). Anything else is first
 * classified as a 400 — so context-overflow / content-filter / quota prose
 * still lands on its non-retryable kind — and only falls back to a retryable
 * 500 when that yields a bare `invalid_request`: a mid-stream failure after
 * the request was already accepted is an upstream fault, not a bad request.
 */
export function providerErrorFromStreamPayload(
  providerId: string,
  payload: Record<string, unknown>,
): ProviderError {
  const raw = JSON.stringify(payload);
  const body = parseProviderErrorBody(raw);
  const err = isPlainObject(payload['error']) ? payload['error'] : payload;
  const numericCode = Number(err['code'] ?? err['status']);
  let status: number;
  if (Number.isInteger(numericCode) && numericCode >= 400 && numericCode <= 599) {
    status = numericCode;
  } else if (body.type === 'overloaded_error') {
    status = 529;
  } else if (body.type === 'rate_limit_error') {
    status = 429;
  } else if (/^(api_error|server_error|internal_error)$/.test(body.type ?? '')) {
    status = 500;
  } else if (body.type !== undefined && Object.hasOwn(STREAM_ERROR_TYPE_STATUS, body.type)) {
    // `Object.hasOwn`, not a `!== undefined` check: `body.type` is a string the
    // provider chose, and bracket access on an Object.prototype key
    // (`toString`, `valueOf`, `constructor`, `__proto__`) returns the inherited
    // member rather than undefined — the guard passed and `status` became a
    // function, so the error was classified `unknown` and made non-retryable
    // instead of a retryable 500. Same convention as `kindFromErrorCode`
    // (core/types/provider-error-codes.ts) for the same untrusted key.
    status = STREAM_ERROR_TYPE_STATUS[body.type] as number;
  } else if (isSafetyPolicyCode(body.code)) {
    // A classifier refusal is the provider's verdict on the content, not an
    // upstream fault: the derived 500 below would retry it into more flags.
    status = 400;
  } else {
    status = classifyProviderError(400, body) === 'invalid_request' ? 500 : 400;
  }
  if (body.retryAfterMs === undefined) {
    const hint = retryAfterMsFromBody(body);
    if (hint !== undefined) body.retryAfterMs = hint;
  }
  const kind = classifyProviderError(status, body);
  return new ProviderError(
    safetyRefusalMessage(body) ??
      `${providerId} stream error${body.message ? `: ${scrubErrorText(body.message)}` : ''}`,
    status,
    isRetryableKind(kind),
    providerId,
    { body: scrubProviderErrorBody(body), kind },
  );
}

/**
 * The message for a safety-classifier refusal (`cyber_policy`, …): the
 * provider's own text plus {@link SAFETY_POLICY_GUIDANCE}. Undefined for any
 * other failure.
 */
export function safetyRefusalMessage(body: ProviderErrorBody): string | undefined {
  if (!isSafetyPolicyCode(body.code)) return undefined;
  const own = body.message?.trim();
  return own ? `${scrubErrorText(own)}\n\n${SAFETY_POLICY_GUIDANCE}` : SAFETY_POLICY_GUIDANCE;
}

/**
 * Redact credentials from the free-text fields of a parsed provider error.
 * `retryAfterMs` and `rawLength` are numeric metadata and pass through; `type`
 * is a vendor category, but it is provider-controlled text like the rest, so
 * it goes through the scrubber too.
 */
export function scrubProviderErrorBody(body: ProviderErrorBody): ProviderErrorBody {
  const out: ProviderErrorBody = { ...body };
  if (out.raw !== undefined) out.raw = scrubErrorText(out.raw);
  if (out.message !== undefined) out.message = scrubErrorText(out.message);
  if (out.type !== undefined) out.type = scrubErrorText(out.type);
  if (out.code !== undefined) out.code = scrubErrorText(out.code);
  return out;
}

/** Structural subset of the Fetch `Headers` interface, easy to fake in tests. */
export interface HeadersLike {
  get(name: string): string | null;
}

/**
 * Parse a Retry-After hint from HTTP response headers into milliseconds.
 *
 * Handles the three shapes seen in the wild:
 *  - `retry-after-ms: 1500` — milliseconds (Anthropic, some OpenAI-compatibles)
 *  - `retry-after: 12` — delta-seconds (RFC 9110)
 *  - `retry-after: Wed, 21 Oct 2026 07:28:00 GMT` — HTTP-date
 *
 * Returns `undefined` for missing/unparseable/non-positive values so callers
 * fall through to their exponential backoff schedule.
 */
export function retryAfterMsFromHeaders(headers?: HeadersLike): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get('retry-after-ms');
  if (ms) {
    const n = Number(ms);
    if (Number.isFinite(n) && n > 0) return Math.max(1, Math.round(n));
  }
  const ra = headers.get('retry-after');
  if (!ra) return undefined;
  const secs = Number(ra);
  if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
  const date = Date.parse(ra);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    if (delta > 0) return delta;
  }
  return undefined;
}

const RAW_TRUNCATE_AT = 2000;

export function parseProviderErrorBody(rawText: string): ProviderErrorBody {
  const raw = rawText.slice(0, RAW_TRUNCATE_AT);
  // Surface truncation so downstream renderers (CLI error formatter, log
  // exporter) can show a "(truncated, N more bytes)" suffix instead of
  // silently dropping the rest of the provider's error tail.
  const body: ProviderErrorBody =
    rawText.length > RAW_TRUNCATE_AT
      ? { raw, truncated: true, rawLength: rawText.length }
      : { raw };
  if (!rawText.trim()) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return body;
  }
  if (!isPlainObject(parsed)) return body;

  // Anthropic / MiniMax / Kimi: { type: "error", error: { type, message }, request_id }
  // OpenAI / OpenAI-compatible: { error: { message, type, code, param } }
  // Google: { error: { code, message, status } }
  function extractDetail(val: unknown): string | undefined {
    const str = stringOf(val);
    if (str) return str;
    if (Array.isArray(val) && val.length > 0) {
      const first = val[0];
      if (isPlainObject(first) && typeof first['msg'] === 'string') {
        return stringOf(first['msg']);
      }
      if (typeof first === 'string') return stringOf(first);
    }
    return undefined;
  }

  const responseField = parsed['response'];
  const responseError = isPlainObject(responseField) ? responseField['error'] : undefined;
  const statusDetails = isPlainObject(responseField) ? responseField['status_details'] : undefined;
  const statusDetailsError = isPlainObject(statusDetails) ? statusDetails['error'] : undefined;
  const errField = parsed['error'] ?? responseError ?? statusDetailsError;
  if (isPlainObject(errField)) {
    const t =
      stringOf(errField['type']) ?? stringOf(errField['status']) ?? stringOf(errField['code']);
    const m = stringOf(errField['message']) ?? extractDetail(errField['detail']);
    const code = stringOf(errField['code']);
    if (t) body.type = t;
    if (code) body.code = code;
    if (m) body.message = m;
  } else if (typeof errField === 'string') {
    body.message = errField;
  }
  // Top-level fields some providers use directly
  if (!body.type) {
    const t = stringOf(parsed['type']);
    const code = stringOf(parsed['code']);
    if (t && t !== 'error') body.type = t;
    else if (code) body.type = code;
  }
  if (!body.message) {
    const m = stringOf(parsed['message']) ?? extractDetail(parsed['detail']);
    if (m) body.message = m;
  }
  // MiniMax native envelope: { base_resp: { status_code, status_msg } }.
  // Only fills what the vendor-neutral shapes above left empty.
  const miniMax = miniMaxBaseRespError(parsed['base_resp']);
  if (miniMax) {
    if (!body.type && miniMax.type) body.type = miniMax.type;
    if (!body.message) body.message = miniMax.message;
  }

  // request_id (Anthropic), id (some compatible providers)
  const reqId =
    stringOf(parsed['request_id']) ??
    stringOf(parsed['requestId']) ??
    stringOf(parsed['id']) ??
    (isPlainObject(responseField) ? stringOf(responseField['id']) : undefined);
  if (reqId) body.requestId = reqId;

  return body;
}

/**
 * Extract a retry-after duration from the provider's error body message text.
 * Called when no HTTP Retry-After header was present. Many providers,
 * particularly in the Chinese ecosystem (Z.AI, MiniMax, Moonshot), embed
 * the reset time in the JSON body message instead of sending a standard
 * `retry-after` header.
 *
 * Handles three patterns:
 *  - "Your limit will reset at YYYY-MM-DD HH:mm:ss" — absolute date-time
 *  - "Usage limit reached for X hour(s)" — relative duration from hours
 *  - "retry after X seconds" / "retry_after X" — relative seconds
 *
 * Returns `undefined` when no well-formed hint is found so callers fall
 * through to their exponential backoff schedule. Never throws.
 */
export function retryAfterMsFromBody(body: ProviderErrorBody): number | undefined {
  const text = [body.message, body.raw].filter(Boolean).join('\n');
  if (!text) return undefined;

  // 1. Absolute date-time: "...reset at YYYY-MM-DD HH:mm:ss..."
  //    Many Chinese providers (Z.AI, Moonshot) embed the reset time in the
  //    body instead of sending an HTTP Retry-After header. The timestamp
  //    is timezone-naive. parseTzAwareDelta computes both UTC and local-time
  //    interpretations and returns the smallest positive delta (i.e.
  //    min(utcDelta, localDelta)) — see its doc comment for the rationale.
  const dateTimeRe =
    /(?:reset|renew|available)(?:s|ed|s)?\s*(?:at|on)\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})[T\s](\d{1,2}:\d{2}(?::\d{2})?)/i;
  const dateMatch = dateTimeRe.exec(text);
  if (dateMatch) {
    // The matcher accepts 1-digit month/day/hour; Date.parse reads only the
    // zero-padded ISO form, so pad before handing it over.
    const pad = (part: string | undefined) => (part ?? '').padStart(2, '0');
    const [year, month, day] = (dateMatch[1] ?? '').split(/[-/]/);
    const [hour, minute, second] = (dateMatch[2] ?? '').split(':');
    const base = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${minute}:${pad(second)}`;
    const delta = parseTzAwareDelta(base);
    if (delta !== undefined) return delta;
  }

  // 2. Relative hours: "...reached for X hour(s)..."
  const hoursRe =
    /(?:usage|quota|rate|limit).{0,20}(?:reached|exceeded|exhausted).{0,20}(?:for|every|per)\s*(\d+)\s*hours?/i;
  const hoursMatch = hoursRe.exec(text);
  if (hoursMatch) {
    const hours = Number.parseInt(hoursMatch[1] ?? '', 10);
    if (hours >= 1 && hours <= 24) return hours * 3_600_000;
  }

  // 3. Relative duration: "retry after X seconds/minutes/hours", "retry_after X",
  //    "try again in X seconds", "please retry in X minutes", "back in X seconds/minutes", "wait X ms"
  const retryRe =
    /(?:retry[_\s-]*(?:after|in)|(?:try|retry|back|wait)\s*(?:again)?\s*(?:in|for|after)?)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|milliseconds?|millis?|msecs?|ms|minutes?|mins?|m|seconds?|secs?|s)?(?!\w)/i;
  const retryMatch = retryRe.exec(text);
  if (retryMatch) {
    const num = Number.parseFloat(retryMatch[1] ?? '');
    if (Number.isFinite(num) && num > 0) {
      const unit = (retryMatch[2] ?? '').toLowerCase();
      if (unit.startsWith('h')) {
        if (num <= 24) return Math.round(num * 3_600_000);
      } else if (unit.startsWith('ms') || unit.startsWith('milli')) {
        return Math.round(num);
      } else if (unit.startsWith('m')) {
        if (num <= 180) return Math.round(num * 60_000);
      } else {
        // seconds (default when unit is seconds, secs, s, or omitted)
        return Math.round(num * 1_000);
      }
    }
  }

  // 3b. Compound Go duration after a retry lead-in: "Please try again in
  //     6h12m", "…in 1m30s", "…in 6h12m0.5s" (OpenAI and OpenAI-compatibles).
  //     Pattern 3 reads one number + one unit, so these never match it.
  const compoundRetryRe =
    /(?:retry[_\s-]*(?:after|in)|try\s*again\s*in)\s*[:=]?\s*((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)(?![a-z\d]|\.\d)/i;
  const compoundRetryMatch = compoundRetryRe.exec(text);
  if (compoundRetryMatch) {
    let total = 0;
    for (const part of (compoundRetryMatch[1] ?? '').matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gi)) {
      const unit = (part[2] ?? '').toLowerCase();
      const scale = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
      total += Number.parseFloat(part[1] ?? '') * scale;
    }
    if (total > 0 && total <= 24 * 3_600_000) return Math.round(total);
  }

  // 4. Compound duration after a "reset" verb: "quota will reset after 2h7m23s",
  //    "resets in 5m30s". Google's Cloud Code (Antigravity) phrases an
  //    exhausted plan exactly this way and sends no Retry-After header, so
  //    without this the waiting room has no reset time and falls back to a
  //    generic backoff against a window that is hours wide.
  //
  //    Deliberately LAST: a message that also states an explicit "retry in Ns"
  //    is honouring the provider's own instruction, and pattern 3 should keep
  //    winning that case.
  const compoundRe =
    /(?:reset|resets|renew|renews|available)\s*(?:after|in)\s*(?=\d)(\d+h)?(\d+m(?!s))?(\d+s)?(\d+ms)?/i;
  const compoundMatch = compoundRe.exec(text);
  if (compoundMatch) {
    const hours = Number.parseInt(compoundMatch[1] ?? '0', 10) || 0;
    const minutes = Number.parseInt(compoundMatch[2] ?? '0', 10) || 0;
    const seconds = Number.parseInt(compoundMatch[3] ?? '0', 10) || 0;
    const milliseconds = Number.parseInt(compoundMatch[4] ?? '0', 10) || 0;
    const total = hours * 3_600_000 + minutes * 60_000 + seconds * 1_000 + milliseconds;
    // A stated reset of zero is a burst/RPM throttle, not a plan window. It is
    // real information — but the right response is the retry policy's own short
    // backoff, so report "no hint" rather than a 0ms wait that would read as
    // "retry immediately, forever".
    if (total > 0 && total <= 24 * 3_600_000) return total;
  }

  return undefined;
}

/**
 * MiniMax status codes (platform.minimax.io — Error Codes) mapped onto the
 * vendor error types the classifier already understands. Codes absent here
 * keep their message only: `1008 insufficient balance` and `2056 usage limit
 * exceeded` classify as quota from their text, and server-side codes
 * (1000/1001/1024/1033) take their kind from the HTTP status.
 */
const MINIMAX_STATUS_TYPE: Record<number, string> = {
  1002: 'rate_limit_error', // rate limit (RPM)
  1039: 'rate_limit_error', // token limit (TPM)
  1041: 'rate_limit_error', // connection limit
  2045: 'rate_limit_error', // rate growth limit
  1004: 'authentication_error',
  2049: 'authentication_error', // invalid API key
  1026: 'content_filter', // input flagged
  1027: 'content_filter', // output flagged
  2013: 'invalid_request_error',
};

/**
 * Read a MiniMax `base_resp` envelope. Returns undefined for a missing one or
 * a success (`status_code: 0`). The code is appended to the message so the
 * rendered error carries it the same way MiniMax's Anthropic surface does
 * (`usage limit exceeded (2056)`).
 */
export function miniMaxBaseRespError(
  value: unknown,
): { code: number; type?: string | undefined; message: string } | undefined {
  if (!isPlainObject(value)) return undefined;
  const code = Number(value['status_code']);
  if (!Number.isInteger(code) || code === 0) return undefined;
  const msg = stringOf(value['status_msg']) ?? 'MiniMax error';
  return { code, type: MINIMAX_STATUS_TYPE[code], message: `${msg} (${code})` };
}

function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Parse a timezone-naive date-time string (e.g. `2026-07-24T15:00:00`)
 * into a positive ms-delta from now. Returns `undefined` when no
 * interpretation yields a future timestamp.
 *
 * Strategy: compute both UTC and local-time interpretations and return
 * the **smallest** positive delta. Rate-limit reset timestamps are always
 * in the near future (seconds to minutes), so the correct interpretation
 * yields a smaller delta than the wrong one.
 *
 * Why not UTC-first-and-return: a Beijing-time (UTC+8) stamp of `20:30`
 * parsed as UTC on a UTC machine gives +8.5 h — but the actual reset is
 * 30 min away (12:30 UTC). The UTC-first approach returns the overshoot
 * immediately and never tries local. On a UTC+8 machine the local
 * interpretation recovers the correct 30 min, but only if the function
 * gets there. Taking the minimum of both positive deltas picks the
 * closest interpretation in every case:
 *
 *   Machine TZ | UTC δ  | Local δ | min → returned
 *   -----------+--------+---------+----------------
 *   UTC        | +8.5 h | +8.5 h  | 8.5 h (same — clamped downstream)
 *   UTC+8      | +8.5 h | +30 min | 30 min ← correct
 *
 * On a UTC machine both interpretations are identical, so the overshoot
 * persists — but `DefaultRetryPolicy.delayMs` clamps to 60 s and the
 * status tracker should apply its own cap (currently a separate gap).
 */
function parseTzAwareDelta(base: string): number | undefined {
  // Normalise date separators: Z.AI uses `2026-07-24` but some providers
  // use `2026/07/24`. ISO 8601 requires hyphens.
  const iso = base.replace(/\//g, '-');
  const now = Date.now();

  let best: number | undefined;

  // UTC interpretation.
  const utcMs = Date.parse(`${iso}Z`);
  if (!Number.isNaN(utcMs)) {
    const delta = utcMs - now;
    if (delta > 0) best = delta;
  }

  // Local-time interpretation — prefer the smaller positive delta.
  const localMs = Date.parse(iso);
  if (!Number.isNaN(localMs)) {
    const delta = localMs - now;
    if (delta > 0 && (best === undefined || delta < best)) best = delta;
  }

  return best;
}
