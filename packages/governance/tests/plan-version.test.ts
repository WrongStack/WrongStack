import { describe, expect, it } from 'vitest';
import {
  calculatePlanVersionFingerprint,
  decideReplanAuthorization,
  freezePlanVersionV1,
  PLAN_VERSION_SCHEMA_VERSION,
  type PlanVersionV1,
  summarizePlanAutonomy,
  TASK_CONTRACT_SCHEMA_VERSION,
  type TaskContractV1,
  validatePlanSupersession,
  validatePlanVersionV1,
} from '../src/index.js';

function taskContract(overrides: Partial<TaskContractV1> = {}): TaskContractV1 {
  const value: TaskContractV1 = {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: 'task-1',
    contractVersion: 1,
    projectId: 'project-1',
    sourceRequest: 'Add a versioned plan without reducing bounded autonomy.',
    policyVersion: 'policy-1',
    repository: { rootIdentity: 'repo-hash', baselinePolicy: 'required' },
    requirements: [
      { id: 'req-1', text: 'Implement the change.', acceptanceCriteriaIds: ['ac-1'] },
      { id: 'req-2', text: 'Verify the change.', acceptanceCriteriaIds: ['ac-2'] },
    ],
    acceptanceCriteria: [
      { id: 'ac-1', statement: 'Implementation is complete.', evidenceKinds: ['test'] },
      { id: 'ac-2', statement: 'Required tests pass.', evidenceKinds: ['test'] },
    ],
    autonomy: {
      tier: 'A2',
      allowedOperations: ['repository_read', 'file_edit', 'focused_check', 'deploy'],
      humanApprovalRequiredFor: ['deploy'],
      allowedPaths: ['packages/governance/**'],
      deniedPaths: ['packages/governance/secrets/**'],
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
      { id: 'check-test', kind: 'test', required: true, requirementIds: ['req-1', 'req-2'] },
    ],
    requiredReviewDimensions: ['correctness', 'testing_evidence'],
    rollbackClass: 'git_revert',
    assumptions: [],
    sources: {
      requirements: 'explicit_user',
      scope: 'project_policy',
      checks: 'deterministic_inference',
      autonomy: 'project_policy',
    },
  };
  return { ...value, ...overrides };
}

function plan(overrides: Partial<PlanVersionV1> = {}): PlanVersionV1 {
  const value: PlanVersionV1 = {
    schemaVersion: PLAN_VERSION_SCHEMA_VERSION,
    planId: 'plan-1',
    taskId: 'task-1',
    planVersion: 1,
    parentPlanVersion: null,
    contractVersion: 1,
    createdBy: 'model',
    createdAt: '2026-08-01T00:00:00.000Z',
    changeReason: 'Initial model-generated plan.',
    steps: [
      {
        id: 'implement',
        title: 'Implement',
        description: 'Apply the bounded code changes.',
        operations: ['repository_read', 'file_edit'],
        expectedPaths: ['packages/governance/src/plan-version.ts'],
        requirementIds: ['req-1'],
        acceptanceCriteriaIds: ['ac-1'],
        requiredCheckIds: [],
      },
      {
        id: 'verify',
        title: 'Verify',
        description: 'Run the focused tests.',
        operations: ['focused_check'],
        expectedPaths: [],
        requirementIds: ['req-2'],
        acceptanceCriteriaIds: ['ac-2'],
        requiredCheckIds: ['check-test'],
      },
    ],
    edges: [{ fromStepId: 'implement', toStepId: 'verify' }],
  };
  return { ...value, ...overrides };
}

