/**
 * Regression: plan validation (the only enforcement point of a task contract's
 * deniedPaths) matched step paths against the scope by raw prefix. `.`/`..`
 * segments were never resolved, so `allowed/src/../secrets/key.pem` matched
 * `allowed/**`, missed `allowed/secrets/**`, and the plan was accepted — as was
 * a path climbing out of the repository entirely.
 */
import { describe, expect, it } from 'vitest';
import {
  PLAN_VERSION_SCHEMA_VERSION,
  type PlanVersionV1,
  TASK_CONTRACT_SCHEMA_VERSION,
  type TaskContractV1,
  validatePlanVersionV1,
} from '../src/index.js';

function contract(allowedPaths: string[], deniedPaths: string[]): TaskContractV1 {
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: 'task-1',
    contractVersion: 1,
    projectId: 'project-1',
    sourceRequest: 'Edit the governance package.',
    policyVersion: 'policy-1',
    repository: { rootIdentity: 'repo-hash', baselinePolicy: 'required' },
    requirements: [{ id: 'req-1', text: 'Implement.', acceptanceCriteriaIds: ['ac-1'] }],
    acceptanceCriteria: [{ id: 'ac-1', statement: 'Done.', evidenceKinds: ['test'] }],
    autonomy: {
      tier: 'A2',
      allowedOperations: ['repository_read', 'file_edit'],
      humanApprovalRequiredFor: [],
      allowedPaths,
      deniedPaths,
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
    requiredChecks: [],
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

function planTouching(expectedPath: string): PlanVersionV1 {
  return {
    schemaVersion: PLAN_VERSION_SCHEMA_VERSION,
    planId: 'plan-1',
    taskId: 'task-1',
    planVersion: 1,
    parentPlanVersion: null,
    contractVersion: 1,
    createdBy: 'model',
    createdAt: '2026-08-01T00:00:00.000Z',
    changeReason: 'Initial plan.',
    steps: [
      {
        id: 'implement',
        title: 'Implement',
        description: 'Edit a file.',
        operations: ['repository_read', 'file_edit'],
        expectedPaths: [expectedPath],
        requirementIds: ['req-1'],
        acceptanceCriteriaIds: ['ac-1'],
        requiredCheckIds: [],
      },
    ],
    edges: [],
  };
}

const scoped = contract(['packages/governance/**'], ['packages/governance/secrets/**']);
const valid = (expectedPath: string, scope = scoped) =>
  validatePlanVersionV1(planTouching(expectedPath), scope).valid;

describe('plan path scope with dot segments', () => {
  it.each([
    'packages/governance/src/../secrets/key.pem',
    'packages/governance/./secrets/key.pem',
    'packages/governance/src/../../core/src/x.ts',
    'packages/governance/src/../../../.ssh/id_rsa',
  ])('rejects %s', (expectedPath) => {
    expect(valid(expectedPath)).toBe(false);
  });

  it.each([
    'packages/governance/src/plan-version.ts',
    'packages/governance/src/./plan-version.ts',
    'packages/governance/src/sub/../plan-version.ts',
    './packages/governance/src/x.ts',
  ])('still accepts %s', (expectedPath) => {
    expect(valid(expectedPath)).toBe(true);
  });

  it('refuses a path above the repository root even under a ** scope', () => {
    const wide = contract(['**'], []);
    expect(valid('../../etc/passwd', wide)).toBe(false);
    expect(valid('a/../b.ts', wide)).toBe(true);
  });

  it.each([
    '/etc/passwd',
    '/',
    '\\',
    '/etc/..',
    '.',
    './',
    'src/..',
    'C:\\Windows\\System32\\x.dll',
    'C:/Users/u/.npmrc',
    '\\\\server\\share\\x',
  ])('refuses the absolute or root-resolving path %s even under a ** scope', (expectedPath) => {
    expect(valid(expectedPath, contract(['**'], []))).toBe(false);
  });

  it('normalizes allowedPaths and deniedPaths in validateTaskContractV1 and treats focused_check as read-only', async () => {
    const { validateTaskContractV1 } = await import('../src/index.js');
    const dotConflict = validateTaskContractV1(
      contract(['packages/governance/**'], ['packages/./governance/**']),
    );
    expect(dotConflict.valid).toBe(false);
    if (!dotConflict.valid) {
      expect(dotConflict.issues.some((i) => i.code === 'path_scope_conflict')).toBe(true);
    }

    const base = contract([], []);
    const readVerify = validateTaskContractV1({
      ...base,
      autonomy: {
        ...base.autonomy,
        tier: 'A1',
        allowedOperations: ['repository_read', 'focused_check'],
        allowedPaths: [],
        deniedPaths: [],
      },
    });
    expect(readVerify.valid).toBe(true);
  });

  it('restricts single-segment root wildcard * to root-level files without matching nested paths', () => {
    expect(valid('README.md', contract(['*'], []))).toBe(true);
    expect(valid('packages/governance/src/plan-version.ts', contract(['*'], []))).toBe(false);
    expect(valid('packages/governance/src/plan-version.ts', contract(['**'], ['*']))).toBe(true);
    expect(valid('README.md', contract(['**'], ['*']))).toBe(false);
  });

  it('rejects wildcard and denied-overlapping ancestor step expectedPaths and escaping/shadowed/blank task contracts (F39)', async () => {
    const { validateTaskContractV1 } = await import('../src/index.js');

    expect(
      valid(
        'packages/governance/src/**',
        contract(['packages/governance/**'], ['packages/governance/src/secrets/**']),
      ),
    ).toBe(false);
    expect(
      valid(
        'packages/governance/src',
        contract(['packages/governance/**'], ['packages/governance/src/secrets/**']),
      ),
    ).toBe(false);
    expect(
      valid(
        'packages/governance/src/secrets',
        contract(['packages/governance/**'], ['packages/governance/src/secrets/token.txt']),
      ),
    ).toBe(false);

    const escaping = validateTaskContractV1(contract(['../outside/**'], ['../secret/**']));
    expect(escaping.valid).toBe(false);

    const shadowed = validateTaskContractV1(
      contract(['packages/governance/src/secrets/key.ts'], ['packages/governance/src/secrets/**']),
    );
    expect(shadowed.valid).toBe(false);
    if (!shadowed.valid) {
      expect(shadowed.issues.some((i) => i.code === 'path_scope_conflict')).toBe(true);
    }

    const base = contract(['   '], ['']);
    const blankReadOnly = validateTaskContractV1({
      ...base,
      autonomy: {
        ...base.autonomy,
        tier: 'A1',
        allowedOperations: ['repository_read'],
      },
    });
    expect(blankReadOnly.valid).toBe(false);
  });
});
