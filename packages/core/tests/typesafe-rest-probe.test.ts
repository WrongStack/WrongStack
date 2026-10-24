/**
 * Regression: the rest gate promises that after the cooldown "the next call is
 * let through as a probe: success closes the gate, another failure reopens it
 * for twice as long". The failure weight was reset at rest, so a probe failing
 * with a timeout / 5xx (weight 1 of limit 2) left the gate closed and the next
 * caller paid another full request against the failing host.
 */

import { FetchError } from '@wrongstack/contracts/types/errors';
import { describe, expect, it } from 'vitest';
import { createTypeSafeRestGate } from '../src/typesafe/rest.js';

const fetchError = (status: number) => new FetchError({ message: `HTTP ${status}`, status });

function restedGate() {
  const clock = { now: 0 };
  const gate = createTypeSafeRestGate({
    baseCooldownMs: 10,
    maxCooldownMs: 40,
    now: () => clock.now,
  });
  gate.recordFailure(fetchError(503));
  expect(gate.recordFailure(fetchError(503))).toBe(true);
  expect(gate.restingUntil()).toBe(10);
  return { gate, clock };
}

describe('TypeSafe rest gate probe', () => {
  it.each([0, 503, 408])('a probe failing with status %i reopens for twice as long', (status) => {
    const { gate, clock } = restedGate();
    clock.now = 11;
    expect(gate.recordFailure(fetchError(status))).toBe(true);
    expect(gate.restingUntil()).toBe(31);
  });

  it('a successful probe closes the gate and restores the normal failure limit', () => {
    const { gate, clock } = restedGate();
    clock.now = 11;
    gate.recordSuccess();
    expect(gate.isResting()).toBe(false);
    expect(gate.recordFailure(fetchError(503))).toBe(false);
    expect(gate.recordFailure(fetchError(503))).toBe(true);
    expect(gate.restingUntil()).toBe(21); // cooldown back to the base
  });

  it('ignores failures of calls that were in flight when the gate went to rest', () => {
    const { gate, clock } = restedGate();
    clock.now = 5;
    expect(gate.recordFailure(fetchError(503))).toBe(false);
    expect(gate.restingUntil()).toBe(10); // not extended, not escalated
    clock.now = 11;
    expect(gate.recordFailure(fetchError(503))).toBe(true);
    expect(gate.restingUntil()).toBe(31); // 20 ms: one doubling, not two
  });

  it('keeps doubling up to the cap while probes fail', () => {
    const { gate, clock } = restedGate();
    const ends: Array<number | undefined> = [];
    for (let i = 0; i < 4; i++) {
      clock.now = (gate.restingUntil() ?? clock.now) + 1;
      gate.recordFailure(fetchError(0));
      ends.push((gate.restingUntil() ?? 0) - clock.now);
    }
    expect(ends).toEqual([20, 40, 40, 40]);
  });
});
