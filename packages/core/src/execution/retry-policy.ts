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
 * Retries a single model gets before the turn moves on to the next entry in
 * the fallback chain.
 *
 * One number for every recoverable failure kind, on purpose. The per-kind
 * budgets used to range from 2 (timeout, network, stream_hang) to 5
 * (rate_limit), which made "how long until we try another model?" depend on
 * which error came back: a rate-limited model could spend five backoff waits —
 * each honouring a `Retry-After` up to 60s — before the cross-model fallback
 * engine, which only engages once in-place retries are exhausted, got its
 * turn, while a timeout gave up after two. The contract is now uniform and
 * predictable across every surface that runs the agent loop (leader, host
 * subagents, Chimera reviewers, SDD workers — they all resolve this one
 * policy from the container): try the model {@link MODEL_RETRIES} times, then
 * fail over.
 *
 * Exhaustive by construction (`Record<ProviderErrorKind, …>`) — adding a new
 * kind refuses to compile until it gets an attempt budget.
 *
 * Zero means "do not replay this request against this model":
 * - request-shaped failures (auth / invalid_request / context_overflow /
 *   content_filter) would fail identically on every attempt;
 * - `quota_exhausted` is a depleted account or plan, not a transient burst, so
 *   the route is done until it resets — retrying only delays the hop, and the
 *   kind IS fallback-worthy, so another provider gets tried immediately.
 */
export const MODEL_RETRIES = 3;

const MAX_ATTEMPTS_BY_KIND: Record<ProviderErrorKind, number> = {
  rate_limit: MODEL_RETRIES,
  overloaded: MODEL_RETRIES,
  server: MODEL_RETRIES,
  timeout: MODEL_RETRIES,
  network: MODEL_RETRIES,
  stream_hang: MODEL_RETRIES,
  quota_exhausted: 0,
  auth: 0,
  invalid_request: 0,
  context_overflow: 0,
  content_filter: 0,
  unknown: 0,
};

/**
 * A `Retry-After` hint at or above this bound means the provider is not asking
 * for a short breather — it is telling us the route is unavailable for a while.
 *
 * `rate_limit` gets 5 in-place attempts, each of which honours the hint up to
 * `MAX_RETRY_AFTER_MS`. On a hard limit (a plan/daily/weekly cap that answers
 * 429 with a long `Retry-After`) that spent up to five minutes sleeping on a
 * route that had already said "not now" — all of it BEFORE the cross-model
 * fallback engine, which only engages once in-place retries are exhausted, got
 * to try a healthy model that was sitting right there in the chain.
 *
 * Above this bound we stop retrying in place immediately, which hands the error
 * straight to the fallback engine. Nothing is lost when no fallback exists:
 * the status tracker quarantines the pair for the hint's duration either way,
 * and the caller sees the same 429 minutes sooner. Short hints (a burst-rate
 * window) still retry in place as before.
 */
const FAILOVER_RETRY_AFTER_MS = 15_000;

/**
 * First-retry wait for the exponential schedule, in ms.
 *
 * The schedule is `RETRY_BASE_DELAY_MS * 2^attempt + jitter`, so with a
 * base of 4s and {@link MODEL_RETRIES} attempts a struggling route waits
 * 4s → 8s → 16s before the turn hands over to the fallback chain.
 *
 * It used to be 1000 (1s → 2s → 4s). That schedule was too eager for the
 * failure it actually fires on: a provider that just refused a request
 * because of a network blip, an overload, or a burst-rate window is
 * almost never healthy again 1 second later, so the first two retries
 * mostly bought another two failures — three requests hammered out inside
 * ~7 seconds — and then reported the same error anyway. Starting at 4s
 * gives the far side a realistic window to recover, and still exhausts
 * all three in-place attempts in well under half a minute.
 *
 * NOTE: this is only the *fallback* schedule. A provider that sends a
 * `Retry-After` still wins outright (see {@link DefaultRetryPolicy.delayMs}).
 */
export const RETRY_BASE_DELAY_MS = 4_000;

/**
 * Width of the uniform jitter added to every exponential wait, in ms.
 *
 * Deliberately decoupled from {@link RETRY_BASE_DELAY_MS}: jitter exists to
 * de-synchronise concurrent agents retrying the same route, and one second
 * of spread is plenty for that. Scaling it with the base would have turned
 * the first retry into a 4–8s coin flip for no added benefit.
 */
export const RETRY_JITTER_MS = 1_000;

/** Ceiling for a single exponential wait, in ms. */
const MAX_BACKOFF_MS = 30_000;

export class DefaultRetryPolicy implements RetryPolicy {
  shouldRetry(err: Error | ProviderError, attempt: number): boolean {
    const isProviderErr = err instanceof ProviderError || ProviderError.isProviderError(err);
    if (isProviderErr) {
      if (!(err as ProviderError).retryable) return false;
      const hint = retryAfterMsFromError(err);
      if (hint !== undefined && hint >= FAILOVER_RETRY_AFTER_MS) return false;
      return attempt < this.maxAttempts(err);
    }
    const msg = err.message ?? '';
    const isNetwork = NETWORK_ERR_RE.test(msg);
    if (isNetwork) return attempt < 2;
    return false;
  }

  maxAttempts(err: Error | ProviderError): number {
    const isProviderErr = err instanceof ProviderError || ProviderError.isProviderError(err);
    if (isProviderErr) {
      return MAX_ATTEMPTS_BY_KIND[(err as ProviderError).kind];
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
   *      schedule (`RETRY_BASE_DELAY_MS * 2^attempt + jitter`, capped
   *      at 30s) — 4s → 8s → 16s for the three in-place attempts.
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
    const exp = RETRY_BASE_DELAY_MS * 2 ** attempt;
    // crypto.randomInt(min, max) is half-open: returns an integer in
    // [min, max). With (0, RETRY_JITTER_MS) we get integers in [0, 1000),
    // matching the previous Math.random() * 1000 jitter range. Using crypto
    // (not Math.random) per the project's deterministic-source
    // convention (see docs/design-provider-health-gate.md).
    const jitter = randomInt(0, RETRY_JITTER_MS);
    return Math.min(MAX_BACKOFF_MS, exp + jitter);
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
  if (!err) return undefined;
  const isProviderErr = err instanceof ProviderError || ProviderError.isProviderError(err);
  if (!isProviderErr) return undefined;
  const ms = (err as ProviderError).body?.retryAfterMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  return ms;
}
