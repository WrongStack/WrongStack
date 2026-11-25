import { describe, expect, it } from 'vitest';
import { HqAlertEngine } from '../src/alerts.js';
import type { HqSnapshot } from '../src/protocol.js';

function makeSnapshot(totalCostUsd: number, lastActivityAt: string): HqSnapshot {
  return {
    type: 'hq.snapshot',
    generatedAt: '2026-11-25T12:00:00.000Z',
    totals: { machines: 1, projects: 1, activeAgents: 3, totalCostUsd },
    machines: [
      {
        machineId: 'm-1',
        hostname: 'box-1',
        connectedAt: '2026-11-25T11:00:00.000Z',
        lastActivityAt,
        projects: 1,
        activeAgents: 3,
        totalCostUsd,
      },
    ],
    projects: [],
    fleets: [],
  } as unknown as HqSnapshot;
}

describe('HqAlertEngine non-finite config thresholds (F1849)', () => {
  it('falls back to default thresholds when config values are NaN, Infinity, or negative', () => {
    const now = Date.parse('2026-11-25T12:00:00.000Z');
    const snap = makeSnapshot(75, '2026-11-25T11:50:00.000Z');

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5]) {
      const engine = new HqAlertEngine({ onAlert: () => {} });
      const ids = engine
        .evaluate(snap, { costThresholdUsd: bad, staleMachineSeconds: bad }, now)
        .map((a) => a.ruleId);
      expect(ids).toContain('fleet-cost-threshold');
      expect(ids).toContain('all-machines-stale');
    }
  });

  it('preserves explicit zero for opt-in disabled rules', () => {
    const now = Date.parse('2026-11-25T12:00:00.000Z');
    const snap = makeSnapshot(75, '2026-11-25T11:59:30.000Z');
    const engine = new HqAlertEngine({ onAlert: () => {} });
    const ids = engine
      .evaluate(snap, { maxAgents: 0, throughputBudgetUsd: 0 }, now)
      .map((a) => a.ruleId);
    expect(ids).not.toContain('high-concurrency');
    expect(ids).not.toContain('fleet-throughput-budget');
  });
});
