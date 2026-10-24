/**
 * HQ alerting engine — evaluates the current snapshot against a set of
 * operator-configurable rules and emits `hq.alert` messages when a threshold
 * is crossed. Mirrors the BrainMonitor's self-activation logic (tool-failure
 * streaks, error storms) but at the fleet-wide command-center scope.
 *
 * Rules are evaluated on a periodic tick (default 15s, unref'd) against the
 * latest in-memory snapshot. Deduplication prevents alert storms: a rule that
 * is still firing is not re-emitted until it clears (state machine per rule).
 *
 * @module hq/alerts
 */
import type { HqAlertMessage, HqSnapshot } from './protocol.js';

/** Severity levels for alerts, mirroring {@link HqAlertMessage}. */
export type HqAlertSeverity = HqAlertMessage['severity'];

export interface HqAlert {
  id: string;
  ruleId: string;
  severity: HqAlertSeverity;
  message: string;
  /** Epoch ms when the alert first fired in its current episode. */
  firstFiredAt: number;
  /** Epoch ms of the most recent evaluation that confirmed the alert. */
  lastFiredAt: number;
}

export interface HqAlertRuleConfig {
  /** Maximum cost (USD) across the whole fleet before alerting. Default 50. */
  costThresholdUsd?: number;
  /** Seconds of silence from ALL machines before a stale alert fires. Default 120. */
  staleMachineSeconds?: number;
  /** Minimum number of active agents before concurrency alert fires. Default: disabled (0). */
  maxAgents?: number;
  /**
   * Hours before expiry at which the `token-expiry-imminent` warning fires.
   * Default 24. Set to 0 to disable the warning entirely (expired-only alert remains).
   */
  tokenExpiryWarningHours?: number;
  /**
   * W3 #2 (RFC hq-improvements-2026-09.md): operator-configured throughput
   * budget in USD. When the fleet's cumulative `totalCostUsd` reaches
   * this absolute budget, the `fleet-throughput-budget` rule fires
   * with `severity: 'warn'` — distinct from `fleet-cost-threshold`
   * (per-call threshold, default 50) and intended as the operator's
   * hard ceiling for a billing period.
   *
   * Default 0 (disabled). Set to a positive number to enable. The
   * host wires this via `alerts-config.json` (see the W2 #13 module)
   * so an operator can tune it without restarting the engine.
   */
  throughputBudgetUsd?: number;
  /**
   * W3 #2: minutes over which the throughput rate is computed when
   * the snapshot provides a `throughputPerMinuteUsd` field. Default 60
   * (a 1-hour rate). Reserved for the timeseries-based projection
   * variant of the rule; the current implementation reads the absolute
   * `totalCostUsd` from the snapshot.
   */
  throughputLookbackMinutes?: number;
}

/** The fully-resolved config passed to rule.evaluate (no optional fields). */
type ResolvedAlertConfig = Required<
  Pick<
    HqAlertRuleConfig,
    | 'costThresholdUsd'
    | 'staleMachineSeconds'
    | 'maxAgents'
    | 'tokenExpiryWarningHours'
    | 'throughputBudgetUsd'
    | 'throughputLookbackMinutes'
  >
>;

/** A rule is a pure function: snapshot + config → optional firing. */
interface HqAlertRule {
  id: string;
  severity: HqAlertSeverity;
  evaluate: (
    snapshot: HqSnapshot | null,
    config: ResolvedAlertConfig,
    now: number,
  ) => string | null;
}

const DEFAULT_CONFIG: ResolvedAlertConfig = {
  costThresholdUsd: 50,
  staleMachineSeconds: 120,
  maxAgents: 0,
  tokenExpiryWarningHours: 24,
  // W3 #2: throughput-budget fields. Default 0 = disabled; the rule is
  // a no-op until the operator sets a positive budget via alerts-config.json.
  // 60 minutes is the conventional lookback window for hourly budgets.
  throughputBudgetUsd: 0,
  throughputLookbackMinutes: 60,
};

/**
 * W2 #12: default cap on a single snooze request (24 hours). Picked to be
 * long enough to mute an overnight CI run or a known deploy window, short
 * enough that a forgotten snooze does not silence alerting past a single
 * operational shift. Operators can override per-call via
 * {@link HqAlertEngine.snooze} returning `clamped: true`, or globally by
 * constructing the engine with `maxSnoozeMs`.
 */
const DEFAULT_MAX_SNOOZE_MS = 24 * 60 * 60_000;

function resolveConfig(config?: HqAlertRuleConfig): ResolvedAlertConfig {
  return { ...DEFAULT_CONFIG, ...(config ?? {}) };
}

