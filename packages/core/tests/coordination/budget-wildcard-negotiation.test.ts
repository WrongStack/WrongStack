import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';
import { SubagentBudget, BudgetThresholdSignal } from '../../src/coordination/subagent-budget.js';

/**
 * Regression: a delegated subagent's budget is observed by the FleetBus via
 * `onPattern('*')` — a WILDCARD listener. `listenerCount` ignores wildcards,
 * so the budget used to hard-stop on a soft limit (no negotiation), which made
 * the director's auto-extend dead on the real delegate path. The fix routes
 * the presence check through `hasListenerFor`, which counts matching wildcards.
 */
describe('budget soft-limit negotiation with a wildcard listener', () => {
  it('hasListenerFor counts a matching onPattern wildcard', () => {
    const bus = new EventBus();
    expect(bus.hasListenerFor('budget.threshold_reached')).toBe(false);
    const off = bus.onPattern('*', () => {});
    expect(bus.hasListenerFor('budget.threshold_reached')).toBe(true);
    off();
    expect(bus.hasListenerFor('budget.threshold_reached')).toBe(false);
  });

  it('negotiates (does not hard-stop) when only a wildcard listener is present', async () => {
    const bus = new EventBus();
    // Simulate the FleetBus → director auto-extend: a wildcard forwarder that,
    // on a timeout threshold, grants more wall-clock.
    bus.onPattern('*', (type, payload) => {
      if (type === 'budget.threshold_reached') {
        (payload as { extend: (e: { timeoutMs: number }) => void }).extend({ timeoutMs: 999_999 });
      }
    });

    const budget = new SubagentBudget({ timeoutMs: 5 });
    budget._events = bus;
    // The runner wires this: ask the coordinator via the event bus.
    budget.onThreshold = ({ requestDecision }) => requestDecision();
    budget.start();

    await new Promise((r) => setTimeout(r, 15)); // exceed the 5ms timeout

    let signal: BudgetThresholdSignal | null = null;
    try {
      budget.checkTimeout();
    } catch (e) {
      signal = e as BudgetThresholdSignal;
    }

    // It throws a *negotiation* signal (soft), not a hard BudgetExceededError.
    expect(signal).toBeInstanceOf(BudgetThresholdSignal);
    const decision = await signal!.decision;
    expect(decision).toEqual({ extend: { timeoutMs: 999_999 } });
    // Limits were patched in place — the subagent keeps running.
    expect(budget.limits.timeoutMs).toBe(999_999);
  });

  it('still hard-stops when nothing is listening at all', () => {
    const bus = new EventBus();
    const budget = new SubagentBudget({ timeoutMs: 5 });
    budget._events = bus; // bus has no listeners and no wildcards
    budget.onThreshold = ({ requestDecision }) => requestDecision();
    budget.start();
    // Force the clock past the limit without waiting.
    (budget as never as { startTime: number }).startTime = Date.now() - 1000;
    expect(() => budget.checkTimeout()).toThrow(/timeout/i);
  });
});
