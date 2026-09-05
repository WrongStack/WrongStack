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
import { MAX_RESET_HINT_MS, type ProviderErrorKind, parseResetHintMs } from '../types/provider.js';
import { ROUTE_SCOPED_QUOTA_RE } from '../types/quota-regex.js';

export * from './provider-status-tracker-types.js';

import {
  buildProviderStatusSnapshot,
  restoreProviderStatusSnapshot,
} from './provider-status-tracker-snapshot.js';
import {
  DEFAULTS,
  type ErrorHistoryEntry,
  isEndpointUnreachable,
  isQuotaExhausted,
  KEY_SEP,
  type MutableProviderModelStatus,
  NON_QUOTA_HINT_CAP_FACTOR,
  type ProviderModelState,
  type ProviderModelStatus,
  type ProviderStatusSnapshot,
  type ProviderStatusTrackerConfig,
  pairKey,
  statusIdentity,
  unpairKey,
} from './provider-status-tracker-types.js';

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
    return buildProviderStatusSnapshot(this.getAllStatuses());
  }

  /** Restore non-expired waiting-room entries from a previous process. */
  restoreSnapshot(value: unknown): number {
    return restoreProviderStatusSnapshot(
      {
        cfg: this.cfg,
        providerQuotaBlocks: this.providerQuotaBlocks,
        getOrCreate: (key, pid, mdl) => this.getOrCreate(key, pid, mdl),
        fanOutExpiryFor: (now, pairExpiry) => this.fanOutExpiryFor(now, pairExpiry),
      },
      value,
    );
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
