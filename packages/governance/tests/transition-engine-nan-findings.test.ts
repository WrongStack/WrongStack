import { describe, expect, it } from 'vitest';
import { decideTransition, type TransitionProposal } from '../src/transition-engine.js';

const makeProposal = (
  from: TransitionProposal['from'],
  to: TransitionProposal['to'],
  blockingFindings: number,
): TransitionProposal => ({
  from,
  to,
  actor: 'human',
  currentRevision: 1,
  expectedRevision: 1,
  facts: {
    contractApproved: true,
    planApproved: true,
    withinAutonomyEnvelope: true,
    authorization: 'human',
    executionGrantValid: true,
    snapshotCurrent: true,
    requiredEvidenceSatisfied: true,
    blockingFindings,
    rollbackVerified: true,
  },
});

describe('decideTransition blockingFindings validation (F1840)', () => {
  it('rejects NaN, non-integer, and negative blockingFindings on ready_to_merge and completed', () => {
    expect(decideTransition(makeProposal('reviewing', 'ready_to_merge', 0)).allowed).toBe(true);
    expect(decideTransition(makeProposal('ready_to_merge', 'completed', 0)).allowed).toBe(true);

    for (const bad of [Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY]) {
      const mergeRes = decideTransition(makeProposal('reviewing', 'ready_to_merge', bad));
      expect(mergeRes.allowed).toBe(false);
      if (!mergeRes.allowed) expect(mergeRes.code).toBe('blocking_findings');

      const completeRes = decideTransition(makeProposal('ready_to_merge', 'completed', bad));
      expect(completeRes.allowed).toBe(false);
      if (!completeRes.allowed) expect(completeRes.code).toBe('blocking_findings');
    }
  });
});
