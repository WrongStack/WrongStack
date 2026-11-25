import { describe, expect, it } from 'vitest';
import { type PlanVersionV1, validatePlanVersionV1 } from '../src/plan-version.js';
import { type TaskContractV1, validateTaskContractV1 } from '../src/task-contract.js';

const baseContract = (allowedPaths: string[], deniedPaths: string[] = []): TaskContractV1 => ({
  schemaVersion: 1,
  taskId: 'task-1',
  contractVersion: 1,
  projectId: 'proj-1',
  sourceRequest: 'Update app',
  policyVersion: '1',
  repository: { rootIdentity: 'repo-1', baselinePolicy: 'optional' },
  requirements: [{ id: 'req-1', text: 'Do work', acceptanceCriteriaIds: ['ac-1'] }],
  acceptanceCriteria: [{ id: 'ac-1', statement: 'Passes tests', evidenceKinds: ['test'] }],
  autonomy: {
    tier: 'A1',
    allowedOperations: ['file_edit', 'focused_check'],
    humanApprovalRequiredFor: [],
    allowedPaths,
    deniedPaths,
    budget: {
      maxChangedFiles: 10,
      maxChangedLines: 100,
      maxNewDependencies: 0,
      maxRetries: 2,
      maxReplans: 1,
      maxSubagents: 0,
      maxWallClockMs: 60_000,
    },
    autoAuthorizePlan: true,
    autoReplanLimit: 1,
    autoResolveReviewFixes: false,
  },
  requiredChecks: [{ id: 'chk-1', kind: 'test', required: true, requirementIds: ['req-1'] }],
  requiredReviewDimensions: ['correctness'],
  rollbackClass: 'git_revert',
  assumptions: [],
  sources: {
    requirements: 'explicit_user',
    scope: 'explicit_user',
    checks: 'explicit_user',
    autonomy: 'project_policy',
  },
});

describe('Governance path NUL-byte rejection (F1838, F1839)', () => {
  it('rejects NUL bytes in plan expectedPaths and contract allowedPaths/deniedPaths', () => {
    const contract = baseContract(['**'], ['secrets/key.pem']);
    const plan: PlanVersionV1 = {
      schemaVersion: 1,
      planId: 'plan-1',
      taskId: 'task-1',
      planVersion: 1,
      parentPlanVersion: null,
      contractVersion: 1,
      createdBy: 'model',
      createdAt: new Date().toISOString(),
      changeReason: 'initial',
      steps: [
        {
          id: 'step-1',
          title: 'Edit file',
          description: 'Edit target file',
          operations: ['file_edit'],
          expectedPaths: ['secrets/key.pem\0.ts'],
          requirementIds: ['req-1'],
          acceptanceCriteriaIds: ['ac-1'],
          requiredCheckIds: ['chk-1'],
        },
      ],
      edges: [],
    };

    expect(validatePlanVersionV1(plan, contract).valid).toBe(false);
    expect(validateTaskContractV1(baseContract(['src/app.ts\0.txt'])).valid).toBe(false);
    expect(validateTaskContractV1(baseContract(['src/**'], ['secrets/key\0.pem'])).valid).toBe(
      false,
    );
  });
});
