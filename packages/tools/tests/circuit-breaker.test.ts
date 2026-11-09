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

  describe('idle snapshots', () => {
    it('expires window counts without another call and preserves failure history', () => {
      const cb = new CircuitBreaker({ windowMs: 1_000, slowCallThresholdMs: 100 });
      const startedAt = Date.now();
      expect(cb.beforeCall()).toBe(true);
      cb.afterCall(100, false);
      vi.advanceTimersByTime(500);
      expect(cb.beforeCall()).toBe(true);
      cb.afterCall(10, true);
      expect(cb.snapshot()).toMatchObject({ callsInWindow: 2, slowCallsInWindow: 1 });

      vi.advanceTimersByTime(500);
      expect(cb.snapshot()).toMatchObject({ callsInWindow: 2, slowCallsInWindow: 1 });
      vi.advanceTimersByTime(1);
      expect(cb.snapshot()).toMatchObject({ callsInWindow: 1, slowCallsInWindow: 0 });
      vi.advanceTimersByTime(500);
      expect(cb.snapshot()).toMatchObject({
        state: 'closed',
        callsInWindow: 0,
        slowCallsInWindow: 0,
        consecutiveFailures: 1,
        lastFailureAt: startedAt + 500,
        lastSlowAt: startedAt,
      });
      expect(cb.snapshot().callsInWindow).toBe(0);
    });

    it('does not reset consecutive slow calls when the window expires', () => {
      const cb = new CircuitBreaker({
        windowMs: 1_000,
        slowCallThresholdMs: 100,
        maxSlowCalls: 2,
      });
      cb.afterCall(100, false);
      vi.advanceTimersByTime(1_001);
      cb.snapshot();
      cb.afterCall(100, false);
      expect(cb.snapshot().state).toBe('open');
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

    it('trips on consecutive slow calls with the default window and threshold', () => {
      // Each call runs past the 180s threshold, so no two share the 60s window.
      const cb = new CircuitBreaker();
      for (let i = 0; i < 2; i++) {
        vi.advanceTimersByTime(200_000);
        cb.afterCall(200_000, false);
        expect(cb.canProceed).toBe(true);
      }
      vi.advanceTimersByTime(200_000);
      cb.afterCall(200_000, false);
      expect(cb.canProceed).toBe(false);
    });

    it('a fast success breaks a slow streak', () => {
      const cb = new CircuitBreaker();
      for (const ms of [200_000, 200_000, 10, 200_000, 200_000]) {
        vi.advanceTimersByTime(Math.max(ms, 1_000));
        cb.afterCall(ms, false);
      }
      expect(cb.canProceed).toBe(true);
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

    // Regression: half-open is documented as allowing ONE call through
    // (CircuitBreakerConfig.cooldownMs). A call is admitted by beforeCall and
    // reported later by afterCall, so a concurrent second call arriving while
    // the probe is still running must be refused — otherwise the burst that
    // tripped the breaker resumes in full at the moment it should be probing.
    it('half-open admits only the first probe while it is still running', () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 1, cooldownMs: 1000 });
      cb.afterCall(10, true); // trips
      expect(cb.beforeCall()).toBe(false); // inside the cooldown

      vi.advanceTimersByTime(1500); // cooldown elapsed -> half-open
      expect(cb.beforeCall()).toBe(true); // the probe
      expect(cb.snapshot().state).toBe('half-open');
      expect(cb.beforeCall()).toBe(false); // a second concurrent call is refused

      cb.afterCall(10, false); // the probe succeeds
      expect(cb.snapshot().state).toBe('closed');
      expect(cb.beforeCall()).toBe(true); // normal operation resumes
    });

    it('half-open re-admits exactly one probe after a failed probe', () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 1, cooldownMs: 1000 });
      cb.afterCall(10, true); // trips
      vi.advanceTimersByTime(1500);
      expect(cb.beforeCall()).toBe(true); // probe
      expect(cb.beforeCall()).toBe(false); // refused while it runs
      cb.afterCall(10, true); // probe fails -> back to open
      expect(cb.snapshot().state).toBe('open');

      vi.advanceTimersByTime(1500); // next cooldown elapses
      expect(cb.beforeCall()).toBe(true); // exactly one new probe
      expect(cb.beforeCall()).toBe(false); // and only that one
    });

    it('CONTROL: repeated calls are all admitted while closed', () => {
      const cb = new CircuitBreaker({ maxConsecutiveFailures: 5, cooldownMs: 1000 });
      expect(cb.beforeCall()).toBe(true);
      cb.afterCall(10, false);
      expect(cb.beforeCall()).toBe(true);
      cb.afterCall(10, false);
      expect(cb.beforeCall()).toBe(true);
      expect(cb.snapshot().state).toBe('closed');
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

  it('lets only the half-open probe decide, not a call admitted before the trip', () => {
    const cb = new CircuitBreaker({ maxConsecutiveFailures: 1, cooldownMs: 1_000 });
    expect(cb.beforeCall()).toBe(true); // S: long call admitted while closed
    cb.beforeCall();
    cb.afterCall(5, true); // trip
    vi.advanceTimersByTime(1_000);
    expect(cb.beforeCall()).toBe(true); // the probe
    cb.afterCall(60_000, false); // S finishes: it started before the trip
    expect(cb.snapshot().state).toBe('half-open');
    expect(cb.beforeCall()).toBe(false); // probe still in flight
    cb.afterCall(1, false); // the probe succeeds
    expect(cb.snapshot().state).toBe('closed');
  });

  it('canProceed returns false while a half-open probe is already in flight', () => {
    const cb = new CircuitBreaker({ maxConsecutiveFailures: 1, cooldownMs: 1_000 });
    cb.afterCall(5, true); // trip to open
    expect(cb.canProceed).toBe(false);

    vi.advanceTimersByTime(1_000); // transition to half-open
    expect(cb.canProceed).toBe(true); // first probe may proceed
    expect(cb.beforeCall()).toBe(true); // probe claimed
    expect(cb.canProceed).toBe(false); // concurrent callers (e.g. exec) must wait for probe

    cb.afterCall(5, false); // probe succeeds -> closed
    expect(cb.canProceed).toBe(true);
  });

  it('ignores afterCall completions while open and unadmitted afterCall in half-open (F34)', () => {
    const cb = new CircuitBreaker({ maxConsecutiveFailures: 2, cooldownMs: 1_000 });
    cb.afterCall(10, true);
    cb.afterCall(10, true);
    expect(cb.snapshot().state).toBe('open');

    // In-flight completion while open must not reset consecutiveFailures or pollute window
    cb.afterCall(10, false);
    expect(cb.snapshot().consecutiveFailures).toBe(2);
    expect(cb.snapshot().callsInWindow).toBe(0);

    // Advance past cooldown and observe via snapshot() without admitting a probe via beforeCall/canProceed
    vi.advanceTimersByTime(1_100);
    expect(cb.snapshot().state).toBe('half-open');
    cb.afterCall(0, false);
    expect(cb.snapshot().state).toBe('half-open');
  });

  it('falls back to defaults for non-finite or non-positive config options and sanitizes negative/NaN durationMs (F138)', () => {
    const cb = new CircuitBreaker({
      maxConsecutiveFailures: 0,
      slowCallThresholdMs: Number.NaN,
      maxSlowCalls: -1,
      maxCallsPerWindow: 0,
      windowMs: Number.NaN,
      cooldownMs: -500,
    });
    cb.afterCall(Number.NaN, false);
    cb.afterCall(-100, false);
    expect(cb.snapshot().state).toBe('closed');
    expect(cb.snapshot().callsInWindow).toBe(2);
    expect(cb.snapshot().slowCallsInWindow).toBe(0);
  });
});
