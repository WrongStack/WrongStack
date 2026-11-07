import { describe, expect, it } from 'vitest';
import {
  applyAnswerToRecord,
  applyAnswerUpdateToRecord,
  buildNewIntakeRecord,
} from '../src/service-helpers.js';
import type { IntakeContext } from '../src/types.js';

describe('Requirement intake answer fieldSources canonical mapping', () => {
  it('maps alias fields to canonical fieldSources keys and preserves priority source on invalid priority answers', () => {
    const ctx: IntakeContext = {
      id: 'user-1',
      type: 'user',
      projectId: 'proj-1',
    };

    const record = buildNewIntakeRecord(
      {
        projectId: 'proj-1',
        originalRequest: 'Add SSO login support for enterprise tenants',
        requestedBy: 'user-1',
      },
      ctx,
      1_000,
      [],
    );

    const compAns = applyAnswerToRecord(
      record,
      { field: 'project_component', answer: 'packages/requirement-intake' },
      'user-1',
      2_000,
    );
    const scopeAns = applyAnswerToRecord(
      record,
      { field: 'description_scope', answer: 'service-helpers.ts' },
      'user-1',
      2_100,
    );

    expect(record.fieldSources.provided_context).toBe('user');
    expect(record.fieldSources.scope_notes).toBe('user');
    expect('project_component' in record.fieldSources).toBe(false);
    expect('description_scope' in record.fieldSources).toBe(false);

    const prioAns = applyAnswerToRecord(
      record,
      { field: 'priority', answer: 'needs-triage' },
      'user-1',
      2_200,
    );
    expect(record.priority).toBe('unspecified');
    expect(record.fieldSources.priority).toBe('deterministic');

    applyAnswerUpdateToRecord(record, prioAns.id, 'HIGH');
    expect(record.priority).toBe('high');
    expect(record.fieldSources.priority).toBe('user');

    applyAnswerUpdateToRecord(record, compAns.id, 'packages/requirement-intake\npackages/core');
    applyAnswerUpdateToRecord(record, scopeAns.id, 'Updated scope');
    expect('project_component' in record.fieldSources).toBe(false);
    expect('description_scope' in record.fieldSources).toBe(false);
  });

  it('ignores undefined patch properties in updateIntake so unchanged fields are not recorded as user-modified (F160)', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { AllowAllIntakeAuthorizer } = await import('../src/authorization.js');
    const { RequirementIntakeService } = await import('../src/service.js');
    const { RequirementIntakeStore } = await import('../src/store.js');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-f160-'));
    try {
      const service = new RequirementIntakeService({
        store: new RequirementIntakeStore({ baseDir: tmpDir }),
        authorizer: new AllowAllIntakeAuthorizer(),
      });
      const ctx: IntakeContext = {
        id: 'user-1',
        type: 'user',
        projectId: 'proj-1',
      };
      const { record: created } = await service.createIntake(
        {
          projectId: 'proj-1',
          originalRequest: 'Add SSO login support for enterprise tenants',
          requestedBy: 'user-1',
        },
        ctx,
      );
      const updated = await service.updateIntake(
        created.id,
        {
          title: undefined,
          priority: undefined,
        },
        ctx,
      );

      expect(updated.version).toBe(created.version);
      expect(updated.fieldSources.title).toBe('deterministic');
      expect(updated.fieldSources.priority).toBe('deterministic');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reopens questions and clears fieldSources when fields are cleared in updateIntake, keeps priority pending on unspecified answers, and preserves latest scalar answers on older edits (F55)', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { AllowAllIntakeAuthorizer } = await import('../src/authorization.js');
    const { RequirementIntakeService } = await import('../src/service.js');
    const { RequirementIntakeStore } = await import('../src/store.js');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-f55-'));
    try {
      const service = new RequirementIntakeService({
        store: new RequirementIntakeStore({ baseDir: tmpDir }),
        authorizer: new AllowAllIntakeAuthorizer(),
      });
      const ctx: IntakeContext = {
        id: 'user-1',
        type: 'user',
        projectId: 'proj-1',
      };
      const { record: created } = await service.createIntake(
        {
          projectId: 'proj-1',
          originalRequest: 'Add audit trail export for compliance reports.',
          requestedBy: 'user-1',
        },
        ctx,
      );
      await service.updateIntake(
        created.id,
        {
          businessGoal: 'Satisfy SOC2 audit export requirements',
          targetUsers: ['compliance-officers'],
          priority: 'high',
        },
        ctx,
      );

      const cleared = await service.updateIntake(
        created.id,
        {
          businessGoal: '',
          targetUsers: [],
          priority: 'unspecified',
        },
        ctx,
      );
      const pendingFields = (await service.pendingQuestions(created.id, ctx)).map((q) => q.field);
      expect(pendingFields).toContain('business_goal');
      expect(pendingFields).toContain('target_users');
      expect(pendingFields).toContain('priority');
      expect(cleared.fieldSources.business_goal).toBeUndefined();
      expect(cleared.fieldSources.target_users).toBeUndefined();

      const afterUnspecifiedPriority = await service.addAnswer(
        created.id,
        { field: 'priority', answer: 'unspecified' },
        ctx,
      );
      expect(afterUnspecifiedPriority.questions.find((q) => q.field === 'priority')?.status).toBe(
        'unanswered',
      );

      const withAns1 = await service.addAnswer(
        created.id,
        { field: 'expected_outcome', answer: 'First draft outcome' },
        ctx,
      );
      const ans1Id = withAns1.answers[withAns1.answers.length - 1]!.id;
      await service.addAnswer(
        created.id,
        { field: 'expected_outcome', answer: 'Final authoritative outcome' },
        ctx,
      );
      const afterEditOlder = await service.updateAnswer(
        created.id,
        ans1Id,
        { answer: 'Edited first draft outcome' },
        ctx,
      );
      expect(afterEditOlder.expectedOutcome).toBe('Final authoritative outcome');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('enforces explicit expectedVersion on submitIntake when record is already submitted (F56)', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { AllowAllIntakeAuthorizer } = await import('../src/authorization.js');
    const { IntakeConflictError } = await import('../src/errors.js');
    const { RequirementIntakeService } = await import('../src/service.js');
    const { RequirementIntakeStore } = await import('../src/store.js');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-f56-'));
    try {
      const service = new RequirementIntakeService({
        store: new RequirementIntakeStore({ baseDir: tmpDir }),
        authorizer: new AllowAllIntakeAuthorizer(),
      });
      const ctx: IntakeContext = {
        id: 'user-1',
        type: 'user',
        projectId: 'proj-1',
      };
      const { record: created } = await service.createIntake(
        {
          projectId: 'proj-1',
          originalRequest: 'Initial request before scope change.',
          requestedBy: 'user-1',
        },
        ctx,
      );
      await service.updateIntake(created.id, { scopeNotes: 'Expanded scope' }, ctx); // v2
      const submitted = await service.submitIntake(created.id, ctx, 2); // v3

      await expect(service.submitIntake(created.id, ctx, 2)).resolves.toMatchObject({
        idempotent: true,
      });
      await expect(
        service.submitIntake(created.id, ctx, submitted.record.version),
      ).resolves.toMatchObject({
        idempotent: true,
      });
      await expect(service.submitIntake(created.id, ctx, 1)).rejects.toBeInstanceOf(
        IntakeConflictError,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
