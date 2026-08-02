import { describe, expect, it } from 'vitest';
import {
  buildVerificationPlanDraft,
  type GovernanceEvidenceCandidateLedgerEntry,
  MAX_VERIFICATION_CANDIDATE_PROPOSALS,
  TASK_CONTRACT_SCHEMA_VERSION,
  type TaskAggregate,
  type TaskContractV1,
  VERIFICATION_PLANNER_INPUT_SCHEMA_VERSION,
} from '../src/index.js';

function contract(overrides: Partial<TaskContractV1> = {}): TaskContractV1 {
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: 'task-1',
    contractVersion: 2,
    projectId: 'project-1',
    sourceRequest: 'Create a deterministic verification draft.',
    policyVersion: 'policy-1',
    repository: { rootIdentity: 'repository-1', baselinePolicy: 'required' },
    requirements: [
      { id: 'req-1', text: 'Preserve behavior.', acceptanceCriteriaIds: ['ac-1', 'ac-2'] },
    ],
    acceptanceCriteria: [
      { id: 'ac-1', statement: 'Focused tests pass.', evidenceKinds: ['test'] },
      { id: 'ac-2', statement: 'Types remain valid.', evidenceKinds: ['typecheck'] },
    ],
    autonomy: {
      tier: 'A2',
      allowedOperations: ['repository_read', 'focused_check'],
      humanApprovalRequiredFor: [],
      allowedPaths: ['packages/governance/**'],
      deniedPaths: [],
      budget: {
        maxChangedFiles: 10,
        maxChangedLines: 1_000,
        maxNewDependencies: 0,
        maxRetries: 3,
        maxReplans: 2,
        maxSubagents: 2,
        maxWallClockMs: 900_000,
      },
      autoAuthorizePlan: true,
      autoReplanLimit: 2,
      autoResolveReviewFixes: true,
    },
    requiredChecks: [
      { id: 'check-test', kind: 'test', required: true, requirementIds: ['req-1'] },
      { id: 'check-types', kind: 'typecheck', required: true, requirementIds: ['req-1'] },
    ],
    requiredReviewDimensions: ['correctness'],
    rollbackClass: 'git_revert',
    assumptions: [],
    sources: {
      requirements: 'explicit_user',
      scope: 'project_policy',
      checks: 'deterministic_inference',
      autonomy: 'project_policy',
    },
    ...overrides,
  };
}

function task(contractOverride: Partial<TaskContractV1> = {}): TaskAggregate {
  const activeContract = contract(contractOverride);
  return {
    taskId: activeContract.taskId,
    projectId: activeContract.projectId,
    revision: 2,
    state: 'executing',
    contracts: [activeContract],
    activeContractVersion: activeContract.contractVersion,
    plans: [],
    activePlanVersion: null,
    replanRequestedFromPlanVersion: null,
    createdAt: '2026-08-02T11:00:00.000Z',
    updatedAt: '2026-08-02T12:00:00.000Z',
  };
}

const planFingerprint = 'a'.repeat(64);
const workspaceManifestHash = 'b'.repeat(64);

function candidate(
  candidateId: string,
  overrides: Partial<GovernanceEvidenceCandidateLedgerEntry> = {},
): GovernanceEvidenceCandidateLedgerEntry {
  return {
    sequence: 1,
    observationId: `observation-${candidateId.slice(0, 4)}`,
    source: 'model-client',
    taskId: 'task-1',
    observedAt: '2026-08-02T12:00:00.000Z',
    recordedAt: '2026-08-02T12:00:01.000Z',
    candidateId,
    toolCallId: 'tool-1',
    toolName: 'shell',
    outcomeStatus: 'succeeded',
    planFingerprint,
    workspaceManifestHash,
    workspaceBaseHead: 'c'.repeat(40),
    evaluation: { state: 'eligible_for_evaluation', reasons: [] },
    ...overrides,
  };
}

function input(
  proposals: readonly { readonly requiredCheckId: string; readonly candidateId: string }[],
) {
  return {
    schemaVersion: VERIFICATION_PLANNER_INPUT_SCHEMA_VERSION,
    scope: { taskId: 'task-1', contractVersion: 2, planFingerprint, workspaceManifestHash },
    proposals,
  };
}

