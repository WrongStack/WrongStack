import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildVerificationPlanDraft,
  calculatePlanVersionFingerprint,
  createGovernanceEvidenceCandidate,
  evaluateGovernanceEvidenceCandidateObservation,
  type GovernanceCommand,
  type GovernanceDecisionContext,
  type GovernanceEvidenceCandidateLedgerEntry,
  PLAN_VERSION_SCHEMA_VERSION,
  type PlanVersionV1,
  SqliteGovernanceEventStore,
  TASK_CONTRACT_SCHEMA_VERSION,
  type TaskAggregate,
  type TaskContractV1,
  type TransitionFacts,
  VERIFICATION_PLANNER_INPUT_SCHEMA_VERSION,
  type VerificationCheckRegistration,
  VerificationCheckRegistry,
  VerificationIssuanceCoordinator,
  type VerificationIssuanceCoordinatorInput,
  VerificationToolGateway,
  verificationExecutionLeaseId,
  workspaceSnapshotFenceId,
} from '../src/index.js';

const temporaryDirectories: string[] = [];
const stores: SqliteGovernanceEventStore[] = [];
const planFingerprint = 'a'.repeat(64);
const workspaceManifestHash = 'b'.repeat(64);
const evidenceTrace = {
  sessionId: 'session-1',
  task: { scope: 'kanban_task' as const, taskId: 'task-1', boardId: 'board-1' },
  plan: { state: 'available' as const, fingerprint: planFingerprint },
  workspace: {
    state: 'captured' as const,
    manifestHash: workspaceManifestHash,
    baseHead: 'c'.repeat(40),
  },
};
const evidencePayload = {
  ...createGovernanceEvidenceCandidate(evidenceTrace, {
    toolCallId: 'tool-1',
    toolName: 'shell',
    ok: true,
    durationMs: 25,
  }),
  trace: evidenceTrace,
};
const canonicalCandidate = evaluateGovernanceEvidenceCandidateObservation({
  sequence: 1,
  observationId: 'observation-1',
  source: 'executor-client',
  taskId: 'task-1',
  category: 'evidence_candidate',
  observedAt: '2026-08-02T12:00:00.000Z',
  recordedAt: '2026-08-02T12:05:00.000Z',
  payload: evidencePayload,
});
if (!canonicalCandidate.candidateId) throw new Error('Expected canonical candidate identity.');
const candidateId = canonicalCandidate.candidateId;

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function coordinatorDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wrongstack-verification-coordinator-'));
  temporaryDirectories.push(directory);
  return join(directory, 'governance.sqlite');
}

function openStoreAt(path: string, seed: boolean): SqliteGovernanceEventStore {
  const store = SqliteGovernanceEventStore.open(path, {
    now: () => '2026-08-02T12:05:00.000Z',
    verificationLeaseSecret: () => 's'.repeat(43),
  });
  stores.push(store);
  if (seed) {
    seedCanonicalTask(store);
    seedCanonicalCandidate(store);
  }
  return store;
}

function openStore(): SqliteGovernanceEventStore {
  return openStoreAt(coordinatorDatabasePath(), true);
}

