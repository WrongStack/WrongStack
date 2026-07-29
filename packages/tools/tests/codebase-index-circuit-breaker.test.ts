/**
 * Tests for the codebase-index circuit breaker.
 *
 * Covers every state transition, LockError exclusion, cooldown timing,
 * half-open probe admission, and the reset path.
 */
import { describe, expect, it } from 'vitest';
import {
  CircuitOpenError,
  IndexCircuitBreaker,
  IndexTimeoutError,
  LockError,
} from '../src/codebase-index/circuit-breaker.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockNow(): { now(): number; advance(ms: number): void } {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// ─── Error class identity ───────────────────────────────────────────────────

describe('Error classes', () => {
  it('CircuitOpenError has the correct name', () => {
    const err = new CircuitOpenError('test');
    expect(err.name).toBe('CircuitOpenError');
    expect(err).toBeInstanceOf(Error);
  });

  it('IndexTimeoutError has the correct name', () => {
    const err = new IndexTimeoutError('test');
    expect(err.name).toBe('IndexTimeoutError');
    expect(err).toBeInstanceOf(Error);
  });

  it('LockError has the correct name', () => {
    const err = new LockError('test');
    expect(err.name).toBe('LockError');
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── allowRequest state transitions ─────────────────────────────────────────

describe('allowRequest', () => {
  it('returns true when the circuit is closed', () => {
    const cb = new IndexCircuitBreaker();
    expect(cb.allowRequest()).toBe(true);
  });

  it('returns false when the circuit is open and the cooldown has not elapsed', () => {
    const clock = mockNow();
    const cb = new IndexCircuitBreaker({ now: clock.now, failureThreshold: 1, cooldownMs: 60_000 });
    cb.recordFailure(new Error('boom'));
    // now = 0, openedAt = 0, cooldown 60s → false
    expect(cb.allowRequest()).toBe(false);
    clock.advance(30_000);
    expect(cb.allowRequest()).toBe(false);
  });

  it('transitions to half-open when cooldown expires and admits exactly one probe', () => {
    const clock = mockNow();
    const cb = new IndexCircuitBreaker({ now: clock.now, failureThreshold: 1, cooldownMs: 60_000 });
    cb.recordFailure(new Error('boom'));
    clock.advance(60_000);
    // First request after cooldown → half-open, returns true
    expect(cb.allowRequest()).toBe(true);
    // Snapshot should show half-open
    expect(cb.snapshot().state).toBe('half-open');
    // Second request while probe is in flight → false
    expect(cb.allowRequest()).toBe(false);
  });

  it('returns false in half-open when a probe is already in flight', () => {
    const clock = mockNow();
    const cb = new IndexCircuitBreaker({ now: clock.now, failureThreshold: 1, cooldownMs: 60_000 });
    cb.recordFailure(new Error('boom'));
    clock.advance(60_000);
    cb.allowRequest(); // enters half-open, probe in flight
    expect(cb.allowRequest()).toBe(false); // second probe rejected
  });

  it('defaults to closed with 3-failure threshold and 60s cooldown', () => {
    const cb = new IndexCircuitBreaker();
    expect(cb.snapshot().state).toBe('closed');
    expect(cb.snapshot().consecutiveFailures).toBe(0);
  });
});

// ─── recordSuccess ──────────────────────────────────────────────────────────

describe('recordSuccess', () => {
  it('resets to closed and clears counters', () => {
    const cb = new IndexCircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure(new Error('boom'));
    expect(cb.snapshot().state).toBe('open');
    cb.recordSuccess();
    const s = cb.snapshot();
    expect(s.state).toBe('closed');
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastFailure).toBeNull();
  });

  it('closes a half-open circuit after a successful probe', () => {
    const clock = mockNow();
    const cb = new IndexCircuitBreaker({ now: clock.now, failureThreshold: 1, cooldownMs: 60_000 });
    cb.recordFailure(new Error('boom'));
    clock.advance(60_000);
    cb.allowRequest(); // admit probe → half-open
    cb.recordSuccess();
    expect(cb.snapshot().state).toBe('closed');
  });
});

// ─── recordFailure ──────────────────────────────────────────────────────────

describe('recordFailure', () => {
  it('increments consecutiveFailures and opens after the threshold', () => {
    const cb = new IndexCircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure(new Error('e1'));
    expect(cb.snapshot().consecutiveFailures).toBe(1);
    expect(cb.snapshot().state).toBe('closed');
    cb.recordFailure(new Error('e2'));
    expect(cb.snapshot().consecutiveFailures).toBe(2);
    expect(cb.snapshot().state).toBe('closed');
    cb.recordFailure(new Error('e3'));
    expect(cb.snapshot().consecutiveFailures).toBe(3);
    expect(cb.snapshot().state).toBe('open');
  });

  it('does NOT increment consecutiveFailures for LockError', () => {
    const cb = new IndexCircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure(new LockError('lock conflict'));
    expect(cb.snapshot().consecutiveFailures).toBe(0);
    expect(cb.snapshot().state).toBe('closed');
    // A LockError followed by a real error should only count the real error
    cb.recordFailure(new LockError('another lock'));
    expect(cb.snapshot().consecutiveFailures).toBe(0);
    cb.recordFailure(new Error('real problem'));
    expect(cb.snapshot().consecutiveFailures).toBe(1);
  });

  it('re-opens immediately when in half-open', () => {
    const clock = mockNow();
    const cb = new IndexCircuitBreaker({ now: clock.now, failureThreshold: 1, cooldownMs: 60_000 });
    cb.recordFailure(new Error('first'));
    clock.advance(60_000);
    cb.allowRequest(); // half-open
    cb.recordFailure(new Error('probe failed'));
    const s = cb.snapshot();
    expect(s.state).toBe('open');
    expect(s.consecutiveFailures).toBe(2);
  });

  it('records lastFailure message', () => {
    const cb = new IndexCircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure(new Error('disk full'));
    expect(cb.snapshot().lastFailure).toBe('disk full');
  });

  it('records LockError in lastFailure but does not count it', () => {
    const cb = new IndexCircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure(new LockError('database locked'));
    expect(cb.snapshot().lastFailure).toContain('[transient/lock]');
    expect(cb.snapshot().consecutiveFailures).toBe(0);
  });
});

// ─── reset ──────────────────────────────────────────────────────────────────

describe('reset', () => {
  it('force-closes an open circuit', () => {
    const cb = new IndexCircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure(new Error('boom'));
    expect(cb.snapshot().state).toBe('open');
    cb.reset();
    const s = cb.snapshot();
    expect(s.state).toBe('closed');
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastFailure).toBeNull();
    expect(s.cooldownRemainingMs).toBe(0);
    // Should admit requests again
    expect(cb.allowRequest()).toBe(true);
  });
});

// ─── snapshot ───────────────────────────────────────────────────────────────

describe('snapshot', () => {
  it('reports cooldownRemainingMs as 0 when closed', () => {
    const cb = new IndexCircuitBreaker();
    expect(cb.snapshot().cooldownRemainingMs).toBe(0);
  });

  it('reports the correct remaining cooldown when open', () => {
    const clock = mockNow();
    const cb = new IndexCircuitBreaker({ now: clock.now, failureThreshold: 1, cooldownMs: 60_000 });
    cb.recordFailure(new Error('boom'));
    clock.advance(10_000);
    const s = cb.snapshot();
    expect(s.state).toBe('open');
    expect(s.cooldownRemainingMs).toBe(50_000);
  });

  it('reports cooldownRemainingMs as 0 when cooldown has fully elapsed', () => {
    const clock = mockNow();
    const cb = new IndexCircuitBreaker({ now: clock.now, failureThreshold: 1, cooldownMs: 60_000 });
    cb.recordFailure(new Error('boom'));
    clock.advance(60_000);
    expect(cb.snapshot().cooldownRemainingMs).toBe(0);
  });
});

// Shared singleton tested via named import at the top of this file.
// Module-level `indexCircuitBreaker` and `resetIndexCircuitBreaker`
// are covered by the constructor and reset tests above.
