import { describe, expect, it, vi } from 'vitest';
import { HqAlertEngine, type HqSnapshot, toAlertMessage } from '../src/index.js';

function snapshot(
  overrides: Partial<HqSnapshot['totals']> = {},
  machines: { lastActivityAt: string }[] = [],
  fleets: { failedTasks: number }[] = [],
): HqSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    clients: [],
    projects: [],
    sessions: [],
    fleets,
    mailboxes: [],
    machines,
    liveSessions: [],
    totals: {
      activeProjects: 0,
      activeClients: 0,
      activeSessions: 0,
      activeSubagents: 0,
      unreadMailboxMessages: 0,
      incompleteMailboxMessages: 0,
      totalCostUsd: 0,
      ...overrides,
    },
  } as HqSnapshot;
}

describe('HqAlertEngine', () => {
  it('fires fleet-cost-threshold when cost exceeds the limit', () => {
    const onAlert = vi.fn();
    const engine = new HqAlertEngine({ onAlert });
    const fired = engine.evaluate(snapshot({ totalCostUsd: 75 }), { costThresholdUsd: 50 });
    expect(fired).toHaveLength(1);
    expect(fired[0]!.ruleId).toBe('fleet-cost-threshold');
    expect(fired[0]!.severity).toBe('warn');
    expect(onAlert).toHaveBeenCalledTimes(1);
  });

  it('does not fire when cost is below threshold', () => {
    const engine = new HqAlertEngine({ onAlert: () => undefined });
    const fired = engine.evaluate(snapshot({ totalCostUsd: 10 }), { costThresholdUsd: 50 });
    expect(fired).toHaveLength(0);
  });

  it('dedups — does not re-emit an already-active alert', () => {
    const onAlert = vi.fn();
    const engine = new HqAlertEngine({ onAlert });
    engine.evaluate(snapshot({ totalCostUsd: 75 }), { costThresholdUsd: 50 });
    const fired = engine.evaluate(snapshot({ totalCostUsd: 80 }), { costThresholdUsd: 50 });
    expect(fired).toHaveLength(0);
    expect(onAlert).toHaveBeenCalledTimes(1); // only the first transition
  });

  it('clears an alert when the condition no longer holds', () => {
    const engine = new HqAlertEngine({ onAlert: () => undefined });
    engine.evaluate(snapshot({ totalCostUsd: 75 }), { costThresholdUsd: 50 });
    expect(engine.activeAlerts()).toHaveLength(1);
    engine.evaluate(snapshot({ totalCostUsd: 30 }), { costThresholdUsd: 50 });
    expect(engine.activeAlerts()).toHaveLength(0);
  });

  it('re-emits after clearing and re-firing', () => {
    const onAlert = vi.fn();
    const engine = new HqAlertEngine({ onAlert });
    engine.evaluate(snapshot({ totalCostUsd: 75 }), { costThresholdUsd: 50 });
    engine.evaluate(snapshot({ totalCostUsd: 30 }), { costThresholdUsd: 50 });
    const fired = engine.evaluate(snapshot({ totalCostUsd: 90 }), { costThresholdUsd: 50 });
    expect(fired).toHaveLength(1);
    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  it('fires all-machines-stale when every machine is silent', () => {
    const engine = new HqAlertEngine({ onAlert: () => undefined });
    const old = new Date(Date.now() - 200_000).toISOString();
    const snap = snapshot({}, [{ lastActivityAt: old }, { lastActivityAt: old }]);
    const fired = engine.evaluate(snap, { staleMachineSeconds: 120 });
    expect(fired.some((a) => a.ruleId === 'all-machines-stale')).toBe(true);
  });

  it('does not fire stale when at least one machine is fresh', () => {
    const engine = new HqAlertEngine({ onAlert: () => undefined });
    const old = new Date(Date.now() - 200_000).toISOString();
    const fresh = new Date().toISOString();
    const snap = snapshot({}, [{ lastActivityAt: old }, { lastActivityAt: fresh }]);
    const fired = engine.evaluate(snap, { staleMachineSeconds: 120 });
    expect(fired.some((a) => a.ruleId === 'all-machines-stale')).toBe(false);
  });

  it('fires fleet-failure-spike when >= 5 failed tasks', () => {
    const engine = new HqAlertEngine({ onAlert: () => undefined });
    const snap = snapshot({}, [], [{ failedTasks: 3 }, { failedTasks: 3 }]);
    const fired = engine.evaluate(snap);
    expect(fired.some((a) => a.ruleId === 'fleet-failure-spike')).toBe(true);
  });

  it('returns null-safe results for a null snapshot', () => {
    const engine = new HqAlertEngine({ onAlert: () => undefined });
    expect(engine.evaluate(null)).toEqual([]);
  });

  it('keeps history capped at maxHistory', () => {
    const engine = new HqAlertEngine({ onAlert: () => undefined, maxHistory: 3 });
    // Toggle cost above/below threshold to create clear→fire transitions.
    for (let i = 0; i < 5; i++) {
      engine.evaluate(snapshot({ totalCostUsd: 75 }), { costThresholdUsd: 50 });
      engine.evaluate(snapshot({ totalCostUsd: 10 }), { costThresholdUsd: 50 });
    }
    expect(engine.recentAlerts().length).toBeLessThanOrEqual(3);
  });

  it('toAlertMessage maps to the wire format', () => {
    const msg = toAlertMessage({
      id: 'x-1',
      ruleId: 'fleet-cost-threshold',
      severity: 'warn',
      message: 'cost too high',
      firstFiredAt: 1000,
      lastFiredAt: 2000,
    });
    expect(msg.type).toBe('hq.alert');
    expect(msg.severity).toBe('warn');
    expect(msg.message).toContain('fleet-cost-threshold');
  });

  // ── W2 #12: snooze / unsnooze ──────────────────────────────────────
  describe('snooze (W2 #12)', () => {
    it('snoozes a firing rule and skips it on subsequent evaluates', () => {
      const onAlert = vi.fn();
      const engine = new HqAlertEngine({ onAlert });
      // Fire once first so the rule is in `active`.
      engine.evaluate(snapshot({ totalCostUsd: 75 }), { costThresholdUsd: 50 });
      expect(engine.activeAlerts()).toHaveLength(1);

      const now = Date.now();
      const result = engine.snooze('fleet-cost-threshold', now + 60_000, now);
      expect(result.effectiveUntilMs).toBe(now + 60_000);
      expect(result.clamped).toBe(false);

      // The next evaluate must NOT re-emit and must NOT clear the existing
      // active entry (the rule was firing when snoozed; the active record
      // stays until the snooze expires).
      const fired = engine.evaluate(snapshot({ totalCostUsd: 90 }), { costThresholdUsd: 50 });
      expect(fired).toHaveLength(0);
      expect(onAlert).toHaveBeenCalledTimes(1);
      expect(engine.isSnoozed('fleet-cost-threshold', now)).toBe(true);
    });

    it('rejects snooze for an unknown rule id', () => {
      const engine = new HqAlertEngine({ onAlert: () => undefined });
      expect(() => engine.snooze('not-a-rule', Date.now() + 60_000)).toThrow(/Unknown alert rule/);
    });

    it('rejects non-finite deadlines (NaN, Infinity)', () => {
      const engine = new HqAlertEngine({ onAlert: () => undefined });
      expect(() => engine.snooze('fleet-cost-threshold', Number.NaN)).toThrow(/finite/);
      expect(() => engine.snooze('fleet-cost-threshold', Number.POSITIVE_INFINITY)).toThrow(
        /finite/,
      );
    });

    it('clamps over-cap requests and reports clamped: true', () => {
      const engine = new HqAlertEngine({ onAlert: () => undefined, maxSnoozeMs: 1_000 });
      const now = Date.now();
      const result = engine.snooze('fleet-cost-threshold', now + 10_000_000, now);
      expect(result.clamped).toBe(true);
      expect(result.effectiveUntilMs).toBe(now + 1_000);
    });

    it('lazily expires past-deadline entries on isSnoozed()', () => {
      const engine = new HqAlertEngine({ onAlert: () => undefined });
      const now = Date.now();
      engine.snooze('fleet-cost-threshold', now + 100, now);
      expect(engine.isSnoozed('fleet-cost-threshold', now)).toBe(true);
      // After the deadline, isSnoozed returns false and drops the entry.
      expect(engine.isSnoozed('fleet-cost-threshold', now + 200)).toBe(false);
      // A subsequent evaluate with the rule firing again must re-emit
      // because the snooze is no longer active.
      const onAlert = vi.fn();
      const reengine = new HqAlertEngine({ onAlert });
      reengine.snooze('fleet-cost-threshold', now + 100, now);
      const fired = reengine.evaluate(
        snapshot({ totalCostUsd: 75 }),
        { costThresholdUsd: 50 },
        now + 200,
      );
      expect(fired.some((a) => a.ruleId === 'fleet-cost-threshold')).toBe(true);
    });

    it('unsnooze() returns true when a snooze was cleared, false otherwise', () => {
      const engine = new HqAlertEngine({ onAlert: () => undefined });
      const now = Date.now();
      engine.snooze('fleet-cost-threshold', now + 60_000, now);
      expect(engine.unsnooze('fleet-cost-threshold')).toBe(true);
      expect(engine.unsnooze('fleet-cost-threshold')).toBe(false);
    });

    it('snoozesSnapshot() reflects only non-expired entries', () => {
      const engine = new HqAlertEngine({ onAlert: () => undefined });
      const now = Date.now();
      engine.snooze('fleet-cost-threshold', now + 60_000, now);
      engine.snooze('all-machines-stale', now + 100, now);
      const snap = engine.snoozesSnapshot(now + 200);
      expect(snap).toEqual({ 'fleet-cost-threshold': now + 60_000 });
    });

    it('seedSnoozes() filters past-deadline entries and accepts future ones', () => {
      const engine = new HqAlertEngine({ onAlert: () => undefined });
      const now = Date.now();
      engine.seedSnoozes(
        {
          'fleet-cost-threshold': now + 60_000,
          'all-machines-stale': now - 1, // expired
          'fleet-failure-spike': Number.NaN, // invalid
        },
        now,
      );
      expect(engine.isSnoozed('fleet-cost-threshold', now)).toBe(true);
      expect(engine.isSnoozed('all-machines-stale', now)).toBe(false);
      expect(engine.isSnoozed('fleet-failure-spike', now)).toBe(false);
    });

    it('evaluate skips snoozed rules entirely (no firing, no clearing)', () => {
      // Set up: rule A firing, rule B not firing. Snooze rule A.
      // The active map for rule A must NOT be cleared (snooze ≠ resolution).
      const engine = new HqAlertEngine({ onAlert: () => undefined });
      const now = Date.now();
      engine.evaluate(snapshot({ totalCostUsd: 75 }), { costThresholdUsd: 50 }, now);
      engine.snooze('fleet-cost-threshold', now + 60_000, now);
      // Cost drops below threshold — the rule WOULD clear if not snoozed.
      engine.evaluate(snapshot({ totalCostUsd: 10 }), { costThresholdUsd: 50 }, now + 1_000);
      // Active entry persists because the snooze skipped the clearing transition.
      expect(engine.activeAlerts().some((a) => a.ruleId === 'fleet-cost-threshold')).toBe(true);
      // Now unsnooze and re-evaluate: rule clears naturally.
      engine.unsnooze('fleet-cost-threshold');
      engine.evaluate(snapshot({ totalCostUsd: 10 }), { costThresholdUsd: 50 }, now + 2_000);
      expect(engine.activeAlerts().some((a) => a.ruleId === 'fleet-cost-threshold')).toBe(false);
    });
  });

  // ── W3 #2: throughput-budget rule ─────────────────────────────────
  describe('fleet-throughput-budget (W3 #2)', () => {
    it('is a no-op when throughputBudgetUsd is 0 (default, disabled)', () => {
      // Default config has throughputBudgetUsd: 0; the rule must NOT fire
      // even when totalCostUsd is large.
      const engine = new HqAlertEngine({ onAlert: () => undefined });
      const fired = engine.evaluate(snapshot({ totalCostUsd: 999_999 }));
      expect(fired.some((a) => a.ruleId === 'fleet-throughput-budget')).toBe(false);
    });

    it('fires when totalCostUsd meets or exceeds throughputBudgetUsd', () => {
      const engine = new HqAlertEngine({ onAlert: () => undefined });
      const fired = engine.evaluate(snapshot({ totalCostUsd: 150 }), {
        throughputBudgetUsd: 100,
      });
      expect(fired.some((a) => a.ruleId === 'fleet-throughput-budget')).toBe(true);
      const alert = fired.find((a) => a.ruleId === 'fleet-throughput-budget');
      expect(alert?.severity).toBe('warn');
      expect(alert?.message).toContain('150');
      expect(alert?.message).toContain('100');
    });

    it('does not fire when totalCostUsd is below throughputBudgetUsd', () => {
      const engine = new HqAlertEngine({ onAlert: () => undefined });
      const fired = engine.evaluate(snapshot({ totalCostUsd: 50 }), {
        throughputBudgetUsd: 100,
      });
      expect(fired.some((a) => a.ruleId === 'fleet-throughput-budget')).toBe(false);
    });

    it('returns null-safe results for a null snapshot', () => {
      const engine = new HqAlertEngine({ onAlert: () => undefined });
      const fired = engine.evaluate(null, { throughputBudgetUsd: 100 });
      expect(fired.some((a) => a.ruleId === 'fleet-throughput-budget')).toBe(false);
    });

    it('respects host-wired threshold via alerts-config.json semantics', () => {
      // The threshold is host-wired via HqAlertRuleConfig. This test pins the
      // contract that operator-set thresholds override the default (0).
      const engine = new HqAlertEngine({ onAlert: () => undefined });
      const fired = engine.evaluate(snapshot({ totalCostUsd: 200 }), {
        throughputBudgetUsd: 200,
        throughputLookbackMinutes: 60,
      });
      expect(fired.some((a) => a.ruleId === 'fleet-throughput-budget')).toBe(true);
      // The message includes the lookback window for operator context.
      const alert = fired.find((a) => a.ruleId === 'fleet-throughput-budget');
      expect(alert?.message).toContain('60min');
    });

    it('is distinct from fleet-cost-threshold (different intent)', () => {
      // fleet-cost-threshold fires at a per-call threshold (default 50).
      // fleet-throughput-budget fires at the operator's hard ceiling
      // (default disabled). Both can be active simultaneously without
      // deduping; the dashboard renders both cards.
      const engine = new HqAlertEngine({ onAlert: () => undefined });
      const fired = engine.evaluate(snapshot({ totalCostUsd: 200 }), {
        costThresholdUsd: 50,
        throughputBudgetUsd: 100,
      });
      const ids = fired.map((a) => a.ruleId);
      expect(ids).toContain('fleet-cost-threshold');
      expect(ids).toContain('fleet-throughput-budget');
    });
  });
});
