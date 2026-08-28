import { createHash } from 'node:crypto';
import type { GovernanceEvidenceCandidateLedgerEntry } from './evidence-candidate.js';
import type { TaskAggregate } from './task-aggregate.js';
import { type EvidenceKind, type TaskContractV1, validateTaskContractV1 } from './task-contract.js';

export const VERIFICATION_PLANNER_INPUT_SCHEMA_VERSION = 1 as const;
const VERIFICATION_PLAN_DRAFT_SCHEMA_VERSION = 1 as const;
export const MAX_VERIFICATION_CANDIDATE_PROPOSALS = 512;

interface VerificationPlanningScopeV1 {
  readonly taskId: string;
  readonly contractVersion: number;
  readonly planFingerprint: string;
  readonly workspaceManifestHash: string;
}

interface VerificationCandidateProposalV1 {
  readonly requiredCheckId: string;
  readonly candidateId: string;
}

interface VerificationPlannerInputV1 {
  readonly schemaVersion: typeof VERIFICATION_PLANNER_INPUT_SCHEMA_VERSION;
  readonly scope: VerificationPlanningScopeV1;
  readonly proposals: readonly VerificationCandidateProposalV1[];
}

type VerificationPlannerIssueCode =
  | 'task_missing'
  | 'active_contract_missing'
  | 'contract_invalid'
  | 'invalid_schema_version'
  | 'task_mismatch'
  | 'contract_version_mismatch'
  | 'scope_identity_invalid'
  | 'proposal_limit_exceeded';

interface VerificationPlannerIssue {
  readonly code: VerificationPlannerIssueCode;
  readonly path: string;
  readonly message: string;
}

type VerificationProposalRejectionCode =
  | 'proposal_invalid'
  | 'duplicate_proposal'
  | 'unknown_required_check'
  | 'candidate_missing'
  | 'candidate_ambiguous'
  | 'candidate_ineligible'
  | 'candidate_task_mismatch'
  | 'candidate_plan_mismatch'
  | 'candidate_workspace_mismatch';

type VerificationProposalDisposition =
  | {
      readonly state: 'accepted_as_proposal';
      readonly requiredCheckId: string;
      readonly candidateId: string;
    }
  | {
      readonly state: 'rejected';
      readonly requiredCheckId: string | null;
      readonly candidateId: string | null;
      readonly code: VerificationProposalRejectionCode;
      readonly path: string;
    };

interface VerificationCheckDraftV1 {
  readonly requiredCheckId: string;
  readonly expectedEvidenceKind: EvidenceKind;
  readonly required: boolean;
  readonly requirementIds: readonly string[];
  readonly acceptanceCriterionIds: readonly string[];
  readonly state: 'unassigned' | 'candidates_proposed';
  readonly proposedCandidateIds: readonly string[];
  /** A proposed tool result is never sufficient evidence by itself. */
  readonly evidenceSatisfied: false;
}

export interface VerificationPlanDraftV1 {
  readonly schemaVersion: typeof VERIFICATION_PLAN_DRAFT_SCHEMA_VERSION;
  readonly draftId: string;
  readonly status: 'draft';
  readonly scope: VerificationPlanningScopeV1;
  readonly checks: readonly VerificationCheckDraftV1[];
  readonly proposalDispositions: readonly VerificationProposalDisposition[];
  readonly summary: {
    readonly requiredCheckCount: number;
    readonly requiredChecksWithCandidates: number;
    readonly allRequiredChecksHaveCandidates: boolean;
    readonly requiredEvidenceSatisfied: false;
    readonly nextAction: 'repropose_candidates' | 'independent_verification';
  };
}

type VerificationPlanningResult =
  | { readonly planned: false; readonly issues: readonly VerificationPlannerIssue[] }
  | {
      readonly planned: true;
      readonly issues: readonly VerificationPlannerIssue[];
      readonly draft: VerificationPlanDraftV1;
    };

export function calculateVerificationPlanDraftId(
  draft: Pick<VerificationPlanDraftV1, 'schemaVersion' | 'status' | 'scope' | 'checks'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: draft.schemaVersion,
        status: draft.status,
        scope: draft.scope,
        checks: draft.checks,
      }),
      'utf8',
    )
    .digest('hex');
}

function plannerIssue(
  code: VerificationPlannerIssueCode,
  path: string,
  message: string,
): VerificationPlannerIssue {
  return Object.freeze({ code, path, message });
}