const RULES: readonly HqAlertRule[] = [
  {
    id: 'fleet-cost-threshold',
    severity: 'warn',
    evaluate: (snapshot, config) => {
      if (snapshot === null) return null;
      const cost = snapshot.totals.totalCostUsd ?? 0;
      if (cost >= config.costThresholdUsd) {
        return `Fleet cost $${cost.toFixed(2)} exceeded threshold $${config.costThresholdUsd.toFixed(2)}`;
      }
      return null;
    },
  },
  /**
   * W3 #2 (RFC hq-improvements-2026-09.md): throughput-budget rule.
   *
   * Fires when the fleet's cumulative `totalCostUsd` meets or exceeds the
   * operator-configured `throughputBudgetUsd`. Distinct from
   * `fleet-cost-threshold` (which is a per-call threshold, default 50):
   * the throughput-budget rule is the operator's hard ceiling for a
   * billing period, host-wired via `alerts-config.json` (W2 #13).
   *
   * Disabled by default (default `throughputBudgetUsd: 0` → rule is a
   * no-op). When the operator sets a positive budget in
   * `alerts-config.json`, the rule fires once the fleet crosses that
   * ceiling.
   *
   * `throughputLookbackMinutes` is wired into the config for future
   * timeseries-based projection (rate-per-minute extrapolation); the
   * current implementation reads only the absolute `totalCostUsd`
   * from the snapshot because the snapshot does not yet carry a
   * per-minute rate field. When the snapshot gains that field, the
   * rule can be extended to fire on projected spend, not just absolute.
   */
  {
    id: 'fleet-throughput-budget',
    severity: 'warn',
    evaluate: (snapshot, config) => {
      if (snapshot === null) return null;
      // Disabled when the operator hasn't set a budget.
      if (config.throughputBudgetUsd <= 0) return null;
      const cost = snapshot.totals.totalCostUsd ?? 0;
      if (cost >= config.throughputBudgetUsd) {
        return `Fleet spend $${cost.toFixed(2)} exceeded throughput budget $${config.throughputBudgetUsd.toFixed(2)} (lookback ${config.throughputLookbackMinutes}min)`;
      }
      return null;
    },
  },
  {
    id: 'all-machines-stale',
    severity: 'warn',
    evaluate: (snapshot, config, now) => {
      if (snapshot === null) return null;
      const machines = snapshot.machines ?? [];
      if (machines.length === 0) return null;
      const cutoff = now - config.staleMachineSeconds * 1000;
      const stale = machines.filter((m) => Date.parse(m.lastActivityAt) < cutoff);
      if (stale.length === machines.length) {
        return `All ${machines.length} machine(s) silent for ${config.staleMachineSeconds}s`;
      }
      return null;
    },
  },
  {
    id: 'high-concurrency',
    severity: 'info',
    evaluate: (snapshot, config) => {
      if (snapshot === null || config.maxAgents <= 0) return null;
      const agents = snapshot.totals.activeAgents ?? 0;
      if (agents >= config.maxAgents) {
        return `High fleet concurrency: ${agents} active agents (limit ${config.maxAgents})`;
      }
      return null;
    },
  },
  {
    id: 'fleet-failure-spike',
    severity: 'warn',
    evaluate: (snapshot) => {
      if (snapshot === null) return null;
      // Aggregate failed tasks across all reported fleets.
      const fleets = snapshot.fleets ?? [];
      const failed = fleets.reduce((sum, f) => sum + f.failedTasks, 0);
      if (failed >= 5) {
        return `${failed} failed task(s) across the fleet`;
      }
      return null;
    },
  },
  {
    id: 'token-expired-present',
    severity: 'error',
    evaluate: (snapshot) => {
      if (snapshot === null) return null;
      const stats = snapshot.totals.tokenStats;
      if (stats === undefined || stats.expired <= 0) return null;
      return `${stats.expired} expired token(s) filtered from live auth — rotate or revoke them`;
    },
  },
  {
    id: 'token-expiry-imminent',
    severity: 'warn',
    evaluate: (snapshot, config) => {
      if (snapshot === null) return null;
      if (config.tokenExpiryWarningHours <= 0) return null;
      const stats = snapshot.totals.tokenStats;
      if (stats === undefined || stats.expiringSoon <= 0) return null;
      return `${stats.expiringSoon} token(s) expire within ${config.tokenExpiryWarningHours}h — mint replacements before they lapse`;
    },
  },
];

/**
 * In-memory alert state. Tracks which rules are currently firing so the same
 * alert is not re-emitted every tick — only state transitions (cleared →
 * firing) emit. Optionally persists to disk via a callback.
 */
