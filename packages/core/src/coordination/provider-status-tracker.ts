/**
 * ProviderModelStatusTracker — centralized, shared status tracking for every
 * provider/model combination used across the agent, subagents, fallback
 * chains, and the one-shot LLM helper.
 *
 * ## Design
 *
 * - **Single shared instance**: created once per process, injected into every
 *   component that calls providers or resolves fallback chains. The same
 *   in-memory state is visible to the fallback extension, the one-shot
 *   orchestrator, the dispatcher, and fleet-spawn — so a provider blocked
 *   by a rate-limit spike is filtered EVERYWHERE, not just in one path.
 *
 * - **State machine** per (providerId, model) pair:
 *   ```
 *   healthy ──(failure)──▶ degraded ──(more failures)──▶ blocked
 *      ▲                                                    │
 *      └──────────────(success streak / timeout)────────────┘
 *   ```
 *
 * - **Thresholds** are configurable via constructor opts. Defaults:
 *   | Metric | Threshold | Action |
 *   |--------|-----------|--------|
 *   | consecutive failures ≥ 2 | → `degraded` for 30 s |
 *   | rate-limit hits ≥ 1 | → `blocked` for 2 min |
 *   | consecutive failures ≥ 5 | → `blocked` for 2 min |
 *   | quota exhaustion (1st) | → `blocked` for 15 min |
 *   | quota exhaustion (repeat) | → `blocked` 30 min, then capped at 1 h |
 *   | quota reset time published | → `blocked` until exactly that time |
 *   | success streak ≥ 3 | → back to `healthy` (also resets quota escalation) |
 *   | `blocked` timeout elapses | → back to `healthy` |
 *
 * - **Error history**: keeps the last N errors per pair, with session id,
 *   agent id, kind, and message so the WebUI and `/provider-status` can
 *   render a meaningful timeline.
 *
 * - **Events**: emits `provider.status_changed` on every state transition.
 *
 * - **Thread-safety**: not needed — Node.js event-loop concurrency means
 *   all access is single-threaded (async gaps don't race on the Map).
 *
 * @module coordination/provider-status-tracker
 */

import type { EventBus } from '../kernel/events.js';
import {
  MAX_RESET_HINT_MS,
  type ProviderErrorKind,
  parseResetHintMs,
} from '../types/provider.js';
import { QUOTA_EXHAUSTED_RE, ROUTE_SCOPED_QUOTA_RE } from '../types/quota-regex.js';

// ── Public types ────────────────────────────────────────────────────────────

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

