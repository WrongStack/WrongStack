import { describe, expect, it, vi } from 'vitest';
import { HqAlertEngine, toAlertMessage, type HqSnapshot } from '../../src/hq/index.js';

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
});