describe('PlanVersion v1', () => {
  it('calculates a deterministic content fingerprint', () => {
    const canonical = plan();
    const reordered = {
      edges: canonical.edges,
      steps: canonical.steps,
      changeReason: canonical.changeReason,
      createdAt: canonical.createdAt,
      createdBy: canonical.createdBy,
      contractVersion: canonical.contractVersion,
      parentPlanVersion: canonical.parentPlanVersion,
      planVersion: canonical.planVersion,
      taskId: canonical.taskId,
      planId: canonical.planId,
      schemaVersion: canonical.schemaVersion,
    } satisfies PlanVersionV1;

    expect(calculatePlanVersionFingerprint(canonical)).toMatch(/^[a-f0-9]{64}$/);
    expect(calculatePlanVersionFingerprint(reordered)).toBe(
      calculatePlanVersionFingerprint(canonical),
    );
    expect(calculatePlanVersionFingerprint({ ...canonical, changeReason: 'Changed.' })).not.toBe(
      calculatePlanVersionFingerprint(canonical),
    );
  });

  it('accepts an immutable, requirement-traceable DAG', () => {
    expect(validatePlanVersionV1(plan(), taskContract())).toEqual({ valid: true });
  });

  it('keeps ordinary implementation and verification steps fully autonomous', () => {
    expect(summarizePlanAutonomy(taskContract(), plan())).toMatchObject({
      fullyAutonomous: true,
      automaticStepIds: ['implement', 'verify'],
      humanApprovalStepIds: [],
    });
  });

  it('isolates a sensitive step without forcing human approval for the rest of the plan', () => {
    const base = plan();
    const deployStep = {
      id: 'deploy',
      title: 'Deploy',
      description: 'Deploy after verification.',
      operations: ['deploy'] as const,
      expectedPaths: ['packages/governance/src/plan-version.ts'],
      requirementIds: ['req-2'],
      acceptanceCriteriaIds: ['ac-2'],
      requiredCheckIds: ['check-test'],
    };
    const withDeploy = {
      ...base,
      steps: [...base.steps, deployStep],
      edges: [...base.edges, { fromStepId: 'verify', toStepId: 'deploy' }],
    };

    expect(validatePlanVersionV1(withDeploy, taskContract())).toEqual({ valid: true });
    expect(summarizePlanAutonomy(taskContract(), withDeploy)).toMatchObject({
      fullyAutonomous: false,
      automaticStepIds: ['implement', 'verify'],
      humanApprovalStepIds: ['deploy'],
    });
  });

  it('allows project policy to pre-authorize a narrow A4 step', () => {
    const contract = taskContract();
    const preAuthorized = taskContract({
      autonomy: {
        ...contract.autonomy,
        tier: 'A4',
        humanApprovalRequiredFor: [],
      },
    });
    const base = plan();
    const withDeploy = {
      ...base,
      steps: [
        ...base.steps,
        {
          ...base.steps[1]!,
          id: 'deploy',
          title: 'Deploy',
          operations: ['deploy'] as const,
        },
      ],
      edges: [...base.edges, { fromStepId: 'verify', toStepId: 'deploy' }],
    };

    expect(summarizePlanAutonomy(preAuthorized, withDeploy)).toMatchObject({
      fullyAutonomous: true,
      humanApprovalStepIds: [],
    });
  });

  it('rejects cycles, duplicate steps, self edges, and unknown edge endpoints', () => {
    const base = plan();
    const invalid = plan({
      steps: [...base.steps, base.steps[0]!],
      edges: [
        ...base.edges,
        { fromStepId: 'verify', toStepId: 'implement' },
        { fromStepId: 'verify', toStepId: 'verify' },
        { fromStepId: 'missing', toStepId: 'verify' },
      ],
    });
    const result = validatePlanVersionV1(invalid, taskContract());
    expect(result).toMatchObject({ valid: false });
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          'duplicate_step_id',
          'cycle_detected',
          'self_edge',
          'unknown_edge_step',
        ]),
      );
    }
  });

  it('rejects unplanned requirements and mandatory checks', () => {
    const base = plan();
    const incomplete = plan({ steps: [base.steps[0]!], edges: [] });
    const result = validatePlanVersionV1(incomplete, taskContract());
    expect(result).toMatchObject({ valid: false });
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(['requirement_unplanned', 'required_check_unplanned']),
      );
    }
  });

  it('rejects unknown traceability references and operations outside the contract', () => {
    const base = plan();
    const invalidStep = {
      ...base.steps[0]!,
      operations: ['package_install'] as const,
      requirementIds: ['missing-requirement'],
      acceptanceCriteriaIds: ['missing-criterion'],
      requiredCheckIds: ['missing-check'],
    };
    const result = validatePlanVersionV1(
      plan({ steps: [invalidStep, base.steps[1]!] }),
      taskContract(),
    );
    expect(result).toMatchObject({ valid: false });
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          'operation_not_allowed',
          'unknown_requirement',
          'unknown_acceptance_criterion',
          'unknown_required_check',
        ]),
      );
    }
  });

  it('rejects expected paths outside the contract scope or inside a denied path', () => {
    const base = plan();
    const outside = { ...base.steps[0]!, expectedPaths: ['packages/core/src/index.ts'] };
    const denied = {
      ...base.steps[1]!,
      operations: ['file_edit'] as const,
      expectedPaths: ['packages/governance/secrets/token.ts'],
    };
    const result = validatePlanVersionV1(plan({ steps: [outside, denied] }), taskContract());
    expect(result).toMatchObject({ valid: false });
    if (!result.valid) {
      expect(result.issues.filter((issue) => issue.code === 'path_outside_scope')).toHaveLength(2);
    }
  });

  it('requires sequential, parent-linked replans without mutating the previous version', () => {
    const previous = freezePlanVersionV1(plan());
    const next = freezePlanVersionV1(
      plan({
        planVersion: 2,
        parentPlanVersion: 1,
        changeReason: 'Model selected a better bounded implementation approach.',
      }),
    );

    expect(validatePlanSupersession(previous, next)).toEqual({ valid: true });
    expect(Object.isFrozen(previous)).toBe(true);
    expect(Object.isFrozen(previous.steps)).toBe(true);
    expect(previous.planVersion).toBe(1);
    expect(next.planVersion).toBe(2);
  });

  it('automatically authorizes a valid bounded replan without human intervention', () => {
    const previous = plan();
    const next = plan({
      planVersion: 2,
      parentPlanVersion: 1,
      changeReason: 'Model selected a better bounded approach after a failed attempt.',
    });
    expect(decideReplanAuthorization(taskContract(), previous, next, 0)).toEqual({
      valid: true,
      automatic: true,
      requiresHumanApproval: false,
      nextPlanVersion: 2,
    });
  });

  it('escalates only after the automatic replan budget is exhausted', () => {
    const previous = plan();
    const next = plan({
      planVersion: 2,
      parentPlanVersion: 1,
      changeReason: 'Another bounded approach.',
    });
    expect(decideReplanAuthorization(taskContract(), previous, next, 2)).toMatchObject({
      valid: true,
      automatic: false,
      requiresHumanApproval: true,
      reason: 'auto_replan_budget_exhausted',
    });
  });

  it('keeps sensitive steps isolated while allowing the replan itself to be automatic', () => {
    const previous = plan();
    const baseNext = plan({
      planVersion: 2,
      parentPlanVersion: 1,
      changeReason: 'Add a separately authorized deployment step.',
    });
    const next = {
      ...baseNext,
      steps: [
        ...baseNext.steps,
        {
          ...baseNext.steps[1]!,
          id: 'deploy',
          title: 'Deploy',
          operations: ['deploy'] as const,
          expectedPaths: ['packages/governance/src/plan-version.ts'],
        },
      ],
      edges: [...baseNext.edges, { fromStepId: 'verify', toStepId: 'deploy' }],
    };

    expect(decideReplanAuthorization(taskContract(), previous, next, 0)).toMatchObject({
      valid: true,
      automatic: true,
      requiresHumanApproval: false,
    });
    expect(summarizePlanAutonomy(taskContract(), next)).toMatchObject({
      fullyAutonomous: false,
      humanApprovalStepIds: ['deploy'],
    });
  });

  it('rejects skipped versions, wrong parents, identity changes, and contract regression', () => {
    const previous = plan({ planVersion: 2, parentPlanVersion: 1, contractVersion: 2 });
    const result = validatePlanSupersession(
      previous,
      plan({
        planId: 'other-plan',
        taskId: 'other-task',
        planVersion: 4,
        parentPlanVersion: 1,
        contractVersion: 1,
      }),
    );
    expect(result).toMatchObject({ valid: false });
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          'plan_id_mismatch',
          'task_id_mismatch',
          'version_not_sequential',
          'parent_version_mismatch',
          'contract_version_regressed',
        ]),
      );
    }
  });
});