export class HqAlertEngine {
  private readonly active = new Map<string, HqAlert>();
  private readonly history: HqAlert[] = [];
  private readonly maxHistory: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onAlert: (alert: HqAlert) => void;
  private readonly onPersist?: ((alert: HqAlert) => void) | undefined;
  // W2 #12 (RFC hq-improvements-2026-09.md): per-rule snooze. A rule whose
  // `snoozedUntil > now` is skipped during evaluation, with no firing or
  // clearing emission. Operators can mute a noisy rule for a bounded window
  // without disabling it entirely. Persisted to `<dataDir>/alerts-config.json`
  // by the owner of that file (see W2 #13).
  private readonly snoozes = new Map<string, number>();
  // W2 #12: hard cap on a single snooze duration. Without this, an operator
  // typo or a hostile script could pass `Number.POSITIVE_INFINITY` and silence
  // a rule forever, defeating the "alerting engine" purpose. Default 24h;
  // tunable via the constructor for tests.
  private readonly maxSnoozeMs: number;

  constructor(opts: {
    onAlert: (alert: HqAlert) => void;
    maxHistory?: number;
    /**
     * Optional durable sink — fires when an alert transitions to firing.
     */
    onPersist?: ((alert: HqAlert) => void) | undefined;
    /**
     * W2 #12: maximum single-call snooze duration in ms. Default 24h.
     * Requests above the cap are clamped to the cap (and surfaced via the
     * return value of {@link snooze}).
     */
    maxSnoozeMs?: number | undefined;
  }) {
    this.onAlert = opts.onAlert;
    this.maxHistory = opts.maxHistory ?? 500;
    this.onPersist = opts.onPersist;
    this.maxSnoozeMs = opts.maxSnoozeMs ?? DEFAULT_MAX_SNOOZE_MS;
  }

  /**
   * Snooze a rule until `untilMs` (epoch ms). A snoozed rule is skipped in
   * every subsequent {@link evaluate} until the deadline passes; it does
   * NOT fire on the way out (unlike a state transition). Snoozing an
   * already-snoozed rule replaces the deadline.
   *
   * Returns the effective deadline after clamping to `maxSnoozeMs`. If the
   * effective deadline differs from the requested one, the caller learns
   * this via `clamped: true` so it can surface it (e.g. "snoozed for 24h,
   * the cap; you asked for 30d").
   *
   * If a rule is currently active (firing), the snooze is recorded but the
   * active entry is NOT immediately cleared — the dashboard may still want
   * to see "this rule was firing when you snoozed it" until the next tick
   * skips it. Clearing on snooze would let a stale alert outlive the snooze.
   */
  snooze(
    ruleId: string,
    untilMs: number,
    now: number = Date.now(),
  ): { effectiveUntilMs: number; clamped: boolean } {
    // Refuse snoozes for unknown rules. Silent acceptance would let an
    // operator typo (`fleet-cost-threshld`) freeze alerting without any
    // signal that the rule doesn't exist.
    const known = RULES.some((r) => r.id === ruleId);
    if (!known) {
      throw new Error(`Unknown alert rule: ${ruleId}`);
    }
    if (!Number.isFinite(untilMs)) {
      throw new Error(`snooze deadline must be a finite epoch-ms; got ${String(untilMs)}`);
    }
    const requested = Math.max(untilMs, now);
    const cap = now + this.maxSnoozeMs;
    const clamped = requested > cap;
    const effectiveUntilMs = clamped ? cap : requested;
    this.snoozes.set(ruleId, effectiveUntilMs);
    return { effectiveUntilMs, clamped };
  }

  /**
   * Clear an active snooze. If `ruleId` is not currently snoozed, this is
   * a no-op (returns false). Returns true if a snooze was cleared.
   *
   * Note: this does NOT immediately fire any cleared-on-snooze rule. The
   * next {@link evaluate} tick will re-evaluate from scratch, so a rule
   * whose condition still holds will refire on that next tick — exactly
   * the desired "I un-muted it; if it's still going off, tell me" behavior.
   */
  unsnooze(ruleId: string): boolean {
    return this.snoozes.delete(ruleId);
  }

  /**
   * True if the rule is currently snoozed. Exposed for tests and for the
   * dashboard's "snoozed until T-12m" badge.
   */
  isSnoozed(ruleId: string, now: number = Date.now()): boolean {
    const until = this.snoozes.get(ruleId);
    if (until === undefined) return false;
    if (until <= now) {
      // Lazy expiry: drop the entry so the map stays bounded. Without this,
      // a long-lived engine accumulates one stale entry per rule.
      this.snoozes.delete(ruleId);
      return false;
    }
    return true;
  }