const DEFAULTS = {
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
const NON_QUOTA_HINT_CAP_FACTOR = 3;

// ── Internal mutable state ──────────────────────────────────────────────────

interface MutableProviderModelStatus {
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

export class ProviderModelStatusTracker {
  private readonly cfg: Required<ProviderStatusTrackerConfig>;
  private readonly map = new Map<string, MutableProviderModelStatus>();
  /** Account/plan quota blocks apply to unseen sibling models too. */
  private readonly providerQuotaBlocks = new Map<string, number>();
  private readonly events: EventBus | undefined;

  constructor(opts?: {
    config?: ProviderStatusTrackerConfig | undefined;
    events?: EventBus | undefined;
  }) {
    this.cfg = { ...DEFAULTS, ...opts?.config };
    // Defensive copy: never alias the caller's escalation ladder array.
    this.cfg.quotaBlockEscalationMs = [...this.cfg.quotaBlockEscalationMs];
    this.events = opts?.events;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Resolve the logical health/display identity without changing wire routing. */
  logicalIdentity(providerId: string, model: string): { providerId: string; model: string } {
    return statusIdentity(providerId, model);
  }

  /**
   * Record a successful provider call. Resets consecutive failure counters
   * and may transition out of degraded/blocked.
   */
  recordSuccess(
    providerId: string,
    model: string,
    _meta?: { sessionId?: string | undefined; agentId?: string | undefined },
  ): void {
    ({ providerId, model } = statusIdentity(providerId, model));
    this.providerQuotaBlocks.delete(providerId);
    const key = pairKey(providerId, model);
    const s = this.getOrCreate(key, providerId, model);

    s.consecutiveFailures = 0;
    // A real success is evidence the quota recovered — restart the
    // escalation ladder so the next quota block starts from the base tier.
    s.quotaBlockStreak = 0;
    s.consecutiveSuccesses += 1;
    s.totalSuccesses += 1;
    s.lastSuccessAt = Date.now();

    // Success streak recovery: if we've had enough consecutive successes,
    // move back to healthy.
    if (s.state !== 'healthy' && s.consecutiveSuccesses >= this.cfg.recoverAfterSuccesses) {
      const oldState = s.state;
      s.state = 'healthy';
      s.stateExpiresAt = null;
      s.rateLimitHits = 0;
      s.overloadedHits = 0;
      s.serverErrors = 0;
      s.otherErrors = 0;
      this.emitStatusChanged(providerId, model, oldState, 'healthy', 'success_streak_recovery');
    }
  }

  /**
   * Record a failed provider call. Transitions state based on thresholds.
   *
   * @returns The new state after recording this failure.
   */
  recordFailure(
    providerId: string,
    model: string,
    kind: ProviderErrorKind,
    status: number,
    message: string,
    meta?: {
      sessionId?: string | undefined;
      agentId?: string | undefined;
      retryAfterMs?: number | undefined;
    },
  ): ProviderModelState {
    ({ providerId, model } = statusIdentity(providerId, model));
    const key = pairKey(providerId, model);
    const s = this.getOrCreate(key, providerId, model);
    const now = Date.now();
    const previousExpiry = s.stateExpiresAt;

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

    // A depleted account/plan is not a transient burst-rate signal. Waiting
    // for two more doomed requests wastes time and can fan the same failure
    // out through subagents, so quarantine this model on the first response.
    const quotaExhausted = kind === 'quota_exhausted' || isQuotaExhausted(kind, status, message);
    const providerWideQuota = quotaExhausted && !ROUTE_SCOPED_QUOTA_RE.test(message);

    // Effective wait-room hint: an explicit structured Retry-After wins;
    // otherwise, for quota/rate-limit failures, parse the provider's prose
    // reset hint ("try again in 6h12m", "resets at <ISO>") so weekly caps
    // hold until their real reset instead of the fixed default block.
    const proseHintMs =
      quotaExhausted || kind === 'rate_limit' ? parseResetHintMs(message, now) : undefined;
    const rawHintMs = meta?.retryAfterMs && meta.retryAfterMs > 0 ? meta.retryAfterMs : proseHintMs;
    // For NON-quota kinds the hint only extends the transient cooldown, and
    // only up to a small multiple of the base block: providers quote the
    // plan/weekly reset horizon on ordinary burst 429s, and honoring it
    // verbatim parked models for hours (the "stuck in the waiting room"
    // regression). Quota kinds keep the full hint — it is the actual reset.
    const effectiveRetryAfterMs =
      rawHintMs && rawHintMs > 0
        ? quotaExhausted
          ? // Quota keeps the provider-published reset, but a corrupt or
            // absurd structured Retry-After still cannot park a model
            // beyond the prose-hint maximum.
            Math.min(rawHintMs, MAX_RESET_HINT_MS)
          : Math.min(rawHintMs, this.cfg.blockDurationMs * NON_QUOTA_HINT_CAP_FACTOR)
        : undefined;

    // Push error history (newest first, capped)
    const entry: ErrorHistoryEntry = Object.freeze({
      timestamp: now,
      kind,
      status,
      message,
      sessionId: meta?.sessionId,
      agentId: meta?.agentId,
      retryAfterMs: effectiveRetryAfterMs,
    });
    s.recentErrors.unshift(entry);
    if (s.recentErrors.length > this.cfg.maxErrorHistory) {
      s.recentErrors = s.recentErrors.slice(0, this.cfg.maxErrorHistory);
    }

    // ── State machine transitions ──

    let newState: ProviderModelState = s.state;
    let reason = '';

    // API endpoint unreachable (502 with connection-refused / upstream-down
    // message) is equally non-transient: the provider's upstream is offline
    // and retrying will fail until it comes back. Block immediately instead
    // of exhausting the failure-threshold chain.
    const endpointUnreachable = isEndpointUnreachable(kind, status, message);

    if (quotaExhausted) {
      newState = 'blocked';
      reason = 'quota_exhausted';
      // Repeated quota blocks escalate: block expiry → available again →
      // quota-exhausted again means the reset did not actually free budget,
      // so back off progressively (15 min → 30 min → capped at 1 h) instead
      // of re-probing at the same interval forever.
      s.quotaBlockStreak += 1;
      s.stateExpiresAt = now + this.quotaBlockDurationForStreak(s.quotaBlockStreak);
    } else if (endpointUnreachable) {
      newState = 'blocked';
      reason = 'endpoint_unreachable';
      s.stateExpiresAt = now + this.cfg.quotaBlockDurationMs;
    }

    if (!quotaExhausted && !endpointUnreachable && s.state === 'healthy') {
      // healthy → degraded (consecutive failures >= threshold)
      if (s.consecutiveFailures >= this.cfg.degradedAfterFailures) {
        newState = 'degraded';
        reason = `consecutive_failures_${s.consecutiveFailures}`;
        s.stateExpiresAt = now + this.cfg.degradedDurationMs;
      }
    }

    if (
      !quotaExhausted &&
      !endpointUnreachable &&
      (s.state === 'degraded' || s.state === 'healthy')
    ) {
      // → blocked (rate-limit threshold or consecutive failures threshold)
      if (s.rateLimitHits >= this.cfg.blockAfterRateLimitHits) {
        newState = 'blocked';
        reason = `rate_limit_threshold_${this.cfg.blockAfterRateLimitHits}`;
        s.stateExpiresAt = now + this.cfg.blockDurationMs;
      } else if (s.consecutiveFailures >= this.cfg.blockAfterFailures) {
        newState = 'blocked';
        reason = `consecutive_failures_${s.consecutiveFailures}`;
        s.stateExpiresAt = now + this.cfg.blockDurationMs;
      }
    }

    // If the provider sent a Retry-After hint (structured header or a prose
    // reset time parsed from the message). For quota failures the hint IS
    // the known reset/reopen time, so close the pair until exactly that
    // moment instead of stacking it onto the fixed block; for every other
    // failure kind the hint only extends the computed cooldown.
    if (newState !== 'healthy' && effectiveRetryAfterMs && effectiveRetryAfterMs > 0) {
      const hintExpiry = now + effectiveRetryAfterMs;
      if (quotaExhausted) {
        s.stateExpiresAt = hintExpiry;
      } else if (s.stateExpiresAt === null || hintExpiry > s.stateExpiresAt) {
        s.stateExpiresAt = hintExpiry;
      }
    }

    if (
      this.cfg.quarantineSiblingsOnQuotaExhausted &&
      providerWideQuota &&
      s.stateExpiresAt !== null
    ) {
      const previous = this.providerQuotaBlocks.get(providerId) ?? 0;
      this.providerQuotaBlocks.set(
        providerId,
        Math.max(previous, this.fanOutExpiryFor(now, s.stateExpiresAt)),
      );
    }

    if (s.state !== newState) {
      const oldState = s.state;
      s.state = newState;
      this.emitStatusChanged(providerId, model, oldState, newState, reason);
    } else if (s.state !== 'healthy' && s.stateExpiresAt !== previousExpiry) {
      this.emitStatusChanged(providerId, model, s.state, s.state, 'cooldown_extended');
    }

    // ── Provider-level sibling quarantine ──
    // When an account-level budget is exhausted, every model on that provider
    // will return the same error. Fan out the quarantine to all other tracked
    // pairs on the same provider so the fallback engine skips them without
    // burning N−1 doomed requests.
    if (
      this.cfg.quarantineSiblingsOnQuotaExhausted &&
      providerWideQuota &&
      newState === 'blocked'
    ) {
      this.quarantineSiblings(
        providerId,
        model,
        status,
        now,
        this.fanOutExpiryFor(now, s.stateExpiresAt ?? now),
      );
    }

    return newState;
  }

  /**
   * Quarantine fan-out expiry: the fixed quota cooldown, never the
   * hint-extended trigger expiry. A weekly-cap reset time applies to the
   * model that published it; sibling models (and unseen pairs behind the
   * provider-wide gate) re-open after the base cooldown so one misclassified
   * or hint-stretched failure cannot silence a whole provider for hours.
   */
  private fanOutExpiryFor(now: number, triggerExpiry: number): number {
    return Math.min(triggerExpiry, now + this.cfg.quotaBlockDurationMs);
  }

  /**
   * Mark every other tracked pair on the same provider as blocked with the
   * same expiry as the triggering pair. Only pairs already known to the
   * tracker (previously seen via a call or failure) are affected — unknown
   * pairs are implicitly healthy and not pre-emptively blocked.
   */
  private quarantineSiblings(
    triggerProviderId: string,
    triggerModel: string,
    triggerStatus: number,
    now: number,
    expiry: number,
  ): void {
    const providerKey = triggerProviderId + KEY_SEP;
    for (const [key, s] of this.map) {
      if (!key.startsWith(providerKey)) continue;
      if (key === pairKey(triggerProviderId, triggerModel)) continue;
      if (s.state === 'blocked') continue; // already blocked — leave as-is

      const [siblingProvider, siblingModel] = unpairKey(key);
      const oldState = s.state;
      s.state = 'blocked';
      s.stateExpiresAt = expiry;
      s.lastErrorKind = 'quota_exhausted';
      s.lastErrorMessage = `Sibling quarantine: account-level budget exhausted on ${triggerProviderId}/${triggerModel}`;
      s.lastErrorStatus = triggerStatus;
      s.lastFailureAt = now;

      // Push an error-history entry so the WebUI timeline records the
      // quarantine event for this sibling.
      const entry: ErrorHistoryEntry = Object.freeze({
        timestamp: now,
        kind: 'quota_exhausted',
        status: triggerStatus,
        message: s.lastErrorMessage,
      });
      s.recentErrors.unshift(entry);
      if (s.recentErrors.length > this.cfg.maxErrorHistory) {
        s.recentErrors = s.recentErrors.slice(0, this.cfg.maxErrorHistory);
      }

      this.emitStatusChanged(
        siblingProvider,
        siblingModel,
        oldState,
        'blocked',
        'sibling_quota_exhausted',
      );
    }
  }

  /**
   * Check if a (providerId, model) pair is currently usable.
   * Returns `true` when healthy or degraded (degraded is still usable,
   * just known flaky). Returns `false` when blocked or when the error
   * kind is `auth` (no point retrying ever).
   */
  isAvailable(providerId: string, model: string): boolean {
    ({ providerId, model } = statusIdentity(providerId, model));
    const providerBlockedUntil = this.providerQuotaBlocks.get(providerId);
    if (providerBlockedUntil !== undefined) {
      if (Date.now() < providerBlockedUntil) return false;
      this.providerQuotaBlocks.delete(providerId);
    }
    const key = pairKey(providerId, model);
    const s = this.map.get(key);
    if (!s) return true; // never seen → healthy

    // If blocked but the timeout has expired, auto-recover
    if (s.state === 'blocked' && s.stateExpiresAt !== null && Date.now() >= s.stateExpiresAt) {
      const oldState = s.state;
      s.state = 'healthy';
      s.stateExpiresAt = null;
      s.consecutiveFailures = 0;
      s.consecutiveSuccesses = 0;
      s.rateLimitHits = 0;
      s.overloadedHits = 0;
      s.serverErrors = 0;
      s.otherErrors = 0;
      this.emitStatusChanged(providerId, model, oldState, 'healthy', 'cooldown_expired');
      return true;
    }

    // If degraded but the timeout has expired, auto-recover
    if (s.state === 'degraded' && s.stateExpiresAt !== null && Date.now() >= s.stateExpiresAt) {
      const oldState = s.state;
      s.state = 'healthy';
      s.stateExpiresAt = null;
      s.consecutiveFailures = 0;
      s.consecutiveSuccesses = 0;
      s.rateLimitHits = 0;
      s.overloadedHits = 0;
      s.serverErrors = 0;
      s.otherErrors = 0;
      this.emitStatusChanged(providerId, model, oldState, 'healthy', 'degraded_timeout_expired');
      return true;
    }

    return s.state !== 'blocked';
  }

  /**
   * Manually unblock/reset a provider/model pair (e.g. after a manual model switch or key update).
   */
  unblock(providerId: string, model: string): void {
    ({ providerId, model } = statusIdentity(providerId, model));
    this.providerQuotaBlocks.delete(providerId);
    const key = pairKey(providerId, model);
    const s = this.map.get(key);
    if (s) {
      const oldState = s.state;
      s.state = 'healthy';
      s.stateExpiresAt = null;
      s.consecutiveFailures = 0;
      s.quotaBlockStreak = 0;
      s.rateLimitHits = 0;
      s.overloadedHits = 0;
      s.serverErrors = 0;
      s.otherErrors = 0;
      if (oldState !== 'healthy') {
        this.emitStatusChanged(providerId, model, oldState, 'healthy', 'manual_unblock');
      }
    }
  }

  /**
   * Check if a (providerId, model) pair is currently rate-limited.
   * This is a stronger signal than just `!isAvailable()` — it tells
   * callers that requests should be re-tried after a delay rather
   * than skipped permanently.
   */
  isRateLimited(providerId: string, model: string): boolean {
    ({ providerId, model } = statusIdentity(providerId, model));
    const key = pairKey(providerId, model);
    const s = this.map.get(key);
    if (!s) return false;
    // If the last error was a rate_limit and we're still in a non-healthy state
    return s.lastErrorKind === 'rate_limit' && s.state !== 'healthy';
  }

  /**
   * Get the full status for a (providerId, model) pair, or `undefined`
   * if no failures have been recorded.
   */
  getStatus(providerId: string, model: string): ProviderModelStatus | undefined {
    ({ providerId, model } = statusIdentity(providerId, model));
    const key = pairKey(providerId, model);
    const s = this.map.get(key);
    if (!s) return undefined;

    // Auto-recover if stale
    this.isAvailable(providerId, model); // side-effect: recovers if expired

    return this.freezeStatus(key, s);
  }

  /**
   * Returns a snapshot of ALL tracked provider/model statuses.
   * Useful for the `/provider-status` command and WebUI.
   */
  getAllStatuses(): ProviderModelStatus[] {
    const out: ProviderModelStatus[] = [];
    for (const [key, s] of this.map) {
      // Trigger auto-recovery
      const [providerId, model] = unpairKey(key);
      this.isAvailable(providerId, model);
      out.push(this.freezeStatus(key, s));
    }
    return out;
  }

  /**
   * Move every expired waiting-room entry back to healthy. Runtime routing
   * already performs this check lazily; this explicit sweep lets a UI/status
   * timer refresh the room even while no model calls are being made.
   *
   * @returns Number of entries released by this sweep.
   */
  sweepExpired(): number {
    let released = 0;
    const now = Date.now();
    for (const [providerId, expiresAt] of this.providerQuotaBlocks) {
      if (now >= expiresAt) this.providerQuotaBlocks.delete(providerId);
    }
    for (const [key, s] of this.map) {
      if (s.state === 'healthy' || s.stateExpiresAt === null || Date.now() < s.stateExpiresAt)
        continue;
      const [providerId, model] = unpairKey(key);
      const previous = s.state;
      s.state = 'healthy';
      s.stateExpiresAt = null;
      s.consecutiveFailures = 0;
      s.consecutiveSuccesses = 0;
      s.rateLimitHits = 0;
      s.overloadedHits = 0;
      s.serverErrors = 0;
      s.otherErrors = 0;
      this.emitStatusChanged(providerId, model, previous, 'healthy', 'waiting_room_expired');
      released += 1;
    }
    return released;
  }

  /**
   * Release one entry for an immediate half-open probe on its next real use.
   * History and totals are retained so operators do not lose diagnostics.
   * The quota escalation streak is also retained on purpose: a probe that
   * fails with quota exhaustion again keeps climbing the ladder.
   */
  retryNow(providerId: string, model: string): boolean {
    ({ providerId, model } = statusIdentity(providerId, model));
    const releasedProvider = this.providerQuotaBlocks.delete(providerId);
    const s = this.map.get(pairKey(providerId, model));
    if (!s || s.state === 'healthy') return releasedProvider;
    const previous = s.state;
    s.state = 'healthy';
    s.stateExpiresAt = null;
    s.consecutiveFailures = 0;
    s.consecutiveSuccesses = 0;
    s.rateLimitHits = 0;
    s.overloadedHits = 0;
    s.serverErrors = 0;
    s.otherErrors = 0;
    this.emitStatusChanged(providerId, model, previous, 'healthy', 'manual_half_open');
    return true;
  }

  /**
   * Returns only currently blocked entries.
   */
  getBlocked(): ProviderModelStatus[] {
    return this.getAllStatuses().filter((s) => s.state === 'blocked');
  }

  /**
   * Returns only currently degraded entries.
   */
  getDegraded(): ProviderModelStatus[] {
    return this.getAllStatuses().filter((s) => s.state === 'degraded');
  }

  /**
   * Filter an array of objects that have `providerId` and `model` fields,
   * removing entries whose (providerId, model) is blocked.
   */
  filterAvailable<T extends { providerId: string; model: string }>(entries: readonly T[]): T[] {
    return entries.filter((e) => this.isAvailable(e.providerId, e.model));
  }

  /**
   * Check if a (providerId, model) pair is currently blocked, WITHOUT
   * mutating internal state. Unlike {@link isAvailable}, this method does
   * not perform lazy auto-recovery — it returns the effective blocked
   * status by evaluating the expiry condition, but leaves `s.state`
   * unchanged. A subsequent call to {@link isAvailable} or
   * {@link getAllStatuses} will perform the actual state transition.
   *
   * Note: the result is a snapshot in time — if the blocked entry has
   * expired, this returns `false` (as-if recovered) even though no
   * mutation has occurred yet.
   */
  isBlocked(providerId: string, model: string): boolean {
    ({ providerId, model } = statusIdentity(providerId, model));
    const providerBlockedUntil = this.providerQuotaBlocks.get(providerId);
    if (providerBlockedUntil !== undefined && Date.now() < providerBlockedUntil) return true;
    const key = pairKey(providerId, model);
    const s = this.map.get(key);
    if (!s) return false;
    if (s.state !== 'blocked') return false;
    // Evaluate expiry but do NOT mutate state — see JSDoc above
    if (s.stateExpiresAt !== null && Date.now() >= s.stateExpiresAt) {
      return false; // would have recovered
    }
    return true;
  }

  /**
   * Reset tracking for a specific (providerId, model) pair, or for ALL
   * pairs when both arguments are omitted.
   */
  clear(providerId?: string, model?: string): void {
    if (providerId && model) {
      ({ providerId, model } = statusIdentity(providerId, model));
      const key = pairKey(providerId, model);
      this.providerQuotaBlocks.delete(providerId);
      const old = this.map.get(key);
      if (old && old.state !== 'healthy') {
        this.emitStatusChanged(providerId, model, old.state, 'healthy', 'manual_clear');
      }
      this.map.delete(key);
    } else {
      for (const [key, s] of this.map) {
        if (s.state !== 'healthy') {
          const [pid, mdl] = unpairKey(key);
          this.emitStatusChanged(pid, mdl, s.state, 'healthy', 'manual_clear_all');
        }
      }
      this.map.clear();
      this.providerQuotaBlocks.clear();
    }
  }

  /**
   * Get a JSON-safe snapshot suitable for WebUI rendering.
   * Includes summary stats + per-pair details.
   */
  getSnapshot(): ProviderStatusSnapshot {
    const all = this.getAllStatuses();
    const healthy: ProviderModelStatus[] = [];
    const degraded: ProviderModelStatus[] = [];
    const blocked: ProviderModelStatus[] = [];

    for (const s of all) {
      if (s.state === 'blocked') blocked.push(s);
      else if (s.state === 'degraded') degraded.push(s);
      else healthy.push(s);
    }

    return {
      totalPairs: all.length,
      healthy: healthy.length,
      degraded: degraded.length,
      blocked: blocked.length,
      totalFailures: all.reduce((sum, s) => sum + s.totalFailures, 0),
      totalRateLimits: all.reduce((sum, s) => sum + s.rateLimitHits, 0),
      statuses: all,
    };
  }

  /** Restore non-expired waiting-room entries from a previous process. */
  restoreSnapshot(value: unknown): number {
    if (!value || typeof value !== 'object') return 0;
    const statuses = (value as { statuses?: unknown }).statuses;
    if (!Array.isArray(statuses)) return 0;
    let restored = 0;
    const now = Date.now();
    for (const raw of statuses) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (typeof item['providerId'] !== 'string' || typeof item['model'] !== 'string') continue;
      if (item['state'] !== 'blocked' && item['state'] !== 'degraded') continue;
      if (typeof item['stateExpiresAt'] !== 'number' || item['stateExpiresAt'] <= now) continue;
      const { providerId, model } = statusIdentity(item['providerId'], item['model']);
      const s = this.getOrCreate(pairKey(providerId, model), providerId, model);
      s.state = item['state'];
      s.stateExpiresAt = item['stateExpiresAt'];
      s.consecutiveFailures = safeCount(item['consecutiveFailures']);
      s.totalFailures = safeCount(item['totalFailures']);
      s.rateLimitHits = safeCount(item['rateLimitHits']);
      s.lastFailureAt = safeTimestamp(item['lastFailureAt']);
      s.lastErrorStatus = safeNullableNumber(item['lastErrorStatus']);
      s.lastErrorMessage =
        typeof item['lastErrorMessage'] === 'string' ? item['lastErrorMessage'] : null;
      s.lastErrorKind = isProviderErrorKind(item['lastErrorKind']) ? item['lastErrorKind'] : null;
      const providerWideQuota =
        s.lastErrorKind === 'quota_exhausted' ||
        isQuotaExhausted(
          s.lastErrorKind ?? 'unknown',
          s.lastErrorStatus ?? 0,
          s.lastErrorMessage ?? '',
        );
      if (
        this.cfg.quarantineSiblingsOnQuotaExhausted &&
        providerWideQuota &&
        !ROUTE_SCOPED_QUOTA_RE.test(s.lastErrorMessage ?? '') &&
        s.state === 'blocked' &&
        s.stateExpiresAt !== null
      ) {
        const previous = this.providerQuotaBlocks.get(providerId) ?? 0;
        // The restored PAIR keeps its persisted expiry (a real weekly cap
        // still holds), but the provider-wide gate is capped at the fixed
        // quota block, same as a live fan-out would be.
        this.providerQuotaBlocks.set(
          providerId,
          Math.max(previous, this.fanOutExpiryFor(now, s.stateExpiresAt)),
        );
      }
      restored += 1;
    }
    return restored;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Cooldown for the Nth consecutive quota block: the base duration for the
   * first block, then the escalation ladder for repeats, capped at the last
   * ladder entry. A provider-published reset hint bypasses this entirely
   * (the pair is closed until that exact time instead).
   */
  private quotaBlockDurationForStreak(streak: number): number {
    if (streak <= 1) return this.cfg.quotaBlockDurationMs;
    const ladder = this.cfg.quotaBlockEscalationMs;
    if (ladder.length === 0) return this.cfg.quotaBlockDurationMs;
    const tier = Math.min(streak - 2, ladder.length - 1);
    return ladder[tier] ?? this.cfg.quotaBlockDurationMs;
  }

  private getOrCreate(
    key: string,
    _providerId: string,
    _model: string,
  ): MutableProviderModelStatus {
    let s = this.map.get(key);
    if (!s) {
      s = {
        state: 'healthy',
        consecutiveFailures: 0,
        totalFailures: 0,
        rateLimitHits: 0,
        overloadedHits: 0,
        serverErrors: 0,
        otherErrors: 0,
        consecutiveSuccesses: 0,
        totalSuccesses: 0,
        lastSuccessAt: null,
        firstFailureAt: null,
        lastFailureAt: null,
        stateExpiresAt: null,
        quotaBlockStreak: 0,
        lastErrorKind: null,
        lastErrorMessage: null,
        lastErrorStatus: null,
        lastSessionId: null,
        lastAgentId: null,
        recentErrors: [],
      };
      this.map.set(key, s);
    }
    return s;
  }

  private freezeStatus(key: string, s: MutableProviderModelStatus): ProviderModelStatus {
    const [providerId, model] = unpairKey(key);
    return Object.freeze({
      providerId,
      model,
      state: s.state,
      consecutiveFailures: s.consecutiveFailures,
      totalFailures: s.totalFailures,
      rateLimitHits: s.rateLimitHits,
      overloadedHits: s.overloadedHits,
      serverErrors: s.serverErrors,
      otherErrors: s.otherErrors,
      consecutiveSuccesses: s.consecutiveSuccesses,
      totalSuccesses: s.totalSuccesses,
      lastSuccessAt: s.lastSuccessAt,
      firstFailureAt: s.firstFailureAt,
      lastFailureAt: s.lastFailureAt,
      stateExpiresAt: s.stateExpiresAt,
      lastErrorKind: s.lastErrorKind,
      lastErrorMessage: s.lastErrorMessage,
      lastErrorStatus: s.lastErrorStatus,
      lastSessionId: s.lastSessionId,
      lastAgentId: s.lastAgentId,
      recentErrors: Object.freeze([...s.recentErrors]),
    });
  }

  private emitStatusChanged(
    providerId: string,
    model: string,
    oldState: ProviderModelState,
    newState: ProviderModelState,
    reason: string,
  ): void {
    if (!this.events) return;
    try {
      const entry = this.map.get(pairKey(providerId, model));
      this.events.emit('provider.status_changed', {
        providerId,
        model,
        oldState,
        newState,
        reason,
        timestamp: Date.now(),
        stateExpiresAt: entry?.stateExpiresAt ?? undefined,
        // Error context for durable audit logs (who/what/why): the failure
        // that led to this state, with the session/agent that hit it. Nulls
        // normalize to undefined so JSON serialization drops them.
        lastErrorKind: entry?.lastErrorKind ?? undefined,
        lastErrorStatus: entry?.lastErrorStatus ?? undefined,
        lastErrorMessage: entry?.lastErrorMessage ?? undefined,
        lastSessionId: entry?.lastSessionId ?? undefined,
        lastAgentId: entry?.lastAgentId ?? undefined,
      });
    } catch {
      // Swallow — event bus errors must not crash the tracker
    }
  }
}

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

const KEY_SEP = '\x00';

/**
 * OmniRoute is a transport gateway, not the logical provider identity. Its
 * discovered model ids are `<provider>/<model>`; strip the gateway prefix for
 * health tracking while callers continue using OmniRoute for the wire call.
 */
function statusIdentity(
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

function pairKey(providerId: string, model: string): string {
  return `${providerId}${KEY_SEP}${model}`;
}

function unpairKey(key: string): [string, string] {
  const idx = key.indexOf(KEY_SEP);
  if (idx === -1) return [key, ''];
  return [key.slice(0, idx), key.slice(idx + 1)];
}

/** Distinguish an exhausted account/plan from an ordinary per-minute 429. */
function isQuotaExhausted(kind: ProviderErrorKind, status: number, message: string): boolean {
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

function isEndpointUnreachable(kind: ProviderErrorKind, status: number, message: string): boolean {
  // Only match gateway errors and network-level failures. Normal 5xx without
  // an unreachable message are transient server errors, not endpoint-down.
  if (status !== 502 && status !== 503 && status !== 0) return false;
  if (kind !== 'server' && kind !== 'network' && kind !== 'overloaded' && kind !== 'timeout')
    return false;
  return ENDPOINT_UNREACHABLE_RE.test(message);
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function safeTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function safeNullableNumber(value: unknown): number | null {
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

function isProviderErrorKind(value: unknown): value is ProviderErrorKind {
  return typeof value === 'string' && PROVIDER_ERROR_KINDS.has(value as ProviderErrorKind);
}
