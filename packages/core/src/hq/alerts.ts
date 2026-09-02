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
}

/** The fully-resolved config passed to rule.evaluate (no optional fields). */
type ResolvedAlertConfig = Required<
  Pick<
    HqAlertRuleConfig,
    'costThresholdUsd' | 'staleMachineSeconds' | 'maxAgents' | 'tokenExpiryWarningHours'
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
};

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

  constructor(opts: {
    onAlert: (alert: HqAlert) => void;
    maxHistory?: number;
    /** Optional durable sink — fires when an alert transitions to firing. */
    onPersist?: ((alert: HqAlert) => void) | undefined;
  }) {
    this.onAlert = opts.onAlert;
    this.maxHistory = opts.maxHistory ?? 500;
    this.onPersist = opts.onPersist;
  }

  /**
   * Evaluate all rules against the snapshot. Emits (via the `onAlert`
   * callback) only for rules that newly transition to firing. Clears rules
   * that are no longer firing. Returns the list of newly-fired alerts.
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
    for (const id of Array.from(this.active.keys())) {
      if (!firingIds.has(id)) {
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