function validIdentityHash(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function fatalIssues(
  contract: TaskContractV1,
  input: VerificationPlannerInputV1,
): readonly VerificationPlannerIssue[] {
  const issues: VerificationPlannerIssue[] = [];
  const contractValidation = validateTaskContractV1(contract);
  if (!contractValidation.valid) {
    for (const issue of contractValidation.issues) {
      issues.push(
        plannerIssue(
          'contract_invalid',
          `contract.${issue.path}`,
          `Task Contract: ${issue.message}`,
        ),
      );
    }
  }
  if (input.schemaVersion !== VERIFICATION_PLANNER_INPUT_SCHEMA_VERSION) {
    issues.push(
      plannerIssue(
        'invalid_schema_version',
        'schemaVersion',
        `Only verification planner schema ${VERIFICATION_PLANNER_INPUT_SCHEMA_VERSION} is supported.`,
      ),
    );
  }
  if (input.scope.taskId !== contract.taskId) {
    issues.push(
      plannerIssue(
        'task_mismatch',
        'scope.taskId',
        'Planner scope must match the Task Contract task.',
      ),
    );
  }
  if (input.scope.contractVersion !== contract.contractVersion) {
    issues.push(
      plannerIssue(
        'contract_version_mismatch',
        'scope.contractVersion',
        'Planner scope must reference the exact Task Contract version.',
      ),
    );
  }
  if (
    !validIdentityHash(input.scope.planFingerprint) ||
    !validIdentityHash(input.scope.workspaceManifestHash)
  ) {
    issues.push(
      plannerIssue(
        'scope_identity_invalid',
        'scope',
        'Planner scope requires SHA-256 plan and workspace identities.',
      ),
    );
  }
  if (input.proposals.length > MAX_VERIFICATION_CANDIDATE_PROPOSALS) {
    issues.push(
      plannerIssue(
        'proposal_limit_exceeded',
        'proposals',
        `Planner input must not exceed ${MAX_VERIFICATION_CANDIDATE_PROPOSALS} candidate proposals.`,
      ),
    );
  }
  return Object.freeze(issues);
}

function acceptanceCriteriaForCheck(
  contract: TaskContractV1,
  requirementIds: readonly string[],
): readonly string[] {
  const requirementSet = new Set(requirementIds);
  const criterionSet = new Set(
    contract.requirements
      .filter((requirement) => requirementSet.has(requirement.id))
      .flatMap((requirement) => requirement.acceptanceCriteriaIds),
  );
  return Object.freeze(
    contract.acceptanceCriteria
      .filter((criterion) => criterionSet.has(criterion.id))
      .map((criterion) => criterion.id),
  );
}

function reject(
  proposal: Partial<VerificationCandidateProposalV1>,
  index: number,
  code: VerificationProposalRejectionCode,
): VerificationProposalDisposition {
  return Object.freeze({
    state: 'rejected',
    requiredCheckId: typeof proposal.requiredCheckId === 'string' ? proposal.requiredCheckId : null,
    candidateId: typeof proposal.candidateId === 'string' ? proposal.candidateId : null,
    code,
    path: `proposals[${index}]`,
  });
}

function buildVerificationPlanDraftFromContract(
  contract: TaskContractV1,
  candidates: readonly GovernanceEvidenceCandidateLedgerEntry[],
  input: VerificationPlannerInputV1,
): VerificationPlanningResult {
  const issues = fatalIssues(contract, input);
  if (issues.length > 0) return Object.freeze({ planned: false, issues });

  const checks = new Map(contract.requiredChecks.map((check) => [check.id, check]));
  const candidatesById = new Map<string, GovernanceEvidenceCandidateLedgerEntry[]>();
  for (const candidate of candidates) {
    if (!candidate.candidateId) continue;
    const entries = candidatesById.get(candidate.candidateId) ?? [];
    entries.push(candidate);
    candidatesById.set(candidate.candidateId, entries);
  }
  const accepted = new Map<string, Set<string>>();
  const seenPairs = new Set<string>();
  const dispositions: VerificationProposalDisposition[] = [];

  for (const [index, proposal] of input.proposals.entries()) {
    if (
      typeof proposal.requiredCheckId !== 'string' ||
      proposal.requiredCheckId.trim().length === 0 ||
      typeof proposal.candidateId !== 'string' ||
      !validIdentityHash(proposal.candidateId)
    ) {
      dispositions.push(reject(proposal, index, 'proposal_invalid'));
      continue;
    }
    const pair = `${proposal.requiredCheckId}\u0000${proposal.candidateId}`;
    if (seenPairs.has(pair)) {
      dispositions.push(reject(proposal, index, 'duplicate_proposal'));
      continue;
    }
    seenPairs.add(pair);
    if (!checks.has(proposal.requiredCheckId)) {
      dispositions.push(reject(proposal, index, 'unknown_required_check'));
      continue;
    }
    const matching = candidatesById.get(proposal.candidateId) ?? [];
    if (matching.length === 0) {
      dispositions.push(reject(proposal, index, 'candidate_missing'));
      continue;
    }
    if (matching.length > 1) {
      dispositions.push(reject(proposal, index, 'candidate_ambiguous'));
      continue;
    }
    const candidate = matching[0]!;
    if (candidate.evaluation.state !== 'eligible_for_evaluation') {
      dispositions.push(reject(proposal, index, 'candidate_ineligible'));
      continue;
    }
    if (candidate.taskId !== input.scope.taskId) {
      dispositions.push(reject(proposal, index, 'candidate_task_mismatch'));
      continue;
    }
    if (candidate.planFingerprint !== input.scope.planFingerprint) {
      dispositions.push(reject(proposal, index, 'candidate_plan_mismatch'));
      continue;
    }
    if (candidate.workspaceManifestHash !== input.scope.workspaceManifestHash) {
      dispositions.push(reject(proposal, index, 'candidate_workspace_mismatch'));
      continue;
    }
    const candidateIds = accepted.get(proposal.requiredCheckId) ?? new Set<string>();
    candidateIds.add(proposal.candidateId);
    accepted.set(proposal.requiredCheckId, candidateIds);
    dispositions.push(
      Object.freeze({
        state: 'accepted_as_proposal',
        requiredCheckId: proposal.requiredCheckId,
        candidateId: proposal.candidateId,
      }),
    );
  }

  const checkDrafts = contract.requiredChecks.map((check): VerificationCheckDraftV1 => {
    const proposedCandidateIds = Object.freeze([...(accepted.get(check.id) ?? [])].sort());
    return Object.freeze({
      requiredCheckId: check.id,
      expectedEvidenceKind: check.kind,
      required: check.required,
      requirementIds: Object.freeze([...check.requirementIds]),
      acceptanceCriterionIds: acceptanceCriteriaForCheck(contract, check.requirementIds),
      state: proposedCandidateIds.length > 0 ? 'candidates_proposed' : 'unassigned',
      proposedCandidateIds,
      evidenceSatisfied: false,
    });
  });
  const requiredChecks = checkDrafts.filter((check) => check.required);
  const requiredChecksWithCandidates = requiredChecks.filter(
    (check) => check.proposedCandidateIds.length > 0,
  ).length;
  const allRequiredChecksHaveCandidates = requiredChecksWithCandidates === requiredChecks.length;
  const normalizedDraft = {
    schemaVersion: VERIFICATION_PLAN_DRAFT_SCHEMA_VERSION,
    status: 'draft' as const,
    scope: input.scope,
    checks: checkDrafts,
  };
  const draftId = calculateVerificationPlanDraftId(normalizedDraft);
  return Object.freeze({
    planned: true,
    issues: Object.freeze([]),
    draft: Object.freeze({
      ...normalizedDraft,
      draftId,
      checks: Object.freeze(checkDrafts),
      proposalDispositions: Object.freeze(dispositions),
      summary: Object.freeze({
        requiredCheckCount: requiredChecks.length,
        requiredChecksWithCandidates,
        allRequiredChecksHaveCandidates,
        requiredEvidenceSatisfied: false,
        nextAction: allRequiredChecksHaveCandidates
          ? 'independent_verification'
          : 'repropose_candidates',
      }),
    }),
  });
}

export function buildVerificationPlanDraft(
  task: TaskAggregate | null,
  candidates: readonly GovernanceEvidenceCandidateLedgerEntry[],
  input: VerificationPlannerInputV1,
): VerificationPlanningResult {
  if (!task) {
    return Object.freeze({
      planned: false,
      issues: Object.freeze([
        plannerIssue(
          'task_missing',
          'task',
          'Canonical task state is required for verification planning.',
        ),
      ]),
    });
  }
  const contract = task.contracts.find(
    (candidate) => candidate.contractVersion === task.activeContractVersion,
  );
  if (!contract) {
    return Object.freeze({
      planned: false,
      issues: Object.freeze([
        plannerIssue(
          'active_contract_missing',
          'task.activeContractVersion',
          'Canonical task state does not contain its active Task Contract version.',
        ),
      ]),
    });
  }
  return buildVerificationPlanDraftFromContract(contract, candidates, input);
}
