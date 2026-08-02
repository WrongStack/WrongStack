import { describe, expect, it } from 'vitest';
import {
  buildVerificationPlanDraft,
  calculateVerificationPlanDraftId,
  type GovernanceEvidenceCandidateLedgerEntry,
  issueBoundVerificationRunContract,
  issueVerificationRunContract,
  MAX_VERIFICATION_RUN_TTL_MS,
  TASK_CONTRACT_SCHEMA_VERSION,
  type TaskAggregate,
  type TaskContractV1,
  VERIFICATION_PLANNER_INPUT_SCHEMA_VERSION,
  VERIFICATION_RUN_REQUEST_SCHEMA_VERSION,
  VerificationCheckRegistry,
  type VerificationPlanDraftV1,
} from '../src/index.js';

const candidateId = '1'.repeat(64);
const planFingerprint = 'a'.repeat(64);
const workspaceManifestHash = 'b'.repeat(64);

function contract(
  allowedOperations: TaskContractV1['autonomy']['allowedOperations'] = [
    'repository_read',
    'focused_check',
  ],
): TaskContractV1 {
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: 'task-1',
    contractVersion: 2,
    projectId: 'project-1',
    sourceRequest: 'Issue an independent verification run contract.',
    policyVersion: 'policy-1',
    repository: { rootIdentity: 'repository-1', baselinePolicy: 'required' },
    requirements: [{ id: 'req-1', text: 'Preserve behavior.', acceptanceCriteriaIds: ['ac-1'] }],
    acceptanceCriteria: [{ id: 'ac-1', statement: 'Focused tests pass.', evidenceKinds: ['test'] }],
    autonomy: {
      tier: 'A2',
      allowedOperations,
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
    requiredChecks: [{ id: 'check-test', kind: 'test', required: true, requirementIds: ['req-1'] }],
    requiredReviewDimensions: ['correctness'],
    rollbackClass: 'git_revert',
    assumptions: [],
    sources: {
      requirements: 'explicit_user',
      scope: 'project_policy',
      checks: 'deterministic_inference',
      autonomy: 'project_policy',
    },
  };
}

function task(
  state: TaskAggregate['state'] = 'proposed_complete',
  activeContract: TaskContractV1 = contract(),
): TaskAggregate {
  return {
    taskId: activeContract.taskId,
    projectId: activeContract.projectId,
    revision: 3,
    state,
    contracts: [activeContract],
    activeContractVersion: activeContract.contractVersion,
    plans: [],
    activePlanVersion: null,
    replanRequestedFromPlanVersion: null,
    createdAt: '2026-08-02T11:00:00.000Z',
    updatedAt: '2026-08-02T12:00:00.000Z',
  };
}

