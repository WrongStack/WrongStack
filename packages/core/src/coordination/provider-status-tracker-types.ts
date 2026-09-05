/**
 * Types, defaults, and pure helpers for ProviderModelStatusTracker.
 * Extracted to keep provider-status-tracker.ts strictly below 800 lines.
 */

import type { ProviderErrorKind } from '../types/provider.js';
import { QUOTA_EXHAUSTED_RE } from '../types/quota-regex.js';

export type ProviderModelState = 'healthy' | 'degraded' | 'blocked';

export interface ErrorHistoryEntry {
  readonly timestamp: number;
  readonly kind: ProviderErrorKind;
  readonly status: number;
  readonly message: string;
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly retryAfterMs?: number | undefined;
}

export interface ProviderModelStatus {
  readonly providerId: string;
  readonly model: string;

  /** Current state in the state machine. */
  readonly state: ProviderModelState;

  // ── Failure counters ──
  readonly consecutiveFailures: number;
  readonly totalFailures: number;
  readonly rateLimitHits: number;
  readonly overloadedHits: number;
  readonly serverErrors: number;
  readonly otherErrors: number;

  // ── Success counters ──
  readonly consecutiveSuccesses: number;
  readonly totalSuccesses: number;
  readonly lastSuccessAt: number | null;

  // ── Timing ──
  readonly firstFailureAt: number | null;
  readonly lastFailureAt: number | null;
  /** When the current degraded or blocked state expires (ms epoch), or null. */
  readonly stateExpiresAt: number | null;

  // ── Last-error detail (for WebUI / `/provider-status`) ──
  readonly lastErrorKind: ProviderErrorKind | null;
  readonly lastErrorMessage: string | null;
  readonly lastErrorStatus: number | null;
  readonly lastSessionId: string | null;
  readonly lastAgentId: string | null;

  /** Recent error history (newest-first, capped to `maxErrorHistory`). */
  readonly recentErrors: readonly ErrorHistoryEntry[];
}