describe('deterministic verification planner draft', () => {
  it('keeps model links proposed while deriving requirement and acceptance-criterion traceability', () => {
    const firstId = '1'.repeat(64);
    const secondId = '2'.repeat(64);
    const proposals = [
      { requiredCheckId: 'check-types', candidateId: secondId },
      { requiredCheckId: 'check-test', candidateId: firstId },
    ];
    const result = buildVerificationPlanDraft(
      task(),
      [candidate(firstId), candidate(secondId, { sequence: 2 })],
      input(proposals),
    );
    const reordered = buildVerificationPlanDraft(
      task(),
      [candidate(secondId, { sequence: 2 }), candidate(firstId)],
      input([...proposals].reverse()),
    );

    expect(result).toMatchObject({
      planned: true,
      draft: {
        status: 'draft',
        checks: [
          {
            requiredCheckId: 'check-test',
            expectedEvidenceKind: 'test',
            requirementIds: ['req-1'],
            acceptanceCriterionIds: ['ac-1', 'ac-2'],
            state: 'candidates_proposed',
            proposedCandidateIds: [firstId],
            evidenceSatisfied: false,
          },
          {
            requiredCheckId: 'check-types',
            expectedEvidenceKind: 'typecheck',
            proposedCandidateIds: [secondId],
            evidenceSatisfied: false,
          },
        ],
        summary: {
          allRequiredChecksHaveCandidates: true,
          requiredEvidenceSatisfied: false,
          nextAction: 'independent_verification',
        },
      },
    });
    expect(result.planned && reordered.planned && reordered.draft.draftId).toBe(
      result.planned ? result.draft.draftId : null,
    );
  });

  it('rejects stale and ineligible links without converting them into evidence', () => {
    const stalePlanId = '3'.repeat(64);
    const staleWorkspaceId = '4'.repeat(64);
    const ineligibleId = '5'.repeat(64);
    const result = buildVerificationPlanDraft(
      task(),
      [
        candidate(stalePlanId, { planFingerprint: 'd'.repeat(64) }),
        candidate(staleWorkspaceId, { workspaceManifestHash: 'e'.repeat(64) }),
        candidate(ineligibleId, {
          evaluation: { state: 'ineligible', reasons: ['binding_incomplete'] },
        }),
      ],
      input([
        { requiredCheckId: 'check-test', candidateId: stalePlanId },
        { requiredCheckId: 'check-test', candidateId: staleWorkspaceId },
        { requiredCheckId: 'check-types', candidateId: ineligibleId },
      ]),
    );

    expect(result).toMatchObject({
      planned: true,
      draft: {
        proposalDispositions: [
          { state: 'rejected', code: 'candidate_plan_mismatch' },
          { state: 'rejected', code: 'candidate_workspace_mismatch' },
          { state: 'rejected', code: 'candidate_ineligible' },
        ],
        summary: {
          requiredChecksWithCandidates: 0,
          requiredEvidenceSatisfied: false,
          nextAction: 'repropose_candidates',
        },
      },
    });
  });

  it('rejects duplicate, unknown, missing, and ambiguous proposals explicitly', () => {
    const validId = '6'.repeat(64);
    const ambiguousId = '7'.repeat(64);
    const result = buildVerificationPlanDraft(
      task(),
      [candidate(validId), candidate(ambiguousId), candidate(ambiguousId, { sequence: 2 })],
      input([
        { requiredCheckId: 'check-test', candidateId: validId },
        { requiredCheckId: 'check-test', candidateId: validId },
        { requiredCheckId: 'missing-check', candidateId: validId },
        { requiredCheckId: 'check-types', candidateId: '8'.repeat(64) },
        { requiredCheckId: 'check-types', candidateId: ambiguousId },
      ]),
    );

    expect(result).toMatchObject({
      planned: true,
      draft: {
        proposalDispositions: [
          { state: 'accepted_as_proposal' },
          { state: 'rejected', code: 'duplicate_proposal' },
          { state: 'rejected', code: 'unknown_required_check' },
          { state: 'rejected', code: 'candidate_missing' },
          { state: 'rejected', code: 'candidate_ambiguous' },
        ],
        summary: { requiredEvidenceSatisfied: false },
      },
    });
  });

  it('refuses stale contract scope and oversized model proposal sets before drafting', () => {
    const stale = buildVerificationPlanDraft(task(), [], {
      ...input([]),
      scope: { ...input([]).scope, contractVersion: 1, planFingerprint: 'invalid' },
    });
    const oversized = buildVerificationPlanDraft(
      task(),
      [],
      input(
        Array.from({ length: MAX_VERIFICATION_CANDIDATE_PROPOSALS + 1 }, (_, index) => ({
          requiredCheckId: 'check-test',
          candidateId: index.toString(16).padStart(64, '0'),
        })),
      ),
    );

    expect(stale.planned).toBe(false);
    if (stale.planned) throw new Error('Expected stale planner input to be rejected.');
    expect(stale.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['contract_version_mismatch', 'scope_identity_invalid']),
    );
    expect(oversized).toMatchObject({
      planned: false,
      issues: [{ code: 'proposal_limit_exceeded' }],
    });
  });

  it('requires the canonical task and its active contract instead of a caller-owned copy', () => {
    const missing = buildVerificationPlanDraft(null, [], input([]));
    const canonicalTask = task();
    const missingActive = buildVerificationPlanDraft(
      { ...canonicalTask, activeContractVersion: 99 },
      [],
      input([]),
    );

    expect(missing).toMatchObject({ planned: false, issues: [{ code: 'task_missing' }] });
    expect(missingActive).toMatchObject({
      planned: false,
      issues: [{ code: 'active_contract_missing' }],
    });
  });
});
