import { randomInt } from 'node:crypto';
import { ProviderError, type ProviderErrorKind } from '../types/provider.js';
import type { RetryPolicy } from '../types/retry-policy.js';
import { NETWORK_ERR_RE } from './regex-patterns.js';

/**
 * Upper bound for any Retry-After hint surfaced by a provider.
 *
 * The HTTP `Retry-After` header can carry either a delta-seconds
 * integer or an absolute HTTP-date. The latter can legitimately be
 * far in the future if the provider is asking us to back off for
 * minutes or hours. We never want to be stuck waiting that long —
 * the agent kernel has its own pacing and a multi-minute single
 * retry would freeze the user. 60 seconds is the conventional cap
 * (it matches what most providers document as the practical upper
 * bound for a single rate-limit window).
 */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * In-place attempts per canonical failure kind. Exhaustive by construction
 * (`Record<ProviderErrorKind, …>`) — adding a new kind refuses to compile
 * until it gets an attempt budget. Zero for request-shaped failures
 * (auth / invalid_request / context_overflow / content_filter): replaying
 * the same request can't succeed.
 */
const MAX_ATTEMPTS_BY_KIND: Record<ProviderErrorKind, number> = {
  rate_limit: 5,
  quota_exhausted: 0,
  stream_hang: 2, // proxy-level timeout — retrying 5x wastes ~40s before fallback kicks in
  overloaded: 3,
  server: 3,
  timeout: 2,
  network: 2,
  auth: 0,
  invalid_request: 0,
  context_overflow: 0,
  content_filter: 0,
  unknown: 0,
};

export class DefaultRetryPolicy implements RetryPolicy {
  shouldRetry(err: Error | ProviderError, attempt: number): boolean {
    if (err instanceof ProviderError) {
      if (!err.retryable) return false;
      return attempt < this.maxAttempts(err);
    }
    const msg = err.message ?? '';
    const isNetwork = NETWORK_ERR_RE.test(msg);
    if (isNetwork) return attempt < 2;
    return false;
  }

  maxAttempts(err: Error | ProviderError): number {
    if (err instanceof ProviderError) {
      return MAX_ATTEMPTS_BY_KIND[err.kind];
    }
    return 2;
  }

  /**
   * Compute the retry delay.
   *
   * Precedence:
   *   1. If `err` is a `ProviderError` with a populated
   *      `body.retryAfterMs`, honour it — clamped into
   *      [0, MAX_RETRY_AFTER_MS]. The provider told us exactly when
   *      to come back; we should listen.
   *   2. Otherwise fall through to the exponential-with-jitter
   *      schedule (`1000 * 2^attempt + jitter`, capped at 30s).
   *
   * `err` is optional for back-compat with the existing interface;
   * callers should pass it whenever available.
   */
  delayMs(attempt: number, err?: Error | ProviderError): number {
    const hint = retryAfterMsFromError(err);
    if (hint !== undefined) {
      // Server told us exactly when to come back. No jitter — the
      // server's clock is the authoritative source for "when"; adding
      // jitter here would either land us back inside the rate-limit
      // window or push us needlessly past it. We still clamp to the
      // 60s upper bound.
      return Math.max(0, Math.min(hint, MAX_RETRY_AFTER_MS));
    }
    const base = 1000;
    const exp = base * 2 ** attempt;
    // crypto.randomInt(min, max) is half-open: returns an integer in
    // [min, max). With (0, base) we get integers in [0, 1000), matching
    // the previous Math.random() * 1000 jitter range. Using crypto
    // (not Math.random) per the project's deterministic-source
    // convention (see docs/design-provider-health-gate.md).
    const jitter = randomInt(0, base);
    return Math.min(30_000, exp + jitter);
  }
}

/**
 * Extract a Retry-After hint in milliseconds from an error, if
 * present and well-formed. Returns `undefined` for missing, zero,
 * negative, or non-finite values so the caller falls through to the
 * exponential schedule.
 *
 * The field lives at `err.body.retryAfterMs` (ProviderErrorBody).
 * Providers populate this when they parse the upstream
 * `Retry-After` header (either as a delta-seconds integer or as an
 * absolute HTTP-date converted to ms-from-now).
 */
function retryAfterMsFromError(err: Error | ProviderError | undefined): number | undefined {
  if (!err || !(err instanceof ProviderError)) return undefined;
  const ms = err.body?.retryAfterMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  return ms;
}
