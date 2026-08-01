import { describe, expect, it } from 'vitest';
import {
  decideTransition,
  isSuccessfulWorkflowState,
  isTerminalWorkflowState,
  type TransitionFacts,
  type TransitionProposal,
} from '../src/index.js';

const approvedFacts: TransitionFacts = {
  contractApproved: true,
  planApproved: true,
  withinAutonomyEnvelope: true,
  authorization: 'automatic',
  executionGrantValid: true,
  snapshotCurrent: true,
  requiredEvidenceSatisfied: true,
  blockingFindings: 0,
  rollbackVerified: true,
};

function proposal(
  from: TransitionProposal['from'],
  to: TransitionProposal['to'],
  overrides: Partial<TransitionProposal> = {},
): TransitionProposal {
  return {
    from,
    to,
    actor: 'model',
    currentRevision: 4,
    expectedRevision: 4,
    facts: approvedFacts,
    ...overrides,
  };
}

describe('decideTransition', () => {
  it('auto-authorizes an approved model plan inside the autonomy envelope', () => {
    expect(decideTransition(proposal('planned', 'authorized'))).toEqual({
      allowed: true,
      from: 'planned',
      to: 'authorized',
      nextRevision: 5,
    });
  });

  it('requires escalation when automatic authorization would leave the autonomy envelope', () => {
    expect(
      decideTransition(
        proposal('planned', 'authorized', {
          facts: { ...approvedFacts, withinAutonomyEnvelope: false },
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'outside_autonomy_envelope' });
  });

  it('allows explicit human authorization outside the autonomy envelope', () => {
    expect(
      decideTransition(
        proposal('planned', 'authorized', {
          actor: 'human',
          facts: {
            ...approvedFacts,
            withinAutonomyEnvelope: false,
            authorization: 'human',
          },
        }),
      ),
    ).toMatchObject({ allowed: true, to: 'authorized' });
  });

  it('lets a model propose completion without self-admitting the task', () => {
    expect(decideTransition(proposal('executing', 'proposed_complete'))).toMatchObject({
      allowed: true,
      to: 'proposed_complete',
    });
    expect(decideTransition(proposal('ready_to_merge', 'completed'))).toMatchObject({
      allowed: false,
      code: 'model_cannot_self_admit',
    });
    expect(decideTransition(proposal('reviewing', 'ready_to_merge'))).toMatchObject({
      allowed: false,
      code: 'model_cannot_self_admit',
    });
  });

  it('lets deterministic policy admit current, evidenced, reviewed work without human intervention', () => {
    expect(
      decideTransition(proposal('ready_to_merge', 'completed', { actor: 'policy' })),
    ).toMatchObject({ allowed: true, to: 'completed' });
  });

  it('rejects stale revisions before evaluating the requested transition', () => {
    expect(
      decideTransition(
        proposal('planned', 'authorized', {
          expectedRevision: 3,
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'stale_revision' });
  });

  it('rejects illegal state jumps', () => {
    expect(decideTransition(proposal('draft', 'completed'))).toMatchObject({
      allowed: false,
      code: 'illegal_transition',
    });
  });

  it('requires a current snapshot and execution grant before execution', () => {
    expect(
      decideTransition(
        proposal('authorized', 'executing', {
          facts: { ...approvedFacts, executionGrantValid: false },
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'execution_grant_missing' });

    expect(
      decideTransition(
        proposal('authorized', 'executing', {
          facts: { ...approvedFacts, snapshotCurrent: false },
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'stale_snapshot' });
  });

  it('requires evidence and resolved blockers before merge admission', () => {
    expect(
      decideTransition(
        proposal('reviewing', 'ready_to_merge', {
          actor: 'policy',
          facts: { ...approvedFacts, requiredEvidenceSatisfied: false },
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'evidence_missing' });

    expect(
      decideTransition(
        proposal('reviewing', 'ready_to_merge', {
          actor: 'policy',
          facts: { ...approvedFacts, blockingFindings: 1 },
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'blocking_findings' });
  });

  it('requires independent rollback verification', () => {
    expect(
      decideTransition(
        proposal('rolling_back', 'rolled_back', {
          actor: 'policy',
          facts: { ...approvedFacts, rollbackVerified: false },
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'rollback_unverified' });
  });
});

describe('workflow state classification', () => {
  it('treats completion as the only successful terminal state', () => {
    expect(isTerminalWorkflowState('completed')).toBe(true);
    expect(isSuccessfulWorkflowState('completed')).toBe(true);
    expect(isTerminalWorkflowState('failed')).toBe(true);
    expect(isSuccessfulWorkflowState('failed')).toBe(false);
    expect(isTerminalWorkflowState('proposed_complete')).toBe(false);
    expect(isSuccessfulWorkflowState('proposed_complete')).toBe(false);
  });
});