  /**
   * Snapshot of every active snooze. Returned as a plain object so the
   * dashboard and the persistence layer (W2 #13) don't have to care about
   * the internal Map shape.
   */
  snoozesSnapshot(now: number = Date.now()): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [ruleId, untilMs] of this.snoozes) {
      if (untilMs > now) out[ruleId] = untilMs;
    }
    return out;
  }

  /**
   * Seed snoozes on boot (or when the persisted file is reloaded). Existing
   * entries are NOT cleared — a fresh load from disk is authoritative, but
   * in-flight snoozes set via the API between file writes are preserved.
   *
   * Past-deadline entries are filtered out at seed time, since the engine's
   * "now" on boot may be later than the persisted deadline.
   */
  seedSnoozes(snoozes: Readonly<Record<string, number>>, now: number = Date.now()): void {
    for (const [ruleId, untilMs] of Object.entries(snoozes)) {
      if (!Number.isFinite(untilMs)) continue;
      if (untilMs <= now) continue;
      this.snoozes.set(ruleId, untilMs);
    }
  }

  /**
   * Evaluate all rules against the snapshot. Emits (via the `onAlert`
   * callback) only for rules that newly transition to firing. Clears rules
   * that are no longer firing. Returns the list of newly-fired alerts.
   *
   * Snoozed rules are skipped entirely (no firing, no clearing emission)
   * to match the operator's intent: "silence this until I unmute it."
   */
  evaluate(
    snapshot: HqSnapshot | null,
    config?: HqAlertRuleConfig,
    now: number = Date.now(),
  ): HqAlert[] {
    const resolved = resolveConfig(config);
    const fired: HqAlert[] = [];
    const firingIds = new Set<string>();

    for (const rule of RULES) {
      // W2 #12: snoozed rules skip evaluation. We do NOT clear the
      // `active` entry on snooze — if the rule was firing when snoozed,
      // the active record stays until the snooze expires and the rule
      // re-evaluates fresh. This matches the dashboard's "snoozed while
      // firing" badge.
      if (this.isSnoozed(rule.id, now)) continue;

      const message = rule.evaluate(snapshot, resolved, now);
      if (message !== null) {
        firingIds.add(rule.id);
        const existing = this.active.get(rule.id);
        if (existing === undefined) {
          // New transition → emit.
          const alert: HqAlert = {
            id: `${rule.id}-${now}`,
            ruleId: rule.id,
            severity: rule.severity,
            message,
            firstFiredAt: now,
            lastFiredAt: now,
          };
          this.active.set(rule.id, alert);
          this.history.push(alert);
          if (this.history.length > this.maxHistory)
            this.history.splice(0, this.history.length - this.maxHistory);
          fired.push(alert);
          this.onAlert(alert);
          this.onPersist?.(alert);
        } else {
          // Already firing — refresh timestamp, don't re-emit.
          existing.lastFiredAt = now;
        }
      }
    }

    // Clear rules no longer firing.
    //
    // W2 #12: a rule that was firing when snoozed (so it has an active
    // entry but was SKIPPED in the per-rule loop above — and therefore
    // has no entry in `firingIds`) must NOT be cleared here. The whole
    // point of snoozing is to preserve the "this rule was firing when I
    // muted it" badge on the dashboard until the snooze expires and the
    // rule re-evaluates fresh. Without this guard, a cost-drop evaluate
    // while snoozed would silently drop the active entry — exactly the
    // bug the W2 #12 test "evaluate skips snoozed rules entirely" guards.
    for (const id of Array.from(this.active.keys())) {
      if (!firingIds.has(id) && !this.isSnoozed(id, now)) {
        this.active.delete(id);
      }
    }

    return fired;
  }

  /** Currently-active (firing) alerts. */
  activeAlerts(): HqAlert[] {
    return Array.from(this.active.values());
  }

  /** Historical alerts (newest-last), capped at maxHistory. */
  recentAlerts(limit = 100): HqAlert[] {
    return this.history.slice(-limit);
  }

  /** Seed the history from a durable store on boot (no alert callbacks fired). */
  seed(alerts: readonly HqAlert[]): void {
    for (const alert of alerts) {
      this.history.push(alert);
    }
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
  }

  /**
   * Start periodic evaluation against a snapshot getter. The timer is
   * unref'd so it never keeps the process alive. Returns a disposer.
   */
  startPeriodic(
    getSnapshot: () => HqSnapshot | null,
    config?: HqAlertRuleConfig | (() => HqAlertRuleConfig | undefined),
    intervalMs = 15_000,
  ): () => void {
    if (this.timer !== null) return () => undefined;
    const tick = (): void => {
      try {
        const cfg = typeof config === 'function' ? config() : config;
        this.evaluate(getSnapshot(), cfg);
      } catch {
        /* best-effort — alert evaluation must never crash the server */
      }
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    return () => {
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }
}

/** Map an internal {@link HqAlert} to the wire {@link HqAlertMessage}. */
export function toAlertMessage(alert: HqAlert): HqAlertMessage {
  return {
    type: 'hq.alert',
    severity: alert.severity,
    message: `[${alert.ruleId}] ${alert.message}`,
    timestamp: new Date(alert.lastFiredAt).toISOString(),
  };
}
