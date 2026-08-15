import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../src/circuit-breaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('default state', () => {
    it('starts closed and allows calls', () => {
      const cb = new CircuitBreaker();
      expect(cb.canProceed).toBe(true);
      expect(cb.beforeCall()).toBe(true);
      expect(cb.snapshot().state).toBe('closed');
    });

    it('snapshot reports zero counts initially', () => {
      const cb = new CircuitBreaker();
      const s = cb.snapshot();
      expect(s.consecutiveFailures).toBe(0);
      expect(s.slowCallsInWindow).toBe(0);
      expect(s.callsInWindow).toBe(0);
      expect(s.cooldownRemainingMs).toBe(null);
      expect(s.lastFailureAt).toBe(null);
      expect(s.lastSlowAt).toBe(null);
    });
  });

  describe('consecutive failure trip', () => {
    it('trips after N consecutive failures', () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 3 });
      cb.afterCall(10, true);
      cb.afterCall(10, true);
      expect(cb.canProceed).toBe(true);
      cb.afterCall(10, true);
      expect(cb.canProceed).toBe(false);
      expect(cb.snapshot().state).toBe('open');
    });

    it('a success resets the consecutive failure counter', () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 3 });
      cb.afterCall(10, true);
      cb.afterCall(10, true);
      cb.afterCall(10, false); // success
      cb.afterCall(10, true);
      cb.afterCall(10, true);
      expect(cb.canProceed).toBe(true);
      expect(cb.snapshot().consecutiveFailures).toBe(2);
    });

    it('records lastFailureAt timestamp', () => {
      const cb = new CircuitBreaker();
      cb.afterCall(10, true);
      const s = cb.snapshot();
      expect(s.lastFailureAt).toBe(Date.now());
    });
  });

  describe('slow-call trip', () => {
    it('trips after maxSlowCalls slow successes within the window', () => {
      const cb = new CircuitBreaker({
        slowCallThresholdMs: 1000,
        maxSlowCalls: 2,
        windowMs: 60_000,
      });
      cb.afterCall(5_000, false); // slow #1
      expect(cb.canProceed).toBe(true);
      cb.afterCall(5_000, false); // slow #2 → trip
      expect(cb.canProceed).toBe(false);
    });

    it('fast successes do not count as slow', () => {
      const cb = new CircuitBreaker({
        slowCallThresholdMs: 1000,
        maxSlowCalls: 2,
      });
      cb.afterCall(100, false);
      cb.afterCall(100, false);
      cb.afterCall(100, false);
      expect(cb.canProceed).toBe(true);
      expect(cb.snapshot().slowCallsInWindow).toBe(0);
    });

    it('records lastSlowAt', () => {
      const cb = new CircuitBreaker({ slowCallThresholdMs: 100 });
      cb.afterCall(200, false);
      expect(cb.snapshot().lastSlowAt).toBe(Date.now());
    });
  });

  describe('rate-limit trip', () => {
    it('trips when calls within window exceed maxCallsPerWindow', () => {
      const cb = new CircuitBreaker({ maxCallsPerWindow: 3, windowMs: 60_000 });
      cb.afterCall(10, false);
      cb.afterCall(10, false);
      expect(cb.canProceed).toBe(true);
      cb.afterCall(10, false);
      expect(cb.canProceed).toBe(false);
    });

    it('prunes records outside the sliding window', () => {
      const cb = new CircuitBreaker({
        maxCallsPerWindow: 3,
        windowMs: 1000,
      });
      cb.afterCall(10, false);
      cb.afterCall(10, false);
      vi.advanceTimersByTime(1500); // past window
      cb.afterCall(10, false);
      // The first two should have been pruned before the third is recorded.
      expect(cb.snapshot().callsInWindow).toBe(1);
      expect(cb.canProceed).toBe(true);
    });
  });

  describe('cooldown / half-open', () => {
    it('stays open during cooldown, transitions to half-open after', () => {
      const cb = new CircuitBreaker({
        maxConsecutiveFailures: 1,
        cooldownMs: 5000,
      });
      cb.afterCall(10, true);
      expect(cb.snapshot().state).toBe('open');
      vi.advanceTimersByTime(4000);
      expect(cb.canProceed).toBe(false);
      vi.advanceTimersByTime(2000); // total 6s, past cooldown
      expect(cb.canProceed).toBe(true);
      expect(cb.snapshot().state).toBe('half-open');
    });

    it('half-open success returns to closed', () => {
      const cb = new CircuitBreaker({
        maxConsecutiveFailures: 1,
        cooldownMs: 1000,
      });
      cb.afterCall(10, true);
      vi.advanceTimersByTime(1500);
      // Read state to trigger transition to half-open
      expect(cb.canProceed).toBe(true);
      cb.afterCall(10, false); // success in half-open
      expect(cb.snapshot().state).toBe('closed');
      expect(cb.snapshot().consecutiveFailures).toBe(0);
    });

    it('half-open failure goes back to open', () => {
      const cb = new CircuitBreaker({
        maxConsecutiveFailures: 1,
        cooldownMs: 1000,
      });
      cb.afterCall(10, true);
      vi.advanceTimersByTime(1500);
      expect(cb.canProceed).toBe(true); // transition to half-open
      cb.afterCall(10, true); // fail in half-open
      expect(cb.snapshot().state).toBe('open');
    });

    it('snapshot reports cooldownRemainingMs while open', () => {
      const cb = new CircuitBreaker({
        maxConsecutiveFailures: 1,
        cooldownMs: 10_000,
      });
      cb.afterCall(10, true);
      vi.advanceTimersByTime(3000);
      const s = cb.snapshot();
      expect(s.cooldownRemainingMs).toBe(7000);
    });

    it('cooldownRemainingMs is null when closed or half-open', () => {
      const cb = new CircuitBreaker();
      expect(cb.snapshot().cooldownRemainingMs).toBe(null);
    });
  });

  describe('forceOpen / forceReset', () => {
    it('forceOpen trips immediately', () => {
      const cb = new CircuitBreaker();
      cb.forceOpen();
      expect(cb.canProceed).toBe(false);
      expect(cb.snapshot().state).toBe('open');
    });

    it('forceOpen is a no-op when already open', () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 1, cooldownMs: 5000 });
      cb.afterCall(10, true);
      const firstOpen = cb.snapshot().cooldownRemainingMs;
      vi.advanceTimersByTime(1000);
      cb.forceOpen();
      // openedAt should not be reset — cooldown should keep counting down.
      expect(cb.snapshot().cooldownRemainingMs).toBeLessThan(firstOpen!);
    });

    it('forceReset returns to closed with cleared counters', () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 2 });
      cb.afterCall(10, true);
      cb.afterCall(10, true);
      cb.forceReset();
      expect(cb.snapshot().state).toBe('closed');
      expect(cb.snapshot().consecutiveFailures).toBe(0);
      expect(cb.snapshot().callsInWindow).toBe(0);
    });
  });

  describe('beforeCall', () => {
    it('returns false when the breaker is open', () => {
      const cb = new CircuitBreaker();
      cb.forceOpen();
      expect(cb.beforeCall()).toBe(false);
    });

    it('returns true after cooldown transitions to half-open', () => {
      const cb = new CircuitBreaker({ cooldownMs: 1000 });
      cb.forceOpen();
      vi.advanceTimersByTime(1500);
      expect(cb.beforeCall()).toBe(true);
    });

    it('bypass returns true even when breaker is open', () => {
      const cb = new CircuitBreaker();
      cb.forceOpen();
      expect(cb.beforeCall(true)).toBe(true);
      expect(cb.beforeCall(false)).toBe(false);
    });
  });

  describe('afterCall bypass', () => {
    it('bypass does not update breaker state', () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 2 });
      cb.forceOpen();
      // Bypass should not affect state
      cb.afterCall(10_000, false, true);
      expect(cb.snapshot().state).toBe('open');
      expect(cb.snapshot().consecutiveFailures).toBe(0);
    });

    it('bypass allows calling afterCall repeatedly without tripping', () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 3 });
      // Without bypass, 3 failures would trip the breaker
      cb.afterCall(10_000, true, true);
      cb.afterCall(10_000, true, true);
      cb.afterCall(10_000, true, true);
      expect(cb.canProceed).toBe(true);
    });

    it('bypass success does not reset consecutive failure counter', () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 2 });
      cb.afterCall(10, true); // 1 failure
      cb.afterCall(10, false, true); // success with bypass
      cb.afterCall(10, true); // 2nd failure — should trip because bypass didn't reset counter
      expect(cb.canProceed).toBe(false);
    });
  });

  describe('enabled flag', () => {
    it('defaults to enabled', () => {
      const cb = new CircuitBreaker();
      expect(cb.isEnabled).toBe(true);
    });

    it('setEnabled(false) bypasses the breaker entirely', () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 2 });
      cb.setEnabled(false);
      expect(cb.isEnabled).toBe(false);
      // Repeated failures do not trip a disabled breaker.
      cb.afterCall(10, true);
      cb.afterCall(10, true);
      cb.afterCall(10, true);
      expect(cb.canProceed).toBe(true);
      expect(cb.beforeCall()).toBe(true);
      expect(cb.snapshot().state).toBe('closed');
    });

    it('disabling resets an already-tripped breaker to closed', () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 2 });
      cb.afterCall(10, true);
      cb.afterCall(10, true);
      expect(cb.snapshot().state).toBe('open');
      cb.setEnabled(false);
      expect(cb.snapshot().state).toBe('closed');
      // Re-enabling starts fresh (no residual failure count).
      cb.setEnabled(true);
      expect(cb.canProceed).toBe(true);
      expect(cb.snapshot().consecutiveFailures).toBe(0);
    });

    it('onTrip fires only on the closed→open transition', () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 2 });
      const trips = vi.fn();
      cb.onTrip = trips;
      cb.afterCall(10, true);
      expect(trips).toHaveBeenCalledTimes(0);
      cb.afterCall(10, true); // trip
      expect(trips).toHaveBeenCalledTimes(1);
      cb.forceOpen(); // already open — no second fire
      expect(trips).toHaveBeenCalledTimes(1);
    });

    it('onReset fires on recovery from open/half-open, not on initial closed', () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 2 });
      const resets = vi.fn();
      cb.onReset = resets;
      cb.forceReset(); // closed→closed: no fire
      expect(resets).toHaveBeenCalledTimes(0);
      cb.afterCall(10, true);
      cb.afterCall(10, true); // trip
      cb.forceReset(); // open→closed: fire
      expect(resets).toHaveBeenCalledTimes(1);
    });
  });
});
