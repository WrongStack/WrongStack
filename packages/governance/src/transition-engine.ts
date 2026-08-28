import type { WorkflowState } from './workflow-state.js';

export const GOVERNANCE_ACTORS = ['model', 'human', 'policy', 'system'] as const;

export type GovernanceActor = (typeof GOVERNANCE_ACTORS)[number];

type AuthorizationKind = 'none' | 'automatic' | 'human';

export interface TransitionFacts {
  readonly contractApproved: boolean;
  readonly planApproved: boolean;
  readonly withinAutonomyEnvelope: boolean;
  readonly authorization: AuthorizationKind;
  readonly executionGrantValid: boolean;
  readonly snapshotCurrent: boolean;
  readonly requiredEvidenceSatisfied: boolean;
  readonly blockingFindings: number;
  readonly rollbackVerified: boolean;
}

export interface TransitionProposal {
  readonly from: WorkflowState;
  readonly to: WorkflowState;
  readonly actor: GovernanceActor;
  readonly currentRevision: number;
  readonly expectedRevision: number;
  /** Trusted facts computed by governance adapters/policy, never copied from model arguments. */
  readonly facts: TransitionFacts;
}

type TransitionRejectionCode =
  | 'stale_revision'
  | 'illegal_transition'
  | 'authorization_missing'
  | 'contract_not_approved'
  | 'plan_not_approved'
  | 'outside_autonomy_envelope'
  | 'execution_grant_missing'
  | 'stale_snapshot'
  | 'evidence_missing'
  | 'blocking_findings'
  | 'model_cannot_self_admit'
  | 'rollback_unverified';

type TransitionDecision =
  | {
      readonly allowed: true;
      readonly from: WorkflowState;
      readonly to: WorkflowState;
      readonly nextRevision: number;
    }
  | {
      readonly allowed: false;
      readonly code: TransitionRejectionCode;
      readonly message: string;
    };

const LEGAL_TRANSITIONS: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  draft: ['scoped', 'cancelled'],
  scoped: ['planned', 'cancelled'],
  planned: ['authorized', 'replan_requested', 'cancelled'],
  authorized: ['executing', 'blocked', 'replan_requested', 'cancelled'],
  executing: [
    'proposed_complete',
    'blocked',
    'replan_requested',
    'rolling_back',
    'failed',
    'cancelled',
  ],
  proposed_complete: [
    'verifying',
    'executing',
    'blocked',
    'replan_requested',
    'rolling_back',
    'failed',
    'cancelled',
  ],
  verifying: [
    'reviewing',
    'executing',
    'blocked',
    'replan_requested',
    'rolling_back',
    'failed',
    'cancelled',
  ],
  reviewing: [
    'ready_to_merge',
    'executing',
    'blocked',
    'replan_requested',
    'rolling_back',
    'failed',
    'cancelled',
  ],
  ready_to_merge: ['completed', 'reviewing', 'rolling_back', 'failed', 'cancelled'],
  completed: [],
  blocked: [
    'planned',
    'authorized',
    'executing',
    'replan_requested',
    'rolling_back',
    'failed',
    'cancelled',
  ],
  replan_requested: ['planned', 'rolling_back', 'failed', 'cancelled'],
  rolling_back: ['rolled_back', 'rollback_failed'],
  rolled_back: [],
  rollback_failed: [],
  failed: [],
  cancelled: [],
};

function reject(code: TransitionRejectionCode, message: string): TransitionDecision {
  return { allowed: false, code, message };
}

function authorizationGuard(facts: TransitionFacts): TransitionDecision | undefined {
  if (!facts.contractApproved) {
    return reject(
      'contract_not_approved',
      'The task contract must be approved before authorization.',
    );
  }
  if (!facts.planApproved) {
    return reject(
      'plan_not_approved',
      'The active plan version must be approved before authorization.',
    );
  }
  if (facts.authorization === 'none') {
    return reject('authorization_missing', 'No automatic or human authorization is present.');
  }
  if (facts.authorization === 'automatic' && !facts.withinAutonomyEnvelope) {
    return reject(
      'outside_autonomy_envelope',
      'Automatic authorization is limited to the approved autonomy envelope.',
    );
  }
  return undefined;
}

export function decideTransition(proposal: TransitionProposal): TransitionDecision {
  if (proposal.expectedRevision !== proposal.currentRevision) {
    return reject(
      'stale_revision',
      `Expected revision ${proposal.expectedRevision}, current revision is ${proposal.currentRevision}.`,
    );
  }

  if (!LEGAL_TRANSITIONS[proposal.from].includes(proposal.to)) {
    return reject(
      'illegal_transition',
      `Transition ${proposal.from} -> ${proposal.to} is not legal.`,
    );
  }

  const { facts } = proposal;

  if (proposal.to === 'authorized') {
    const authorizationRejection = authorizationGuard(facts);
    if (authorizationRejection) return authorizationRejection;
  }

  if (proposal.to === 'executing') {
    if (!facts.executionGrantValid) {
      return reject('execution_grant_missing', 'Execution requires a valid task-step grant.');
    }
    if (!facts.snapshotCurrent) {
      return reject('stale_snapshot', 'Execution requires the current workspace snapshot.');
    }
  }

  if (proposal.to === 'verifying' && !facts.snapshotCurrent) {
    return reject('stale_snapshot', 'Verification must use the current result snapshot.');
  }

  if (
    (proposal.to === 'reviewing' || proposal.to === 'ready_to_merge') &&
    !facts.requiredEvidenceSatisfied
  ) {
    return reject('evidence_missing', 'Required current-snapshot evidence is missing.');
  }

  if (proposal.to === 'ready_to_merge') {
    if (proposal.actor === 'model') {
      return reject(
        'model_cannot_self_admit',
        'A model may review and propose fixes but cannot admit its own work.',
      );
    }
    if (facts.blockingFindings > 0) {
      return reject(
        'blocking_findings',
        'Blocking review findings must be resolved before admission.',
      );
    }
  }

  if (proposal.to === 'completed') {
    if (proposal.actor === 'model') {
      return reject(
        'model_cannot_self_admit',
        'A model may propose completion but cannot admit its own work.',
      );
    }
    if (!facts.snapshotCurrent) {
      return reject('stale_snapshot', 'Completion requires the current workspace snapshot.');
    }
    if (!facts.requiredEvidenceSatisfied) {
      return reject('evidence_missing', 'Completion requires all mandatory evidence.');
    }
    if (facts.blockingFindings > 0) {
      return reject('blocking_findings', 'Completion is blocked by unresolved review findings.');
    }
  }

  if (proposal.to === 'rolled_back' && !facts.rollbackVerified) {
    return reject('rollback_unverified', 'Rollback must be independently verified.');
  }

  return {
    allowed: true,
    from: proposal.from,
    to: proposal.to,
    nextRevision: proposal.currentRevision + 1,
  };
}