function taskContract(): TaskContractV1 {
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: 'task-1',
    contractVersion: 1,
    projectId: 'project-1',
    sourceRequest: 'Issue a registry-bound verification capability.',
    policyVersion: 'policy-1',
    repository: { rootIdentity: 'repository-1', baselinePolicy: 'required' },
    requirements: [{ id: 'req-1', text: 'Preserve behavior.', acceptanceCriteriaIds: ['ac-1'] }],
    acceptanceCriteria: [{ id: 'ac-1', statement: 'Focused tests pass.', evidenceKinds: ['test'] }],
    autonomy: {
      tier: 'A2',
      allowedOperations: ['repository_read', 'file_edit', 'focused_check'],
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

function planVersion(): PlanVersionV1 {
  return {
    schemaVersion: PLAN_VERSION_SCHEMA_VERSION,
    planId: 'plan-1',
    taskId: 'task-1',
    planVersion: 1,
    parentPlanVersion: null,
    contractVersion: 1,
    createdBy: 'model',
    createdAt: '2026-08-02T11:01:00.000Z',
    changeReason: 'Initial bounded verification plan.',
    steps: [
      {
        id: 'implement',
        title: 'Implement',
        description: 'Implement the bounded governance change.',
        operations: ['file_edit'],
        expectedPaths: ['packages/governance/src/verification-issuance-coordinator.ts'],
        requirementIds: ['req-1'],
        acceptanceCriteriaIds: ['ac-1'],
        requiredCheckIds: ['check-test'],
      },
    ],
    edges: [],
  };
}

const transitionFacts: TransitionFacts = {
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

const decisionContext: GovernanceDecisionContext = { transitionFacts };

function seedCanonicalTask(store: SqliteGovernanceEventStore): void {
  const contract = taskContract();
  const commands: GovernanceCommand[] = [
    {
      type: 'create_task',
      commandId: 'seed-create',
      taskId: 'task-1',
      expectedRevision: 0,
      actor: 'model',
      issuedAt: '2026-08-02T11:00:00.000Z',
      projectId: 'project-1',
      contract,
    },
    {
      type: 'transition_task',
      commandId: 'seed-scope',
      taskId: 'task-1',
      expectedRevision: 1,
      actor: 'model',
      issuedAt: '2026-08-02T11:01:00.000Z',
      to: 'scoped',
    },
    {
      type: 'attach_plan_version',
      commandId: 'seed-plan',
      taskId: 'task-1',
      expectedRevision: 2,
      actor: 'model',
      issuedAt: '2026-08-02T11:02:00.000Z',
      plan: planVersion(),
    },
    ...(['planned', 'authorized', 'executing', 'proposed_complete'] as const).map(
      (to, index): GovernanceCommand => ({
        type: 'transition_task',
        commandId: `seed-${to}`,
        taskId: 'task-1',
        expectedRevision: index + 3,
        actor: 'model',
        issuedAt: `2026-08-02T11:0${index + 3}:00.000Z`,
        to,
      }),
    ),
  ];
  for (const command of commands) {
    const execution = store.execute(command, decisionContext);
    if (!execution.handled) {
      throw new Error(
        `Could not seed canonical governance task with ${command.commandId}: ${execution.code}: ${execution.message}`,
      );
    }
    if (!execution.decision.accepted) {
      const decision = execution.decision;
      throw new Error(
        `Could not seed canonical governance task with ${command.commandId}: ${decision.code}: ${decision.message}`,
      );
    }
  }
}

function seedCanonicalCandidate(store: SqliteGovernanceEventStore): void {
  const append = store.appendObservation({
    observationId: 'observation-1',
    projectId: 'project-1',
    taskId: 'task-1',
    source: 'executor-client',
    category: 'evidence_candidate',
    observedAt: '2026-08-02T12:00:00.000Z',
    payload: evidencePayload,
  });
  if (!append.handled) throw new Error(`Could not seed candidate: ${append.code}.`);
}

function candidate(): GovernanceEvidenceCandidateLedgerEntry {
  return canonicalCandidate;
}

function input(
  selectedCandidate: GovernanceEvidenceCandidateLedgerEntry = candidate(),
): VerificationIssuanceCoordinatorInput {
  const contract = taskContract();
  const task: TaskAggregate = {
    taskId: contract.taskId,
    projectId: contract.projectId,
    revision: 7,
    state: 'proposed_complete',
    contracts: [contract],
    activeContractVersion: contract.contractVersion,
    plans: [planVersion()],
    activePlanVersion: 1,
    replanRequestedFromPlanVersion: null,
    createdAt: '2026-08-02T11:00:00.000Z',
    updatedAt: '2026-08-02T12:00:00.000Z',
  };
  const selectedCandidateId = selectedCandidate.candidateId ?? candidateId;
  const selectedPlanFingerprint = selectedCandidate.planFingerprint ?? planFingerprint;
  const selectedWorkspaceManifestHash =
    selectedCandidate.workspaceManifestHash ?? workspaceManifestHash;
  const planned = buildVerificationPlanDraft(task, [selectedCandidate], {
    schemaVersion: VERIFICATION_PLANNER_INPUT_SCHEMA_VERSION,
    scope: {
      taskId: task.taskId,
      contractVersion: 1,
      planFingerprint: selectedPlanFingerprint,
      workspaceManifestHash: selectedWorkspaceManifestHash,
    },
    proposals: [{ requiredCheckId: 'check-test', candidateId: selectedCandidateId }],
  });
  if (!planned.planned) throw new Error('Expected verification draft.');
  return {
    task,
    draft: planned.draft,
    candidates: [selectedCandidate],
    request: {
      schemaVersion: 1,
      draftId: planned.draft.draftId,
      requiredCheckId: 'check-test',
      candidateId: selectedCandidateId,
    },
  };
}

function registry<Result>(
  runner: VerificationCheckRegistration<Result>['run'],
): VerificationCheckRegistry<Result>;
function registry<Result>(runner: VerificationCheckRegistration<Result>['run']) {
  return new VerificationCheckRegistry([
    {
      id: 'check-test',
      evidenceKind: 'test',
      handlerVersion: '1.0.0',
      executionClass: 'trusted_deterministic',
      run: runner,
    },
  ]);
}

function defaultRegistry(): VerificationCheckRegistry<{ status: 'passed' }> {
  return registry(async () => ({ status: 'passed' as const }));
}

describe('verification issuance coordinator', () => {
  it('defaults to legacy without reading time, workspace, registry, or persistence', async () => {
    const now = vi.fn(() => '2026-08-02T12:05:00.000Z');
    const captureWorkspaceIdentity = vi.fn(async () => ({ manifestHash: workspaceManifestHash }));
    const bindingFor = vi.fn();
    const issueLease = vi.fn();
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'unexpected' as 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now,
      captureWorkspaceIdentity,
      checkBindings: { bindingFor },
      leaseIssuer: { issueVerificationExecutionLeaseIfCurrent: issueLease },
    });

    await expect(coordinator.issue(input())).resolves.toEqual({
      route: 'legacy',
      handled: false,
      reason: 'coordinator_disabled',
    });
    expect(now).not.toHaveBeenCalled();
    expect(captureWorkspaceIdentity).not.toHaveBeenCalled();
    expect(bindingFor).not.toHaveBeenCalled();
    expect(issueLease).not.toHaveBeenCalled();
  });

  it('derives binding internally and persists only the v2 run and lease', async () => {
    const store = openStore();
    const checks = defaultRegistry();
    const issueLease = vi.spyOn(store, 'issueVerificationExecutionLeaseIfCurrent');
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: checks,
      leaseIssuer: store,
    });
    const modelInput = input();
    const modelRequestWithBinding = {
      ...modelInput.request,
      checkBinding: { registryFingerprint: 'model-controlled' },
    } as typeof modelInput.request;

    const result = await coordinator.issue({ ...modelInput, request: modelRequestWithBinding });
    if (result.route !== 'governed' || !result.issued) {
      throw new Error('Expected issued verification capability.');
    }

    expect(result).toMatchObject({
      route: 'governed',
      handled: true,
      issued: true,
      run: {
        schemaVersion: 2,
        checkBinding: {
          registryFingerprint: checks.fingerprint(),
          checkId: 'check-test',
          handlerVersion: '1.0.0',
        },
      },
      credential: { secret: 's'.repeat(43) },
    });
    expect(issueLease).toHaveBeenCalledTimes(1);
    expect(issueLease.mock.calls[0]?.[0]).toMatchObject({ schemaVersion: 2 });
    expect(issueLease.mock.calls[0]?.[1]).toEqual({
      taskRevision: 7,
      activeContractVersion: 1,
      activePlanVersion: 1,
      activePlanFingerprint: calculatePlanVersionFingerprint(planVersion()),
      workflowState: 'proposed_complete',
      workspaceManifestHash,
      workspaceSnapshot: {
        schemaVersion: 1,
        snapshotId: workspaceSnapshotFenceId(
          'project-1',
          1,
          workspaceManifestHash,
          '2026-08-02T12:05:00.000Z',
        ),
        projectId: 'project-1',
        revision: 1,
        manifestHash: workspaceManifestHash,
        capturedAt: '2026-08-02T12:05:00.000Z',
      },
      candidateObservation: { sequence: 1, observationId: 'observation-1' },
    });
    expect(JSON.stringify(result)).not.toContain('model-controlled');
  });

  it('rejects a fresh workspace mismatch before lease persistence', async () => {
    const store = openStore();
    const issueLease = vi.spyOn(store, 'issueVerificationExecutionLeaseIfCurrent');
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: 'f'.repeat(64) }),
      checkBindings: defaultRegistry(),
      leaseIssuer: store,
    });

    await expect(coordinator.issue(input())).resolves.toEqual({
      route: 'governed',
      handled: true,
      issued: false,
      phase: 'workspace',
      code: 'workspace_mismatch',
      message: 'Fresh workspace identity does not match the verification run snapshot.',
    });
    expect(issueLease).not.toHaveBeenCalled();
  });

  it('rejects a caller-only candidate that is absent from the canonical ledger', async () => {
    const store = openStore();
    const issueLease = vi.spyOn(store, 'issueVerificationExecutionLeaseIfCurrent');
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: defaultRegistry(),
      leaseIssuer: store,
    });

    await expect(
      coordinator.issue(
        input({ ...candidate(), sequence: 999, observationId: 'caller-only-observation' }),
      ),
    ).resolves.toMatchObject({
      issued: false,
      phase: 'lease',
      code: 'canonical_candidate_missing',
    });
    expect(issueLease).toHaveBeenCalledTimes(1);
    const attemptedRun = issueLease.mock.calls[0]?.[0];
    if (!attemptedRun) throw new Error('Expected a conditional lease issuance attempt.');
    expect(
      store.readVerificationExecutionLeaseStatus(verificationExecutionLeaseId(attemptedRun.runId)),
    ).toEqual({
      state: 'missing',
      leaseId: verificationExecutionLeaseId(attemptedRun.runId),
    });
  });

  it('rejects a candidate reference that does not match the canonical observation', async () => {
    const store = openStore();
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: defaultRegistry(),
      leaseIssuer: store,
    });

    await expect(
      coordinator.issue(input({ ...candidate(), observationId: 'forged-observation-id' })),
    ).resolves.toMatchObject({
      issued: false,
      phase: 'lease',
      code: 'canonical_candidate_mismatch',
    });
  });

  it('rejects caller-supplied plan binding that differs from the canonical candidate', async () => {
    const store = openStore();
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: defaultRegistry(),
      leaseIssuer: store,
    });

    await expect(
      coordinator.issue(input({ ...candidate(), planFingerprint: 'd'.repeat(64) })),
    ).resolves.toMatchObject({
      issued: false,
      phase: 'lease',
      code: 'canonical_candidate_mismatch',
    });
  });

  it('rejects caller task state whose active plan content differs from canonical replay', async () => {
    const store = openStore();
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: defaultRegistry(),
      leaseIssuer: store,
    });
    const callerInput = input();
    if (!callerInput.task) throw new Error('Expected task fixture.');
    const tamperedTask: TaskAggregate = {
      ...callerInput.task,
      plans: callerInput.task.plans.map((plan) => ({
        ...plan,
        changeReason: 'Caller-mutated plan content.',
      })),
    };

    await expect(coordinator.issue({ ...callerInput, task: tamperedTask })).resolves.toMatchObject({
      issued: false,
      phase: 'lease',
      code: 'canonical_state_mismatch',
    });
  });

  it('recomputes canonical candidate eligibility inside the issuance transaction', async () => {
    const path = coordinatorDatabasePath();
    const store = openStoreAt(path, false);
    seedCanonicalTask(store);
    const forgedCandidateId = 'f'.repeat(64);
    const append = store.appendObservation({
      observationId: 'observation-1',
      projectId: 'project-1',
      taskId: 'task-1',
      source: 'executor-client',
      category: 'evidence_candidate',
      observedAt: '2026-08-02T12:00:00.000Z',
      payload: { ...evidencePayload, candidateId: forgedCandidateId },
    });
    if (!append.handled) throw new Error('Expected forged candidate fixture to be recorded.');
    const callerCandidate: GovernanceEvidenceCandidateLedgerEntry = {
      ...candidate(),
      candidateId: forgedCandidateId,
    };
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: defaultRegistry(),
      leaseIssuer: store,
    });

    await expect(coordinator.issue(input(callerCandidate))).resolves.toMatchObject({
      issued: false,
      phase: 'lease',
      code: 'canonical_candidate_invalid',
    });
  });

  it('atomically rejects issuance when another client advances canonical task state', async () => {
    const path = coordinatorDatabasePath();
    const issuerStore = openStoreAt(path, true);
    const competingStore = openStoreAt(path, false);
    const issueLease = vi.spyOn(issuerStore, 'issueVerificationExecutionLeaseIfCurrent');
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => {
        const advanced = competingStore.execute(
          {
            type: 'transition_task',
            commandId: 'competing-verifier-transition',
            taskId: 'task-1',
            expectedRevision: 7,
            actor: 'system',
            issuedAt: '2026-08-02T12:04:59.000Z',
            to: 'verifying',
          },
          decisionContext,
        );
        expect(advanced.handled && advanced.decision.accepted).toBe(true);
        return { manifestHash: workspaceManifestHash };
      },
      checkBindings: defaultRegistry(),
      leaseIssuer: issuerStore,
    });

    await expect(coordinator.issue(input())).resolves.toMatchObject({
      route: 'governed',
      handled: true,
      issued: false,
      phase: 'lease',
      code: 'canonical_state_mismatch',
    });
    expect(issueLease).toHaveBeenCalledTimes(1);
    const attemptedRun = issueLease.mock.calls[0]?.[0];
    if (!attemptedRun) throw new Error('Expected a conditional lease issuance attempt.');
    expect(
      issuerStore.readVerificationExecutionLeaseStatus(
        verificationExecutionLeaseId(attemptedRun.runId),
      ),
    ).toEqual({
      state: 'missing',
      leaseId: verificationExecutionLeaseId(attemptedRun.runId),
    });
    expect(issuerStore.readTask('task-1')).toMatchObject({ revision: 8, state: 'verifying' });
  });

  it('rejects issuance when another client advances the workspace snapshot revision', async () => {
    const path = coordinatorDatabasePath();
    const issuerStore = openStoreAt(path, true);
    const competingStore = openStoreAt(path, false);
    let attemptedRunId: string | undefined;
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: defaultRegistry(),
      workspaceSnapshots: issuerStore,
      leaseIssuer: {
        issueVerificationExecutionLeaseIfCurrent: (run, precondition) => {
          attemptedRunId = run.runId;
          const advanced = competingStore.recordWorkspaceSnapshot('project-1', 'f'.repeat(64));
          expect(advanced).toMatchObject({ recorded: true, snapshot: { revision: 2 } });
          return issuerStore.issueVerificationExecutionLeaseIfCurrent(run, precondition);
        },
      },
    });

    await expect(coordinator.issue(input())).resolves.toMatchObject({
      issued: false,
      phase: 'lease',
      code: 'workspace_snapshot_stale',
    });
    if (!attemptedRunId) throw new Error('Expected a conditional lease issuance attempt.');
    expect(
      issuerStore.readVerificationExecutionLeaseStatus(
        verificationExecutionLeaseId(attemptedRunId),
      ),
    ).toMatchObject({ state: 'missing' });
    expect(issuerStore.readLatestWorkspaceSnapshot('project-1')).toMatchObject({
      revision: 2,
      manifestHash: 'f'.repeat(64),
    });
  });

  it('does not consult registry or persist when canonical run preflight fails', async () => {
    const store = openStore();
    const bindingFor = vi.fn();
    const issueLease = vi.spyOn(store, 'issueVerificationExecutionLeaseIfCurrent');
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: { bindingFor },
      leaseIssuer: store,
    });
    const invalid = input();

    await expect(
      coordinator.issue({
        ...invalid,
        request: { ...invalid.request, candidateId: 'invalid' },
      }),
    ).resolves.toMatchObject({ issued: false, phase: 'run_contract' });
    expect(bindingFor).not.toHaveBeenCalled();
    expect(issueLease).not.toHaveBeenCalled();
  });

  it('does not persist when the canonical check is absent from the trusted registry', async () => {
    const store = openStore();
    const issueLease = vi.spyOn(store, 'issueVerificationExecutionLeaseIfCurrent');
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: new VerificationCheckRegistry([]),
      leaseIssuer: store,
    });

    await expect(coordinator.issue(input())).resolves.toMatchObject({
      issued: false,
      phase: 'check_registry',
      code: 'check_not_registered',
    });
    expect(issueLease).not.toHaveBeenCalled();
  });

  it('returns a bounded authority failure without touching registry or persistence', async () => {
    const bindingFor = vi.fn();
    const issueLease = vi.fn();
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => {
        throw new Error('sensitive clock failure');
      },
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: { bindingFor },
      leaseIssuer: { issueVerificationExecutionLeaseIfCurrent: issueLease },
    });

    await expect(coordinator.issue(input())).resolves.toEqual({
      route: 'governed',
      handled: true,
      issued: false,
      phase: 'authority',
      code: 'authority_unavailable',
      message: 'Trusted verification authority time is unavailable.',
    });
    expect(bindingFor).not.toHaveBeenCalled();
    expect(issueLease).not.toHaveBeenCalled();
  });

  it('fails closed when enforced issuance has no canonical workspace snapshot recorder', async () => {
    const issueLease = vi.fn();
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: defaultRegistry(),
      leaseIssuer: { issueVerificationExecutionLeaseIfCurrent: issueLease },
    });

    await expect(coordinator.issue(input())).resolves.toEqual({
      route: 'governed',
      handled: true,
      issued: false,
      phase: 'workspace',
      code: 'workspace_snapshot_unavailable',
      message: 'Canonical workspace snapshot recorder is unavailable.',
    });
    expect(issueLease).not.toHaveBeenCalled();
  });

  it('bounds registry and persistence exceptions without exposing their messages', async () => {
    const store = openStore();
    const registryFailure = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: {
        bindingFor: () => {
          throw new Error('sensitive registry details');
        },
      },
      leaseIssuer: store,
    });
    const leaseFailure = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: defaultRegistry(),
      workspaceSnapshots: store,
      leaseIssuer: {
        issueVerificationExecutionLeaseIfCurrent: () => {
          throw new Error('sensitive sqlite details');
        },
      },
    });

    const registryResult = await registryFailure.issue(input());
    const leaseResult = await leaseFailure.issue(input());
    expect(registryResult).toMatchObject({
      issued: false,
      phase: 'check_registry',
      code: 'check_registry_unavailable',
    });
    expect(leaseResult).toMatchObject({
      issued: false,
      phase: 'lease',
      code: 'lease_unavailable',
    });
    expect(JSON.stringify([registryResult, leaseResult])).not.toContain('sensitive');
  });

  it('delivers a secret once and reports deterministic replay without replacing it', async () => {
    const store = openStore();
    const checks = defaultRegistry();
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: checks,
      leaseIssuer: store,
    });

    await expect(coordinator.issue(input())).resolves.toMatchObject({ issued: true });
    await expect(coordinator.issue(input())).resolves.toMatchObject({
      issued: false,
      phase: 'lease',
      code: 'already_issued',
    });
  });

  it('hands the issued capability to the enforced gateway without a model-defined command', async () => {
    const store = openStore();
    const runner = vi.fn(async (context: { run: { requiredCheckId: string } }) => ({
      checkId: context.run.requiredCheckId,
    }));
    const checks = registry(runner);
    const coordinator = new VerificationIssuanceCoordinator({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      ttlMs: 60_000,
      maxDurationMs: 30_000,
      now: () => '2026-08-02T12:05:00.000Z',
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkBindings: checks,
      leaseIssuer: store,
    });
    const issued = await coordinator.issue(input());
    if (issued.route !== 'governed' || !issued.issued) {
      throw new Error('Expected issued verification capability.');
    }
    const gateway = new VerificationToolGateway({
      mode: 'enforced',
      verifierClientId: 'independent-verifier',
      leaseConsumer: store,
      captureWorkspaceIdentity: async () => ({ manifestHash: workspaceManifestHash }),
      checkRegistry: checks,
    });

    await expect(
      gateway.execute({
        schemaVersion: 1,
        credential: issued.credential,
        expected: {
          runId: issued.run.runId,
          taskId: issued.run.taskId,
          planFingerprint: issued.run.planFingerprint,
        },
      }),
    ).resolves.toMatchObject({
      route: 'governed',
      authorized: true,
      outcome: 'succeeded',
      result: { checkId: 'check-test' },
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