function candidate(
  overrides: Partial<GovernanceEvidenceCandidateLedgerEntry> = {},
): GovernanceEvidenceCandidateLedgerEntry {
  return {
    sequence: 1,
    observationId: 'observation-1',
    source: 'executor-client',
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

function draft(canonicalTask: TaskAggregate = task()): VerificationPlanDraftV1 {
  const result = buildVerificationPlanDraft(canonicalTask, [candidate()], {
    schemaVersion: VERIFICATION_PLANNER_INPUT_SCHEMA_VERSION,
    scope: {
      taskId: 'task-1',
      contractVersion: 2,
      planFingerprint,
      workspaceManifestHash,
    },
    proposals: [{ requiredCheckId: 'check-test', candidateId }],
  });
  if (!result.planned) throw new Error('Expected verification draft.');
  return result.draft;
}

const request = {
  schemaVersion: VERIFICATION_RUN_REQUEST_SCHEMA_VERSION,
  draftId: '',
  requiredCheckId: 'check-test',
  candidateId,
};

const authority = {
  verifierClientId: 'independent-verifier',
  issuedAt: '2026-08-02T12:05:00.000Z',
  ttlMs: 60_000,
  maxDurationMs: 30_000,
};

describe('verification run contract', () => {
  it('issues a stable snapshot-bound contract without granting self-approval', () => {
    const canonicalTask = task();
    const plan = draft(canonicalTask);
    const runRequest = { ...request, draftId: plan.draftId };
    const first = issueVerificationRunContract(
      canonicalTask,
      plan,
      [candidate()],
      runRequest,
      authority,
    );
    const replay = issueVerificationRunContract(
      canonicalTask,
      plan,
      [candidate()],
      runRequest,
      authority,
    );

    expect(first).toMatchObject({
      issued: true,
      contract: {
        schemaVersion: 1,
        runId: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: 'authorized',
        taskId: 'task-1',
        contractVersion: 2,
        planFingerprint,
        workspaceManifestHash,
        requiredCheckId: 'check-test',
        expectedEvidenceKind: 'test',
        candidateId,
        candidateSource: 'executor-client',
        verifierClientId: 'independent-verifier',
        authorization: { operation: 'focused_check', mode: 'automatic', autonomyTier: 'A2' },
        limits: {
          issuedAt: '2026-08-02T12:05:00.000Z',
          expiresAt: '2026-08-02T12:06:00.000Z',
          ttlMs: 60_000,
          maxDurationMs: 30_000,
        },
        resultPolicy: {
          executorMayApprove: false,
          independentToolEvidenceRequired: true,
          freshWorkspaceIdentityRequired: true,
        },
      },
    });
    expect(first.issued && replay.issued && replay.contract.runId).toBe(
      first.issued ? first.contract.runId : null,
    );
  });

  it('issues v2 with an immutable registry and handler-version binding', () => {
    const canonicalTask = task();
    const plan = draft(canonicalTask);
    const runRequest = { ...request, draftId: plan.draftId };
    const registry = new VerificationCheckRegistry([
      {
        id: 'check-test',
        evidenceKind: 'test',
        handlerVersion: '1.0.0',
        executionClass: 'trusted_deterministic',
        run: async () => 'ok',
      },
    ]);
    const resolved = registry.bindingFor('check-test', 'test');
    if (!resolved.bound) throw new Error(resolved.message);

    const first = issueBoundVerificationRunContract(
      canonicalTask,
      plan,
      [candidate()],
      runRequest,
      { ...authority, checkBinding: resolved.binding },
    );
    const replay = issueBoundVerificationRunContract(
      canonicalTask,
      plan,
      [candidate()],
      runRequest,
      { ...authority, checkBinding: resolved.binding },
    );

    expect(first).toMatchObject({
      issued: true,
      contract: {
        schemaVersion: 2,
        checkBinding: {
          registryFingerprint: registry.fingerprint(),
          checkId: 'check-test',
          evidenceKind: 'test',
          handlerVersion: '1.0.0',
          executionClass: 'trusted_deterministic',
          handlerFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(replay).toEqual(first);

    const changedRegistry = new VerificationCheckRegistry([
      {
        id: 'check-test',
        evidenceKind: 'test',
        handlerVersion: '1.0.1',
        executionClass: 'trusted_deterministic',
        run: async () => 'ok',
      },
    ]);
    const changed = changedRegistry.bindingFor('check-test', 'test');
    if (!changed.bound) throw new Error(changed.message);
    const changedRun = issueBoundVerificationRunContract(
      canonicalTask,
      plan,
      [candidate()],
      runRequest,
      { ...authority, checkBinding: changed.binding },
    );
    if (!first.issued || !changedRun.issued) throw new Error('Expected bound runs.');
    expect(changedRun.contract.runId).not.toBe(first.contract.runId);
  });

  it('rejects tampered and canonically mismatched trusted check bindings', () => {
    const canonicalTask = task();
    const plan = draft(canonicalTask);
    const runRequest = { ...request, draftId: plan.draftId };
    const registry = new VerificationCheckRegistry([
      {
        id: 'check-test',
        evidenceKind: 'test',
        handlerVersion: '1.0.0',
        executionClass: 'trusted_deterministic',
        run: async () => 'ok',
      },
      {
        id: 'check-other',
        evidenceKind: 'test',
        handlerVersion: '1.0.0',
        executionClass: 'trusted_deterministic',
        run: async () => 'ok',
      },
    ]);
    const matching = registry.bindingFor('check-test', 'test');
    const other = registry.bindingFor('check-other', 'test');
    if (!matching.bound || !other.bound) throw new Error('Expected registry bindings.');

    expect(
      issueBoundVerificationRunContract(canonicalTask, plan, [candidate()], runRequest, {
        ...authority,
        checkBinding: { ...matching.binding, handlerVersion: 'tampered' },
      }),
    ).toMatchObject({ issued: false, issues: [{ code: 'check_binding_invalid' }] });
    expect(
      issueBoundVerificationRunContract(canonicalTask, plan, [candidate()], runRequest, {
        ...authority,
        checkBinding: other.binding,
      }),
    ).toMatchObject({ issued: false, issues: [{ code: 'check_binding_mismatch' }] });
  });

  it('requires an independent verifier and a verification workflow state', () => {
    const canonicalTask = task();
    const plan = draft(canonicalTask);
    const runRequest = { ...request, draftId: plan.draftId };
    const sameActor = issueVerificationRunContract(canonicalTask, plan, [candidate()], runRequest, {
      ...authority,
      verifierClientId: 'executor-client',
    });
    const wrongState = issueVerificationRunContract(
      task('executing'),
      plan,
      [candidate()],
      runRequest,
      authority,
    );

    expect(sameActor).toMatchObject({
      issued: false,
      issues: [{ code: 'verifier_not_independent' }],
    });
    expect(wrongState).toMatchObject({
      issued: false,
      issues: [{ code: 'workflow_state_invalid' }],
    });
  });

  it('rejects stale candidates, unproposed candidates, and drifted draft checks', () => {
    const canonicalTask = task();
    const plan = draft(canonicalTask);
    const runRequest = { ...request, draftId: plan.draftId };
    const stale = issueVerificationRunContract(
      canonicalTask,
      plan,
      [candidate({ workspaceManifestHash: 'd'.repeat(64) })],
      runRequest,
      authority,
    );
    const notProposedId = '2'.repeat(64);
    const notProposed = issueVerificationRunContract(
      canonicalTask,
      plan,
      [candidate({ candidateId: notProposedId })],
      { ...runRequest, candidateId: notProposedId },
      authority,
    );
    const driftedBase = {
      ...plan,
      checks: plan.checks.map((check) => ({ ...check, expectedEvidenceKind: 'lint' as const })),
    };
    const drifted = {
      ...driftedBase,
      draftId: calculateVerificationPlanDraftId(driftedBase),
    };
    const checkDrift = issueVerificationRunContract(
      canonicalTask,
      drifted,
      [candidate()],
      { ...runRequest, draftId: drifted.draftId },
      authority,
    );

    expect(stale).toMatchObject({ issued: false, issues: [{ code: 'candidate_scope_mismatch' }] });
    expect(notProposed).toMatchObject({
      issued: false,
      issues: [{ code: 'candidate_not_proposed' }],
    });
    expect(checkDrift).toMatchObject({
      issued: false,
      issues: [{ code: 'required_check_drifted' }],
    });
  });

  it('enforces autonomy and trusted authority time limits', () => {
    const deniedTask = task('proposed_complete', contract(['repository_read']));
    const deniedDraft = draft(deniedTask);
    const denied = issueVerificationRunContract(
      deniedTask,
      deniedDraft,
      [candidate()],
      { ...request, draftId: deniedDraft.draftId },
      authority,
    );
    const canonicalTask = task();
    const plan = draft(canonicalTask);
    const runRequest = { ...request, draftId: plan.draftId };
    const invalidTime = issueVerificationRunContract(
      canonicalTask,
      plan,
      [candidate()],
      runRequest,
      { ...authority, issuedAt: 'not-a-time' },
    );
    const invalidLimits = issueVerificationRunContract(
      canonicalTask,
      plan,
      [candidate()],
      runRequest,
      { ...authority, ttlMs: MAX_VERIFICATION_RUN_TTL_MS + 1 },
    );

    expect(denied).toMatchObject({
      issued: false,
      issues: [{ code: 'operation_not_authorized' }],
    });
    expect(invalidTime).toMatchObject({
      issued: false,
      issues: [{ code: 'authority_time_invalid' }],
    });
    expect(invalidLimits).toMatchObject({
      issued: false,
      issues: [{ code: 'authority_limits_invalid' }],
    });
  });
});