export interface ProviderStatusTrackerConfig {
  /**
   * Consecutive failures before entering `degraded`. Default: 2.
   */
  degradedAfterFailures?: number;
  /**
   * Duration (ms) the provider stays in `degraded` before reverting to healthy.
   * Default: 30_000 (30 s).
   */
  degradedDurationMs?: number;
  /**
   * Rate-limit hits (error kind = 'rate_limit') before entering `blocked`.
   * Default: 1 — a single 429 quarantines the model immediately so the
   * fallback engine rotates instead of burning more doomed requests.
   */
  blockAfterRateLimitHits?: number;
  /**
   * Consecutive failures before entering `blocked` directly.
   * Default: 5.
   */
  blockAfterFailures?: number;
  /**
   * Duration (ms) the provider stays `blocked` for ordinary failures
   * (rate-limit threshold, consecutive-failure threshold). These are
   * transient — short cooldowns re-probe quickly instead of parking a
   * recoverable model for minutes. Default: 120_000 (2 min).
   */
  blockDurationMs?: number;
  /**
   * Cooldown for the FIRST exhausted-credit/quota response when the
   * provider does not publish a reset hint. These failures enter the waiting
   * room immediately instead of consuming the ordinary rate-limit threshold.
   * Repeated quota blocks escalate via {@link quotaBlockEscalationMs}.
   * Default: 900_000 (15 min).
   */
  quotaBlockDurationMs?: number;
  /**
   * Escalating cooldowns (ms) for REPEATED quota blocks: each time a quota
   * block expires and the next result is quota-exhausted again, the next
   * tier applies; the last entry caps the escalation. A recorded success
   * (or manual unblock/clear) resets the ladder. Default:
   * [1_800_000, 3_600_000] — 2nd block 30 min, 3rd+ blocks 1 h max.
   */
  quotaBlockEscalationMs?: number[];
  /**
   * Consecutive successes needed to leave `degraded` or `blocked` and return
   * to `healthy` (if the timeout hasn't already cleared it). Default: 3.
   */
  recoverAfterSuccesses?: number;
  /**
   * Maximum error history entries kept per (providerId, model) pair.
   * Default: 50.
   */
  maxErrorHistory?: number;
  /**
   * When true, a `quota_exhausted` failure on any (providerId, model) pair
   * quarantines ALL other tracked pairs on the same provider — account-level
   * budget exhaustion affects every model, so we save N−1 doomed requests.
   * Default: true.
   */
  quarantineSiblingsOnQuotaExhausted?: boolean;
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULTS = {
  degradedAfterFailures: 2,
  degradedDurationMs: 30_000,
  blockAfterRateLimitHits: 1,
  blockAfterFailures: 5,
  blockDurationMs: 120_000,
  quotaBlockDurationMs: 900_000,
  quotaBlockEscalationMs: [1_800_000, 3_600_000],
  recoverAfterSuccesses: 3,
  maxErrorHistory: 50,
  quarantineSiblingsOnQuotaExhausted: true,
} satisfies Required<ProviderStatusTrackerConfig>;

/**
 * Non-quota failures are transient: a Retry-After header or a parsed prose
 * reset hint may extend the base blocked cooldown by at most this factor, so
 * a weekly-cap horizon quoted on an ordinary burst 429 cannot park the model
 * for days. Quota kinds bypass the cap — there the hint IS the published
 * budget-reset time, and holding until it is the point.
 */
export const NON_QUOTA_HINT_CAP_FACTOR = 3;

// ── Internal mutable state ──────────────────────────────────────────────────

export interface MutableProviderModelStatus {
  state: ProviderModelState;
  consecutiveFailures: number;
  totalFailures: number;
  rateLimitHits: number;
  overloadedHits: number;
  serverErrors: number;
  otherErrors: number;
  consecutiveSuccesses: number;
  totalSuccesses: number;
  lastSuccessAt: number | null;
  firstFailureAt: number | null;
  lastFailureAt: number | null;
  stateExpiresAt: number | null;
  /** Consecutive quota blocks since the last success/manual reset; drives cooldown escalation. */
  quotaBlockStreak: number;
  lastErrorKind: ProviderErrorKind | null;
  lastErrorMessage: string | null;
  lastErrorStatus: number | null;
  lastSessionId: string | null;
  lastAgentId: string | null;
  recentErrors: ErrorHistoryEntry[];
}

// ── Tracker ─────────────────────────────────────────────────────────────────

// ── Snapshot type ───────────────────────────────────────────────────────────

export interface ProviderStatusSnapshot {
  readonly totalPairs: number;
  readonly healthy: number;
  readonly degraded: number;
  readonly blocked: number;
  readonly totalFailures: number;
  readonly totalRateLimits: number;
  readonly statuses: readonly ProviderModelStatus[];
}

// ── Key helpers ─────────────────────────────────────────────────────────────

export const KEY_SEP = '\x00';

/**
 * OmniRoute is a transport gateway, not the logical provider identity. Its
 * discovered model ids are `<provider>/<model>`; strip the gateway prefix for
 * health tracking while callers continue using OmniRoute for the wire call.
 */
export function statusIdentity(
  providerId: string,
  model: string,
): {
  providerId: string;
  model: string;
} {
  if (providerId !== 'omniroute') return { providerId, model };
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return { providerId, model };
  return {
    providerId: model.slice(0, slash),
    model: model.slice(slash + 1),
  };
}

export function pairKey(providerId: string, model: string): string {
  return `${providerId}${KEY_SEP}${model}`;
}

export function unpairKey(key: string): [string, string] {
  const idx = key.indexOf(KEY_SEP);
  if (idx === -1) return [key, ''];
  return [key.slice(0, idx), key.slice(idx + 1)];
}

/** Distinguish an exhausted account/plan from an ordinary per-minute 429. */
export function isQuotaExhausted(
  kind: ProviderErrorKind,
  status: number,
  message: string,
): boolean {
  if (status === 402) return true;
  if (
    kind !== 'rate_limit' &&
    kind !== 'quota_exhausted' &&
    kind !== 'invalid_request' &&
    kind !== 'auth'
  )
    return false;
  return QUOTA_EXHAUSTED_RE.test(message);
}

/**
 * Messages that indicate the provider's API endpoint is unreachable rather
 * than merely overloaded or transiently failing. Common in 502 Bad Gateway
 * responses when Cloudflare / AWS / Kong cannot reach the upstream service.
 *
 * Unlike a transient 503 or 504, an unreachable endpoint often signals a
 * longer-lasting outage (deployment roll, DNS propagation, upstream crash).
 * The tracker treats these like quota exhaustion — block on first hit
 * instead of burning through the failure-threshold chain.
 */
const ENDPOINT_UNREACHABLE_RE =
  /(?:upstream|origin|backend|endpoint)[-_\s]*(?:unreachable|refused|connect(?:ion)?[-_\s]*(?:refused|error|fail)|unavailable|down|timeout)|no[-_\s]*(?:healthy|valid)[-_\s]*upstream|cannot[-_\s]*connect|connection[-_\s]*(?:refused|reset|closed|timed?[-_\s]out)/i;

export function isEndpointUnreachable(
  kind: ProviderErrorKind,
  status: number,
  message: string,
): boolean {
  // Only match gateway errors and network-level failures. Normal 5xx without
  // an unreachable message are transient server errors, not endpoint-down.
  if (status !== 502 && status !== 503 && status !== 0) return false;
  if (kind !== 'server' && kind !== 'network' && kind !== 'overloaded' && kind !== 'timeout')
    return false;
  return ENDPOINT_UNREACHABLE_RE.test(message);
}

export function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function safeTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function safeNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const PROVIDER_ERROR_KINDS = new Set<ProviderErrorKind>([
  'rate_limit',
  'quota_exhausted',
  'overloaded',
  'server',
  'timeout',
  'network',
  'stream_hang',
  'auth',
  'context_overflow',
  'content_filter',
  'invalid_request',
  'unknown',
]);

export function isProviderErrorKind(value: unknown): value is ProviderErrorKind {
  return typeof value === 'string' && PROVIDER_ERROR_KINDS.has(value as ProviderErrorKind);
}
