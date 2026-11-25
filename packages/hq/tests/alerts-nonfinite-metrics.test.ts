import { describe, expect, it } from 'vitest';
import { HqAlertEngine } from '../src/alerts.js';
import type { HqSnapshot } from '../src/protocol.js';

describe('HqAlertEngine non-finite snapshot metrics guard', () => {
  it('skips Infinity cost alerts and ignores NaN fleet failedTasks when aggregating', () => {
    const snapshot = {
      totals: { totalCostUsd: Number.POSITIVE_INFINITY, activeAgents: 0 },
      machines: [],
      fleets: [{ failedTasks: Number.NaN }, { failedTasks: 10 }],
      projects: [],
    } as unknown as HqSnapshot;

    const engine = new HqAlertEngine({
      getSnapshot: () => snapshot,
      onAlert: () => {},
      config: { costThresholdUsd: 50, throughputBudgetUsd: 50 },
    });
    const alerts = engine.evaluate(snapshot, { costThresholdUsd: 50, throughputBudgetUsd: 50 });

    expect(alerts.some((a) => a.message.includes('Infinity'))).toBe(false);
    expect(alerts.some((a) => a.ruleId === 'fleet-failure-spike')).toBe(true);
  });
});
