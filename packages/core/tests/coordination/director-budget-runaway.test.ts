import { describe, expect, it } from 'vitest';
import { DirectorBudgetPolicy } from '../../src/coordination/director/director-budget-policy.js';
import { FleetBus, FleetUsageAggregator } from '../../src/coordination/fleet-bus.js';

/**
 * Runaway guards for DirectorBudgetPolicy.
 *
 * Two holes let a looping subagent run for hours despite a configured budget:
 *
 *  1. `handleTimeoutThreshold` was gated ONLY by a heartbeat whose progress
 *     signal is the raw `tool.executed` count. A subagent spinning on the same
 *     tool advances that counter exactly as fast as one doing real work, so the
 *     gate always passed and the deadline doubled — repeatedly, up to the 24h
 *     ceiling.
 *
 *  2. The non-timeout path DELETED the per-kind grant counter when it denied.
 *     The next threshold event for that kind therefore started a fresh
 *     allowance of `maxBudgetExtensions` grants, so the ceiling could never
 *     latch.
 */

function flushMacro(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function toolEvent(subagentId: string) {
  return { subagentId, ts: Date.now(), type: 'tool.executed', payload: {} };
}

function thresholdPayload(kind: string, used: number, limit: number) {
  return {
    kind,
    used,
    limit,
    timeoutMs: 60_000,
    extended: undefined as Record<string, unknown> | undefined,
    denied: false,
    extend(extra: Record<string, unknown>) {
      this.extended = extra;
    },
    deny() {
      this.denied = true;
    },
  };
}

function makePolicy(maxBudgetExtensions: number) {
  const fleet = new FleetBus();
  const usage = new FleetUsageAggregator(fleet);
  const policy = new DirectorBudgetPolicy({
    fleet,
    usage,
    maxBudgetExtensions,
    maxFleetCostUsd: Number.POSITIVE_INFINITY,
    currentSessionId: () => undefined,
  });
  policy.start();
  return { fleet, policy };
}

describe('DirectorBudgetPolicy runaway guards', () => {
  it('stops extending the wall-clock deadline once the grant ceiling is spent', async () => {
    const maxExtensions = 3;
    const { fleet, policy } = makePolicy(maxExtensions);
    try {
      const sub = 'sub-busy-loop';
      let limit = 60_000;
      const outcomes: Array<'extend' | 'deny'> = [];

      // Simulate a wedged agent: it keeps firing tools (so the heartbeat always
      // shows "progress") but never finishes. Ask for far more extensions than
      // the ceiling allows.
      for (let round = 0; round < maxExtensions + 4; round++) {
        fleet.emit(toolEvent(sub));
        const payload = thresholdPayload('timeout', limit, limit);
        fleet.emit({
          subagentId: sub,
          ts: Date.now(),
          type: 'budget.threshold_reached',
          payload,
        });
        await flushMacro();
        if (payload.extended) {
          outcomes.push('extend');
          limit = payload.extended['timeoutMs'] as number;
        } else {
          expect(payload.denied).toBe(true);
          outcomes.push('deny');
        }
      }

      expect(outcomes.filter((o) => o === 'extend')).toHaveLength(maxExtensions);
      // Everything after the ceiling is a deny — the loop dies instead of
      // doubling its way to the 24h ceiling.
      expect(outcomes.slice(maxExtensions).every((o) => o === 'deny')).toBe(true);
      // 60s doubled three times, not "hours".
      expect(limit).toBe(60_000 * 2 ** maxExtensions);
    } finally {
      policy.dispose();
    }
  });

  it('keeps the per-kind grant counter after a deny so the ceiling latches', async () => {
    const maxExtensions = 2;
    const { fleet, policy } = makePolicy(maxExtensions);
    try {
      const sub = 'sub-iteration-hog';
      const outcomes: Array<'extend' | 'deny'> = [];

      for (let round = 0; round < maxExtensions + 3; round++) {
        const payload = thresholdPayload('iterations', 100, 100);
        fleet.emit({
          subagentId: sub,
          ts: Date.now(),
          type: 'budget.threshold_reached',
          payload,
        });
        await flushMacro();
        outcomes.push(payload.extended ? 'extend' : 'deny');
      }

      expect(outcomes).toEqual(['extend', 'extend', 'deny', 'deny', 'deny']);
    } finally {
      policy.dispose();
    }
  });

  it('still denies a genuinely wedged agent that executes no tools at all', async () => {
    const { fleet, policy } = makePolicy(5);
    try {
      const sub = 'sub-hung';
      fleet.emit(toolEvent(sub));

      const first = thresholdPayload('timeout', 60_000, 60_000);
      fleet.emit({
        subagentId: sub,
        ts: Date.now(),
        type: 'budget.threshold_reached',
        payload: first,
      });
      await flushMacro();
      expect(first.extended).toBeTruthy();

      // No further tool.executed — the heartbeat cannot advance.
      const second = thresholdPayload('timeout', 120_000, 120_000);
      fleet.emit({
        subagentId: sub,
        ts: Date.now(),
        type: 'budget.threshold_reached',
        payload: second,
      });
      await flushMacro();
      expect(second.extended).toBeUndefined();
      expect(second.denied).toBe(true);
    } finally {
      policy.dispose();
    }
  });
});
