import { describe, expect, it } from 'vitest';
import { fanoutBlocker } from '../src/features/control/fanout.js';

describe('fanoutBlocker non-finite and negative target counts (F1871)', () => {
  it('blocks NaN, Infinity, zero, and negative counts while allowing 1..50', () => {
    for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, -1, 0]) {
      expect(fanoutBlocker(bad)).not.toBeNull();
    }
    expect(fanoutBlocker(1)).toBeNull();
    expect(fanoutBlocker(50)).toBeNull();
    expect(fanoutBlocker(51)).not.toBeNull();
  });
});
