import { describe, expect, it } from 'vitest';
import { decideTransition } from '../src/transition-engine.js';

describe('decideTransition unknown from-state guard (F2249)', () => {
  it('returns illegal_transition instead of throwing TypeError for unknown from state', () => {
    const decision = decideTransition({
      from: 'unknown_state' as never,
      to: 'scoped',
      actor: 'system',
      currentRevision: 1,
      expectedRevision: 1,
      facts: {
        contractApproved: true,
        planApproved: true,
        withinAutonomyEnvelope: true,
        authorization: 'automatic',
        executionGrantValid: true,
        snapshotCurrent: true,
        requiredEvidenceSatisfied: true,
        blockingFindings: 0,
        rollbackVerified: true,
      },
    });
    expect(decision).toMatchObject({ allowed: false, code: 'illegal_transition' });
  });
});
