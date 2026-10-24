/**
 * Failure accounting and the failure-side state machine for
 * ProviderModelStatusTracker.recordFailure. Split out of
 * provider-status-tracker.ts; the tracker owns emission and fan-out.
 */
import {
  MAX_RESET_HINT_MS,
  type ProviderErrorKind,
  parseResetHintMs,
} from '@wrongstack/contracts/types/provider';
import type { ProviderFailureMeta } from '@wrongstack/contracts/types/provider-status';
import {
  type ErrorHistoryEntry,
  type MutableProviderModelStatus,
  NON_QUOTA_HINT_CAP_FACTOR,
  type ProviderModelState,
  type ProviderStatusTrackerConfig,
} from './provider-status-tracker-types.js';

export type { ProviderFailureMeta };

/** Bump the per-pair failure counters and last-error fields. */
export function countFailure(
  s: MutableProviderModelStatus,
  kind: ProviderErrorKind,
  status: number,
  message: string,
  meta: ProviderFailureMeta | undefined,
  now: number,
): void {
  s.consecutiveFailures += 1;
  s.totalFailures += 1;
  s.consecutiveSuccesses = 0;
  s.lastFailureAt = now;
  s.lastErrorKind = kind;
  s.lastErrorMessage = message;
  s.lastErrorStatus = status;
  if (meta?.sessionId) s.lastSessionId = meta.sessionId;
  if (meta?.agentId) s.lastAgentId = meta.agentId;
  if (s.firstFailureAt === null) s.firstFailureAt = now;

  // Per-kind counters
  switch (kind) {
    case 'rate_limit':
    case 'quota_exhausted':
      s.rateLimitHits += 1;
      break;
    case 'overloaded':
      s.overloadedHits += 1;
      break;
    case 'server':
    case 'stream_hang':
      s.serverErrors += 1;
      break;
    default:
      s.otherErrors += 1;
  }
}

/**
 * Effective wait-room hint: an explicit structured Retry-After wins;
 * otherwise, for quota/rate-limit failures, parse the provider's prose
 * reset hint ("try again in 6h12m", "resets at <ISO>") so weekly caps
 * hold until their real reset instead of the fixed default block.
 */
export function effectiveRetryAfterMs(
  kind: ProviderErrorKind,
  quotaExhausted: boolean,
  message: string,
  now: number,
  retryAfterMs: number | undefined,
  blockDurationMs: number,
): number | undefined {
  const proseHintMs =
    quotaExhausted || kind === 'rate_limit' ? parseResetHintMs(message, now) : undefined;
  const rawHintMs = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : proseHintMs;
  // For NON-quota kinds the hint only extends the transient cooldown, and
  // only up to a small multiple of the base block: providers quote the
  // plan/weekly reset horizon on ordinary burst 429s, and honoring it
  // verbatim parked models for hours (the "stuck in the waiting room"
  // regression). Quota kinds keep the full hint — it is the actual reset.
  return rawHintMs && rawHintMs > 0
    ? quotaExhausted
      ? // Quota keeps the provider-published reset, but a corrupt or
        // absurd structured Retry-After still cannot park a model
        // beyond the prose-hint maximum.
        Math.min(rawHintMs, MAX_RESET_HINT_MS)
      : Math.min(rawHintMs, blockDurationMs * NON_QUOTA_HINT_CAP_FACTOR)
    : undefined;
}

/** Push error history (newest first, capped). */
export function pushErrorHistory(
  s: MutableProviderModelStatus,
  entry: ErrorHistoryEntry,
  maxErrorHistory: number,
): void {
  s.recentErrors.unshift(Object.freeze(entry));
  if (s.recentErrors.length > maxErrorHistory) {
    s.recentErrors = s.recentErrors.slice(0, maxErrorHistory);
  }
}

/**
 * Compute the state a failure moves the pair to. Mutates the expiry and the
 * quota-block streak; the caller applies the state and emits the change.
 */
export function failureTransition(
  s: MutableProviderModelStatus,
  cfg: Required<ProviderStatusTrackerConfig>,
  flags: { quotaExhausted: boolean; endpointUnreachable: boolean },
  now: number,
  retryAfterMs: number | undefined,
  quotaBlockDurationForStreak: (streak: number) => number,
): { newState: ProviderModelState; reason: string } {
  const { quotaExhausted, endpointUnreachable } = flags;
  let newState: ProviderModelState = s.state;
  let reason = '';

  if (quotaExhausted) {
    newState = 'blocked';
    reason = 'quota_exhausted';
    // Repeated quota blocks escalate: block expiry → available again →
    // quota-exhausted again means the reset did not actually free budget,
    // so back off progressively (15 min → 30 min → capped at 1 h) instead
    // of re-probing at the same interval forever.
    s.quotaBlockStreak += 1;
    s.stateExpiresAt = now + quotaBlockDurationForStreak(s.quotaBlockStreak);
  } else if (endpointUnreachable) {
    newState = 'blocked';
    reason = 'endpoint_unreachable';
    s.stateExpiresAt = now + cfg.quotaBlockDurationMs;
  }

  if (!quotaExhausted && !endpointUnreachable && s.state === 'healthy') {
    // healthy → degraded (consecutive failures >= threshold)
    if (s.consecutiveFailures >= cfg.degradedAfterFailures) {
      newState = 'degraded';
      reason = `consecutive_failures_${s.consecutiveFailures}`;
      s.stateExpiresAt = now + cfg.degradedDurationMs;
    }
  }

  if (
    !quotaExhausted &&
    !endpointUnreachable &&
    (s.state === 'degraded' || s.state === 'healthy')
  ) {
    // → blocked (rate-limit threshold or consecutive failures threshold)
    if (s.rateLimitHits >= cfg.blockAfterRateLimitHits) {
      newState = 'blocked';
      reason = `rate_limit_threshold_${cfg.blockAfterRateLimitHits}`;
      s.stateExpiresAt = now + cfg.blockDurationMs;
    } else if (s.consecutiveFailures >= cfg.blockAfterFailures) {
      newState = 'blocked';
      reason = `consecutive_failures_${s.consecutiveFailures}`;
      s.stateExpiresAt = now + cfg.blockDurationMs;
    }
  }

  // If the provider sent a Retry-After hint (structured header or a prose
  // reset time parsed from the message). For quota failures the hint IS
  // the known reset/reopen time, so close the pair until exactly that
  // moment instead of stacking it onto the fixed block; for every other
  // failure kind the hint only extends the computed cooldown.
  if (newState !== 'healthy' && retryAfterMs && retryAfterMs > 0) {
    const hintExpiry = now + retryAfterMs;
    if (quotaExhausted) {
      s.stateExpiresAt = hintExpiry;
    } else if (s.stateExpiresAt === null || hintExpiry > s.stateExpiresAt) {
      s.stateExpiresAt = hintExpiry;
    }
  }
  return { newState, reason };
}
