import { describe, expect, it } from 'vitest';
import { DirectorBudgetPolicy } from '../../src/coordination/director/director-budget-policy.js';
import { FleetBus, FleetUsageAggregator } from '../../src/coordination/fleet-bus.js';

/**
 * Focused unit test for DirectorBudgetPolicy.removeSubagent().
 *
 * The e2e suite (delegate-timeout-e2e.test.ts) exercises the grant/deny
 * paths but never calls removeSubagent(). This test proves that all four
 * per-subagent Maps are cleaned on retirement — the specific bug that was
 * fixed when three closure-scoped Maps (extendCounts, progressBySubagent,
 * lastTimeoutProgress) were promoted to class fields so removeSubagent()
 * could reach them. Without this coverage, a regression that re-introduces
 * closure-locals would leak per-subagent state for the session lifetime
 * with no test failing.
 *
 * White-box access to the private Maps is intentional and necessary: the
 * behavioral consequence of stale entries is subtle (memory growth, and
 * incorrect extension counting only if an id is reused), so indirect
 * testing through public methods alone cannot distinguish "cleaned" from
 * "leaked but idempotent."
 */

/** Flush pending setImmediate callbacks used by grantBoundedExtension / handleTimeoutThreshold. */
function flushMacro(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Minimal FleetEvent for tool.executed. */
function toolEvent(subagentId: string): {
  subagentId: string;
  ts: number;
  type: string;
  payload: unknown;
} {
  return {
    subagentId,
    ts: Date.now(),
    type: 'tool.executed',
    payload: {},
  };
}

/** A mock budget.threshold_reached payload that tracks extend/deny calls. */
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

/**
 * White-box view of the four per-subagent Maps. The test must read them
 * directly to prove cleanup — there is no public getter for the three
 * heartbeat/counter Maps.
 */
interface PolicyMaps {
  extendTotals: Map<string, number>;
  extendCounts: Map<string, number>;
  progressBySubagent: Map<string, number>;
  lastTimeoutProgress: Map<string, number>;
}

function mapsOf(policy: DirectorBudgetPolicy): PolicyMaps {
  return policy as unknown as PolicyMaps;
}

describe('DirectorBudgetPolicy.removeSubagent() cleanup', () => {
  it('clears all four per-subagent Maps on removal', async () => {
    const fleet = new FleetBus();
    const usage = new FleetUsageAggregator(fleet);
    const policy = new DirectorBudgetPolicy({
      fleet,
      usage,
      maxBudgetExtensions: 12,
      maxFleetCostUsd: Number.POSITIVE_INFINITY,
      currentSessionId: () => undefined,
    });
    policy.start();
    const maps = mapsOf(policy);

    try {
      const sub = 'sub-retire-me';

      // 1. Populate progressBySubagent: emit tool.executed.
      fleet.emit(toolEvent(sub));
      fleet.emit(toolEvent(sub));
      expect(maps.progressBySubagent.get(sub)).toBe(2);

      // 2. Populate lastTimeoutProgress + extendTotals: emit a timeout
      //    threshold. The heartbeat gate passes (progress 2 > default -1).
      const timeoutPayload = thresholdPayload('timeout', 1000, 5000);
      fleet.emit({
        subagentId: sub,
        ts: Date.now(),
        type: 'budget.threshold_reached',
        payload: timeoutPayload,
      });
      await flushMacro();
      expect(maps.lastTimeoutProgress.has(`${sub}:timeout`)).toBe(true);
      expect(maps.extendTotals.get(sub)).toBe(1);

      // 3. Populate extendCounts + extendTotals: emit an iterations threshold.
      const iterPayload = thresholdPayload('iterations', 100, 100);
      fleet.emit({
        subagentId: sub,
        ts: Date.now(),
        type: 'budget.threshold_reached',
        payload: iterPayload,
      });
      await flushMacro();
      expect(maps.extendCounts.has(`${sub}:iterations`)).toBe(true);
      expect(maps.extendTotals.get(sub)).toBe(2);

      // Sanity: the public API also reflects the extension count.
      expect(policy.extensionsFor(sub)).toBe(2);

      // ── Act: remove the subagent ──────────────────────────────────
      policy.removeSubagent(sub);

      // ── Assert: every Map is clean for this subagent ──────────────
      expect(maps.extendTotals.has(sub)).toBe(false);
      expect(maps.progressBySubagent.has(sub)).toBe(false);
      expect(maps.extendCounts.has(`${sub}:iterations`)).toBe(false);
      expect(maps.lastTimeoutProgress.has(`${sub}:timeout`)).toBe(false);

      // The public API must agree.
      expect(policy.extensionsFor(sub)).toBe(0);
    } finally {
      policy.dispose();
      usage.dispose();
    }
  });

  it('does not affect other subagents when removing one (isolation)', async () => {
    const fleet = new FleetBus();
    const usage = new FleetUsageAggregator(fleet);
    const policy = new DirectorBudgetPolicy({
      fleet,
      usage,
      maxBudgetExtensions: 12,
      maxFleetCostUsd: Number.POSITIVE_INFINITY,
      currentSessionId: () => undefined,
    });
    policy.start();
    const maps = mapsOf(policy);

    try {
      const keep = 'sub-keep';
      const remove = 'sub-remove';

      // Populate both subagents across all four Maps.
      for (const sub of [keep, remove]) {
        fleet.emit(toolEvent(sub));
        fleet.emit({
          subagentId: sub,
          ts: Date.now(),
          type: 'budget.threshold_reached',
          payload: thresholdPayload('timeout', 1000, 5000),
        });
        fleet.emit({
          subagentId: sub,
          ts: Date.now(),
          type: 'budget.threshold_reached',
          payload: thresholdPayload('tool_calls', 50, 50),
        });
      }
      await flushMacro();

      // Both subagents have entries in all four Maps.
      expect(maps.progressBySubagent.has(keep)).toBe(true);
      expect(maps.progressBySubagent.has(remove)).toBe(true);
      expect(maps.extendTotals.has(keep)).toBe(true);
      expect(maps.extendCounts.has(`${keep}:tool_calls`)).toBe(true);
      expect(maps.lastTimeoutProgress.has(`${keep}:timeout`)).toBe(true);

      // Remove only one.
      policy.removeSubagent(remove);

      // The removed subagent is fully clean.
      expect(maps.progressBySubagent.has(remove)).toBe(false);
      expect(maps.extendTotals.has(remove)).toBe(false);
      expect(maps.extendCounts.has(`${remove}:tool_calls`)).toBe(false);
      expect(maps.lastTimeoutProgress.has(`${remove}:timeout`)).toBe(false);

      // The kept subagent is untouched.
      expect(maps.progressBySubagent.get(keep)).toBe(1);
      expect(maps.extendTotals.get(keep)).toBe(2);
      expect(maps.extendCounts.has(`${keep}:tool_calls`)).toBe(true);
      expect(maps.lastTimeoutProgress.has(`${keep}:timeout`)).toBe(true);
      expect(policy.extensionsFor(keep)).toBe(2);
    } finally {
      policy.dispose();
      usage.dispose();
    }
  });

  it('removes entries across multiple budget kinds for one subagent', async () => {
    const fleet = new FleetBus();
    const usage = new FleetUsageAggregator(fleet);
    const policy = new DirectorBudgetPolicy({
      fleet,
      usage,
      maxBudgetExtensions: 12,
      maxFleetCostUsd: Number.POSITIVE_INFINITY,
      currentSessionId: () => undefined,
    });
    policy.start();
    const maps = mapsOf(policy);

    try {
      const sub = 'sub-multi-kind';

      // Trigger three different non-timeout kinds — each creates its own
      // extendCounts entry keyed `sub:<kind>`.
      for (const kind of ['iterations', 'tool_calls', 'tokens']) {
        fleet.emit({
          subagentId: sub,
          ts: Date.now(),
          type: 'budget.threshold_reached',
          payload: thresholdPayload(kind, 10, 10),
        });
        await flushMacro();
      }
      expect(maps.extendCounts.has(`${sub}:iterations`)).toBe(true);
      expect(maps.extendCounts.has(`${sub}:tool_calls`)).toBe(true);
      expect(maps.extendCounts.has(`${sub}:tokens`)).toBe(true);

      // Also populate timeout-kind entries (lastTimeoutProgress uses sub:kind too).
      fleet.emit({
        subagentId: sub,
        ts: Date.now(),
        type: 'budget.threshold_reached',
        payload: thresholdPayload('idle_timeout', 5000, 10000),
      });
      await flushMacro();
      expect(maps.lastTimeoutProgress.has(`${sub}:idle_timeout`)).toBe(true);

      policy.removeSubagent(sub);

      // Every kind-prefixed entry is gone.
      expect(maps.extendCounts.has(`${sub}:iterations`)).toBe(false);
      expect(maps.extendCounts.has(`${sub}:tool_calls`)).toBe(false);
      expect(maps.extendCounts.has(`${sub}:tokens`)).toBe(false);
      expect(maps.lastTimeoutProgress.has(`${sub}:idle_timeout`)).toBe(false);
      expect(maps.extendTotals.has(sub)).toBe(false);
    } finally {
      policy.dispose();
      usage.dispose();
    }
  });

  it('is a no-op for an unknown subagent (no throw)', () => {
    const fleet = new FleetBus();
    const usage = new FleetUsageAggregator(fleet);
    const policy = new DirectorBudgetPolicy({
      fleet,
      usage,
      maxBudgetExtensions: 12,
      maxFleetCostUsd: Number.POSITIVE_INFINITY,
      currentSessionId: () => undefined,
    });
    policy.start();

    expect(() => policy.removeSubagent('never-spawned')).not.toThrow();

    policy.dispose();
    usage.dispose();
  });
});
