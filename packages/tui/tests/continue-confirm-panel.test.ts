import { describe, expect, it } from 'vitest';
import { continueAutoProceedSeconds } from '../src/components/continue-confirm-panel.js';

describe('continueAutoProceedSeconds', () => {
  it('returns a rounded-up countdown for grounded continuations', () => {
    expect(continueAutoProceedSeconds(true, 4000)).toBe(4);
    expect(continueAutoProceedSeconds(true, 4500)).toBe(5);
  });

  it('clamps grounded countdowns to at least one second', () => {
    expect(continueAutoProceedSeconds(true, 0)).toBe(1);
    expect(continueAutoProceedSeconds(true, -100)).toBe(1);
  });

  it('does not auto-proceed ambiguous open continuations', () => {
    expect(continueAutoProceedSeconds(false, 4000)).toBeNull();
  });
});
