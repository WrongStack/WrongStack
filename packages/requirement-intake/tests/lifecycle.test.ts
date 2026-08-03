import { describe, expect, it } from 'vitest';
import { INTAKE_STATUSES } from '../src/constants.js';
import { IntakeStateTransitionError } from '../src/errors.js';
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  canTransition,
  isMutableStatus,
  isTerminalStatus,
} from '../src/lifecycle.js';

describe('intake lifecycle', () => {
  it('allows the recommended transitions', () => {
    expect(canTransition('draft', 'collecting_information')).toBe(true);
    expect(canTransition('draft', 'submitted')).toBe(true);
    expect(canTransition('collecting_information', 'submitted')).toBe(true);
    expect(canTransition('draft', 'cancelled')).toBe(true);
    expect(canTransition('collecting_information', 'cancelled')).toBe(true);
    expect(canTransition('submitted', 'archived')).toBe(true);
    expect(canTransition('cancelled', 'archived')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    const invalid: Array<[string, string]> = [
      ['submitted', 'draft'],
      ['submitted', 'cancelled'],
      ['submitted', 'submitted'],
      ['cancelled', 'submitted'],
      ['cancelled', 'draft'],
      ['archived', 'submitted'],
      ['archived', 'draft'],
      ['archived', 'archived'],
      ['draft', 'archived'],
      ['collecting_information', 'archived'],
    ];
    for (const [from, to] of invalid) {
      expect(canTransition(from as never, to as never)).toBe(false);
      expect(() => assertTransition(from as never, to as never)).toThrow(
        IntakeStateTransitionError,
      );
    }
  });

  it('accepts every status as a valid source in the transition table', () => {
    for (const status of INTAKE_STATUSES) {
      expect(Array.isArray(ALLOWED_TRANSITIONS[status])).toBe(true);
    }
  });

  it('classifies mutable and terminal statuses', () => {
    expect(isMutableStatus('draft')).toBe(true);
    expect(isMutableStatus('collecting_information')).toBe(true);
    expect(isMutableStatus('submitted')).toBe(false);
    expect(isMutableStatus('cancelled')).toBe(false);
    expect(isMutableStatus('archived')).toBe(false);
    expect(isTerminalStatus('submitted')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('archived')).toBe(true);
    expect(isTerminalStatus('draft')).toBe(false);
  });

  it('reports the transition error code', () => {
    try {
      assertTransition('submitted', 'draft');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(IntakeStateTransitionError);
      expect((error as IntakeStateTransitionError).code).toBe('INTAKE_INVALID_TRANSITION');
    }
  });
});
