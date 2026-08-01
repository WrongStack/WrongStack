import { describe, expect, it } from 'vitest';
import {
  decideOperationAutonomy,
  TASK_CONTRACT_SCHEMA_VERSION,
  type TaskContractV1,
  validateTaskContractV1,
} from '../src/index.js';

function contract(): TaskContractV1 {
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: 'task-1',
    contractVersion: 1,
    projectId: 'project-1',
    sourceRequest: 'Add deterministic governance without reducing model autonomy.',
    policyVersion: 'policy-1',
    repository: {
      rootIdentity: 'repo-hash',
      baselinePolicy: 'required',
    },
    requirements: [
      {
        id: 'req-1',
        text: 'Keep A1 and A2 work autonomous.',
        acceptanceCriteriaIds: ['ac-1'],
      },
    ],
    acceptanceCriteria: [
      {
        id: 'ac-1',
        statement: 'The model can edit and verify inside the approved envelope.',
        evidenceKinds: ['test'],
      },
    ],
    autonomy: {
      tier: 'A2',
      allowedOperations: [
        'repository_read',
        'file_edit',
        'focused_check',
        'shell_restricted',
        'subagent_spawn',
        'git_local_write',
        'deploy',
      ],
      humanApprovalRequiredFor: ['deploy'],
      allowedPaths: ['packages/governance/**'],
      deniedPaths: ['.env'],
      budget: {
        maxChangedFiles: 12,
        maxChangedLines: 1_000,
        maxNewDependencies: 0,
        maxRetries: 3,
        maxReplans: 2,
        maxSubagents: 3,
        maxWallClockMs: 900_000,
      },
      autoAuthorizePlan: true,
      autoReplanLimit: 2,
      autoResolveReviewFixes: true,
    },
    requiredChecks: [
      {
        id: 'check-1',
        kind: 'test',
        required: true,
        requirementIds: ['req-1'],
      },
    ],
    requiredReviewDimensions: ['correctness', 'testing_evidence'],
    rollbackClass: 'git_revert',
    assumptions: [
      {
        id: 'assumption-1',
        statement: 'The package remains disconnected from runtime.',
        source: 'deterministic_inference',
        status: 'verified',
      },
    ],
    sources: {
      requirements: 'explicit_user',
      scope: 'project_policy',
      checks: 'deterministic_inference',
      autonomy: 'project_policy',
    },
  };
}

describe('TaskContract v1', () => {
  it('accepts a versioned contract with bounded autonomous work and explicit deployment escalation', () => {
    expect(validateTaskContractV1(contract())).toEqual({ valid: true });
  });

  it('keeps A1/A2 implementation and verification human-free', () => {
    const autonomy = contract().autonomy;
    expect(decideOperationAutonomy(autonomy, 'file_edit')).toMatchObject({
      allowed: true,
      requiresHumanApproval: false,
    });
    expect(decideOperationAutonomy(autonomy, 'focused_check')).toMatchObject({
      allowed: true,
      requiresHumanApproval: false,
    });
    expect(decideOperationAutonomy(autonomy, 'subagent_spawn')).toMatchObject({
      allowed: true,
      requiresHumanApproval: false,
    });
  });

  it('escalates an explicitly sensitive operation without blocking ordinary work', () => {
    expect(decideOperationAutonomy(contract().autonomy, 'deploy')).toMatchObject({
      allowed: false,
      requiresHumanApproval: true,
      reason: 'explicit_approval_required',
    });
  });

  it('supports narrowly pre-authorized A4 automation', () => {
    const base = contract();
    const envelope = {
      ...base.autonomy,
      tier: 'A4' as const,
      humanApprovalRequiredFor: [],
    };
    expect(decideOperationAutonomy(envelope, 'deploy')).toMatchObject({
      allowed: true,
      requiresHumanApproval: false,
    });
  });

  it('rejects automatic operations above the declared tier unless they explicitly escalate', () => {
    const base = contract();
    const result = validateTaskContractV1({
      ...base,
      autonomy: { ...base.autonomy, humanApprovalRequiredFor: [] },
    });
    expect(result).toMatchObject({ valid: false });
    if (!result.valid) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'operation_exceeds_tier' }),
      );
    }
  });

  it('rejects dangling criterion and requirement references', () => {
    const base = contract();
    const result = validateTaskContractV1({
      ...base,
      requirements: [{ ...base.requirements[0]!, acceptanceCriteriaIds: ['missing-ac'] }],
      requiredChecks: [{ ...base.requiredChecks[0]!, requirementIds: ['missing-req'] }],
    });
    expect(result).toMatchObject({ valid: false });
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(['unknown_acceptance_criterion', 'unknown_requirement']),
      );
    }
  });

  it('rejects duplicate identities and conflicting path scope', () => {
    const base = contract();
    const result = validateTaskContractV1({
      ...base,
      requirements: [base.requirements[0]!, base.requirements[0]!],
      autonomy: {
        ...base.autonomy,
        deniedPaths: ['packages/governance/**'],
      },
    });
    expect(result).toMatchObject({ valid: false });
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(['duplicate_id', 'path_scope_conflict']),
      );
    }
  });

  it('rejects invalid budgets and auto-replan expansion', () => {
    const base = contract();
    const result = validateTaskContractV1({
      ...base,
      autonomy: {
        ...base.autonomy,
        autoReplanLimit: 3,
        budget: { ...base.autonomy.budget, maxRetries: -1, maxReplans: 2 },
      },
    });
    expect(result).toMatchObject({ valid: false });
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(['invalid_budget', 'auto_replan_exceeds_budget']),
      );
    }
  });

  it('requires explicit path scope for mutating autonomy', () => {
    const base = contract();
    const result = validateTaskContractV1({
      ...base,
      autonomy: { ...base.autonomy, allowedPaths: [] },
    });
    expect(result).toMatchObject({ valid: false });
    if (!result.valid) {
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'path_scope_missing' }));
    }
  });
});
