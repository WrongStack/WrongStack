import { describe, expect, it } from 'vitest';
import { DenyAllIntakeAuthorizer } from '../src/authorization.js';
import {
  IntakeAuthorizationError,
  IntakeConflictError,
  IntakeNotFoundError,
  IntakeStateTransitionError,
  IntakeStatusLockedError,
  IntakeSuggestionError,
  IntakeValidationError,
} from '../src/errors.js';
import type { IntakeContext } from '../src/types.js';
import { ALICE, BOB, CAROL, makeHarness, stubGenerator } from './helpers.js';

const CREATE_INPUT = {
  projectId: 'proj_alpha',
  originalRequest: 'Please add email-based password reset so users can recover access.',
  requestedBy: 'user-alice',
};

async function createDraft(harness: ReturnType<typeof makeHarness>, ctx: IntakeContext = ALICE) {
  return harness.service.createIntake(CREATE_INPUT, ctx);
}

describe('RequirementIntakeService — creation', () => {
  it('creates a draft intake record', async () => {
    const harness = makeHarness();
    const { record, created } = await createDraft(harness);
    expect(created).toBe(true);
    expect(record.id).toMatch(/^reqi_/);
    expect(record.projectId).toBe('proj_alpha');
    expect(record.status).toBe('draft');
    expect(record.requestType).toBe('unspecified');
    expect(record.version).toBe(1);
    expect(record.history.some((entry) => entry.action === 'created')).toBe(true);
  });

  it('preserves the exact original request', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    expect(record.originalRequest).toBe(CREATE_INPUT.originalRequest);
  });

  it('derives a deterministic title and summary when none provided', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    expect(record.title).toBe('Please add email-based password reset so users can recover access.');
    expect(record.normalizedSummary).toContain('email-based password reset');
    expect(record.fieldSources.title).toBe('deterministic');
    expect(record.fieldSources.normalized_summary).toBe('deterministic');
  });

  it('keeps user-provided title and marks its source as user', async () => {
    const harness = makeHarness();
    const { record } = await harness.service.createIntake(
      { ...CREATE_INPUT, title: 'Password reset', requestType: 'feature', priority: 'high' },
      ALICE,
    );
    expect(record.title).toBe('Password reset');
    expect(record.requestType).toBe('feature');
    expect(record.priority).toBe('high');
    expect(record.fieldSources.title).toBe('user');
    expect(record.fieldSources.request_type).toBe('user');
  });

  it('normalizes an unknown request type to other', async () => {
    const harness = makeHarness();
    const { record } = await harness.service.createIntake(
      { ...CREATE_INPUT, requestType: 'banana' },
      ALICE,
    );
    expect(record.requestType).toBe('other');
  });

  it('rejects create input for a different project than the context', async () => {
    const harness = makeHarness();
    await expect(
      harness.service.createIntake({ ...CREATE_INPUT, projectId: 'proj_beta' }, ALICE),
    ).rejects.toBeInstanceOf(IntakeAuthorizationError);
  });

  it('emits RequirementIntakeCreated with safe payload', async () => {
    const harness = makeHarness();
    await createDraft(harness);
    expect(harness.events).toHaveLength(1);
    const event = harness.events[0]!;
    expect(event.event).toBe('RequirementIntakeCreated');
    expect(event.intakeId).toMatch(/^reqi_/);
    expect(event.projectId).toBe('proj_alpha');
    expect(event.status).toBe('draft');
    expect(JSON.stringify(event)).not.toContain('email-based');
  });

  it('counts created intakes in metrics', async () => {
    const harness = makeHarness();
    await createDraft(harness);
    expect(harness.metrics.count('intake.created')).toBe(1);
  });

  it('is idempotent for the same idempotency key', async () => {
    const harness = makeHarness();
    const first = await harness.service.createIntake(
      { ...CREATE_INPUT, idempotencyKey: 'dup-key' },
      ALICE,
    );
    const second = await harness.service.createIntake(
      { ...CREATE_INPUT, idempotencyKey: 'dup-key' },
      ALICE,
    );
    expect(second.created).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(harness.metrics.count('intake.duplicate_create')).toBe(1);
    expect((await harness.service.listIntakes('proj_alpha', ALICE)).length).toBe(1);
  });

  it('rejects an idempotency key reused across projects', async () => {
    const harness = makeHarness();
    await harness.service.createIntake({ ...CREATE_INPUT, idempotencyKey: 'shared-key' }, ALICE);
    await expect(
      harness.service.createIntake(
        { ...CREATE_INPUT, projectId: 'proj_beta', idempotencyKey: 'shared-key' },
        CAROL,
      ),
    ).rejects.toBeInstanceOf(IntakeValidationError);
  });
});

describe('RequirementIntakeService — reads', () => {
  it('gets a record by id', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    const loaded = await harness.service.getIntake(record.id, ALICE);
    expect(loaded?.id).toBe(record.id);
  });

  it('returns null for a missing record', async () => {
    const harness = makeHarness();
    expect(await harness.service.getIntake('reqi_missing', ALICE)).toBeNull();
  });

  it('lists records for the project', async () => {
    const harness = makeHarness();
    await createDraft(harness);
    const records = await harness.service.listIntakes('proj_alpha', ALICE);
    expect(records).toHaveLength(1);
  });

  it('rejects listing another project', async () => {
    const harness = makeHarness();
    await expect(harness.service.listIntakes('proj_zeta', ALICE)).rejects.toBeInstanceOf(
      IntakeAuthorizationError,
    );
  });

  it('exposes pending questions', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    const pending = await harness.service.pendingQuestions(record.id, ALICE);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.some((question) => question.field === 'business_goal')).toBe(true);
  });
});

describe('RequirementIntakeService — updates', () => {
  it('updates a draft record and flips the field source to user', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    const updated = await harness.service.updateIntake(record.id, { title: 'User title' }, ALICE);
    expect(updated.title).toBe('User title');
    expect(updated.fieldSources.title).toBe('user');
    expect(updated.version).toBe(2);
  });

  it('preserves the original request after updates', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    await harness.service.updateIntake(record.id, { title: 'Changed', priority: 'medium' }, ALICE);
    const loaded = await harness.service.getIntake(record.id, ALICE);
    expect(loaded?.originalRequest).toBe(CREATE_INPUT.originalRequest);
  });

  it('rejects patches that try to touch the original request', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    await expect(
      harness.service.updateIntake(record.id, { originalRequest: 'overwrite' } as never, ALICE),
    ).rejects.toBeInstanceOf(IntakeValidationError);
  });

  it('rejects a blank title patch', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    await expect(
      harness.service.updateIntake(record.id, { title: '   ' }, ALICE),
    ).rejects.toBeInstanceOf(IntakeValidationError);
  });

  it('treats an empty patch as a no-op without bumping the version', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    const updated = await harness.service.updateIntake(record.id, {}, ALICE);
    expect(updated.version).toBe(1);
  });

  it('propagates optimistic-concurrency conflicts', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    await harness.service.updateIntake(record.id, { title: 'v2' }, ALICE, 1);
    await expect(
      harness.service.updateIntake(record.id, { title: 'stale' }, ALICE, 1),
    ).rejects.toBeInstanceOf(IntakeConflictError);
  });

  it('locks submitted records against modification', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    await harness.service.submitIntake(record.id, ALICE);
    await expect(
      harness.service.updateIntake(record.id, { title: 'late' }, ALICE),
    ).rejects.toBeInstanceOf(IntakeStatusLockedError);
  });

  it('throws IntakeNotFoundError for missing records', async () => {
    const harness = makeHarness();
    await expect(
      harness.service.updateIntake('reqi_nope', { title: 'x' }, ALICE),
    ).rejects.toBeInstanceOf(IntakeNotFoundError);
  });

  it('normalizes request type on update', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    const updated = await harness.service.updateIntake(
      record.id,
      { requestType: 'UI_CHANGE' },
      ALICE,
    );
    expect(updated.requestType).toBe('ui_change');
    expect(updated.fieldSources.request_type).toBe('user');
  });
});

describe('RequirementIntakeService — answers', () => {
  it('adds an answer and maps it onto the record field', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    const updated = await harness.service.addAnswer(
      record.id,
      { field: 'business_goal', answer: 'Reduce password reset support tickets' },
      ALICE,
    );
    expect(updated.businessGoal).toBe('Reduce password reset support tickets');
    expect(updated.answers).toHaveLength(1);
    expect(updated.answers[0]?.source).toBe('user');
    expect(updated.answers[0]?.answeredBy).toBe('user-alice');
    expect(updated.fieldSources.business_goal).toBe('user');
    const question = updated.questions.find((candidate) => candidate.field === 'business_goal');
    expect(question?.status).toBe('answered');
    expect(question?.answer).toBe('Reduce password reset support tickets');
  });

  it('rejects answers for unknown fields', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    await expect(
      harness.service.addAnswer(record.id, { field: 'nonsense', answer: 'x' }, ALICE),
    ).rejects.toBeInstanceOf(IntakeValidationError);
  });

  it('appends list answers for target users', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    const updated = await harness.service.addAnswer(
      record.id,
      { field: 'target_users', answer: 'All registered users' },
      ALICE,
    );
    expect(updated.targetUsers).toContain('All registered users');
  });

  it('updates an existing answer', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    const added = await harness.service.addAnswer(
      record.id,
      { field: 'business_goal', answer: 'First version' },
      ALICE,
    );
    const answerId = added.answers[0]!.id;
    const updated = await harness.service.updateAnswer(
      record.id,
      answerId,
      { answer: 'Second version' },
      ALICE,
    );
    expect(updated.answers[0]?.answer).toBe('Second version');
  });

  it('rejects answers on submitted records', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    await harness.service.submitIntake(record.id, ALICE);
    await expect(
      harness.service.addAnswer(record.id, { field: 'business_goal', answer: 'late' }, ALICE),
    ).rejects.toBeInstanceOf(IntakeStatusLockedError);
  });
});

describe('RequirementIntakeService — attachments & resources', () => {
  it('attaches a file descriptor', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    const updated = await harness.service.attachResource(
      record.id,
      { attachment: { name: 'mockup.png', kind: 'image', path: '/tmp/mockup.png' } },
      ALICE,
    );
    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachments[0]?.source).toBe('user');
    expect(updated.attachments[0]?.addedBy).toBe('user-alice');
    expect(updated.fieldSources.attachments).toBe('user');
  });

  it('attaches a related resource', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    const updated = await harness.service.attachResource(
      record.id,
      { relatedResource: { kind: 'issue', reference: 'GH-42' } },
      ALICE,
    );
    expect(updated.relatedResources).toHaveLength(1);
    expect(updated.relatedResources[0]?.kind).toBe('issue');
  });

  it('enforces the attachment count limit', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    for (let index = 0; index < 20; index += 1) {
      await harness.service.attachResource(
        record.id,
        { attachment: { name: `f${index}.txt`, kind: 'file', path: `/tmp/f${index}.txt` } },
        ALICE,
      );
    }
    await expect(
      harness.service.attachResource(
        record.id,
        { attachment: { name: 'overflow.txt', kind: 'file', path: '/tmp/overflow.txt' } },
        ALICE,
      ),
    ).rejects.toBeInstanceOf(IntakeValidationError);
  });
});

describe('RequirementIntakeService — LLM suggestions', () => {
  it('fails when no generator is configured', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    await expect(harness.service.generateSuggestions(record.id, ALICE)).rejects.toBeInstanceOf(
      IntakeSuggestionError,
    );
  });

  it('surfaces generator failures as suggestion errors and counts them', async () => {
    const harness = makeHarness({ generator: stubGenerator(new Error('provider down')) });
    const { record } = await createDraft(harness);
    await expect(harness.service.generateSuggestions(record.id, ALICE)).rejects.toBeInstanceOf(
      IntakeSuggestionError,
    );
    expect(harness.metrics.count('intake.suggestions.failed')).toBe(1);
  });

  it('rejects malformed LLM output', async () => {
    const harness = makeHarness({ generator: stubGenerator({ suggested_title: 42 } as never) });
    const { record } = await createDraft(harness);
    await expect(harness.service.generateSuggestions(record.id, ALICE)).rejects.toBeInstanceOf(
      IntakeSuggestionError,
    );
    expect(harness.metrics.count('intake.suggestions.failed')).toBe(1);
  });

  it('stores valid suggestions as pending proposals and moves to collecting_information', async () => {
    const harness = makeHarness({
      generator: stubGenerator({
        suggested_title: 'Add email-based password reset',
        suggested_request_type: 'feature',
        suggested_questions: [{ field: 'target_users', question: 'Which users?' }],
      }),
    });
    const { record } = await createDraft(harness);
    const proposals = await harness.service.generateSuggestions(record.id, ALICE);
    expect(proposals.length).toBe(3);
    expect(proposals.every((proposal) => proposal.status === 'pending')).toBe(true);

    const loaded = await harness.service.getIntake(record.id, ALICE);
    expect(loaded?.status).toBe('collecting_information');
    expect(loaded?.llmSuggestions).toHaveLength(3);
    expect(harness.metrics.count('intake.suggestions.succeeded')).toBe(1);
    const infoEvent = harness.events.find(
      (event) => event.event === 'RequirementIntakeInformationRequested',
    );
    expect(infoEvent?.previousStatus).toBe('draft');
    expect(infoEvent?.status).toBe('collecting_information');
  });

  it('accepting a title suggestion applies it with source llm without touching the original', async () => {
    const harness = makeHarness({
      generator: stubGenerator({ suggested_title: 'LLM title' }),
    });
    const { record } = await createDraft(harness);
    const [proposal] = await harness.service.generateSuggestions(record.id, ALICE);
    const updated = await harness.service.acceptSuggestion(record.id, proposal!.id, ALICE);
    expect(updated.title).toBe('LLM title');
    expect(updated.fieldSources.title).toBe('llm');
    expect(updated.originalRequest).toBe(CREATE_INPUT.originalRequest);
    const resolved = updated.llmSuggestions.find((candidate) => candidate.id === proposal!.id);
    expect(resolved?.status).toBe('accepted');
    expect(resolved?.resolvedAt).toBeDefined();
  });

  it('accepting a request-type suggestion normalizes it', async () => {
    const harness = makeHarness({
      generator: stubGenerator({ suggested_request_type: 'security' }),
    });
    const { record } = await createDraft(harness);
    const [proposal] = await harness.service.generateSuggestions(record.id, ALICE);
    const updated = await harness.service.acceptSuggestion(record.id, proposal!.id, ALICE);
    expect(updated.requestType).toBe('security');
    expect(updated.fieldSources.request_type).toBe('llm');
  });

  it('rejecting a suggestion marks it rejected', async () => {
    const harness = makeHarness({ generator: stubGenerator({ suggested_title: 'Nope' }) });
    const { record } = await createDraft(harness);
    const [proposal] = await harness.service.generateSuggestions(record.id, ALICE);
    const updated = await harness.service.rejectSuggestion(record.id, proposal!.id, ALICE);
    const resolved = updated.llmSuggestions.find((candidate) => candidate.id === proposal!.id);
    expect(resolved?.status).toBe('rejected');
    expect(updated.title).not.toBe('Nope');
  });

  it('rejects accepting an already-resolved suggestion', async () => {
    const harness = makeHarness({ generator: stubGenerator({ suggested_title: 'Once' }) });
    const { record } = await createDraft(harness);
    const [proposal] = await harness.service.generateSuggestions(record.id, ALICE);
    await harness.service.rejectSuggestion(record.id, proposal!.id, ALICE);
    await expect(
      harness.service.acceptSuggestion(record.id, proposal!.id, ALICE),
    ).rejects.toBeInstanceOf(IntakeValidationError);
  });
});

describe('RequirementIntakeService — lifecycle', () => {
  it('submits a draft and records authorization info', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    const { record: submitted, idempotent } = await harness.service.submitIntake(record.id, ALICE);
    expect(idempotent).toBe(false);
    expect(submitted.status).toBe('submitted');
    expect(submitted.submittedBy).toBe('user-alice');
    expect(submitted.submittedByType).toBe('user');
    expect(submitted.submittedAt).toBeDefined();
    expect(submitted.history.some((entry) => entry.action === 'submitted')).toBe(true);
    expect(harness.metrics.count('intake.submitted')).toBe(1);
    expect(harness.metrics.durationSum('intake.time_to_submit')).toBeDefined();
    const event = harness.events.find(
      (candidate) => candidate.event === 'RequirementIntakeSubmitted',
    );
    expect(event?.previousStatus).toBe('draft');
    expect(event?.status).toBe('submitted');
  });

  it('handles duplicate submissions idempotently', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    await harness.service.submitIntake(record.id, ALICE);
    const second = await harness.service.submitIntake(record.id, BOB);
    expect(second.idempotent).toBe(true);
    expect(second.record.status).toBe('submitted');
    expect(second.record.submittedBy).toBe('user-alice');
    expect(harness.metrics.count('intake.duplicate_submit')).toBe(1);
  });

  it('submits from collecting_information too', async () => {
    const harness = makeHarness({ generator: stubGenerator({ suggested_title: 'x' }) });
    const { record } = await createDraft(harness);
    await harness.service.generateSuggestions(record.id, ALICE);
    const { record: submitted } = await harness.service.submitIntake(record.id, ALICE);
    expect(submitted.status).toBe('submitted');
  });

  it('cancels a draft', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    const cancelled = await harness.service.cancelIntake(record.id, ALICE, 'no longer needed');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledReason).toBe('no longer needed');
    expect(cancelled.cancelledAt).toBeDefined();
    expect(harness.metrics.count('intake.cancelled')).toBe(1);
  });

  it('rejects cancelling a submitted record', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    await harness.service.submitIntake(record.id, ALICE);
    await expect(harness.service.cancelIntake(record.id, ALICE)).rejects.toBeInstanceOf(
      IntakeStateTransitionError,
    );
  });

  it('archives submitted records', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    await harness.service.submitIntake(record.id, ALICE);
    const archived = await harness.service.archiveIntake(record.id, ALICE);
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).toBeDefined();
    expect(harness.metrics.count('intake.archived')).toBe(1);
  });

  it('archives cancelled records', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    await harness.service.cancelIntake(record.id, ALICE);
    const archived = await harness.service.archiveIntake(record.id, ALICE);
    expect(archived.status).toBe('archived');
  });

  it('rejects archiving a draft', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    await expect(harness.service.archiveIntake(record.id, ALICE)).rejects.toBeInstanceOf(
      IntakeStateTransitionError,
    );
  });

  it('rejects submitting an archived record', async () => {
    const harness = makeHarness();
    const { record } = await createDraft(harness);
    await harness.service.submitIntake(record.id, ALICE);
    await harness.service.archiveIntake(record.id, ALICE);
    await expect(harness.service.submitIntake(record.id, ALICE)).rejects.toBeInstanceOf(
      IntakeStateTransitionError,
    );
  });

  it('filters listing by status', async () => {
    const harness = makeHarness();
    await createDraft(harness);
    const second = await createDraft(harness);
    await harness.service.submitIntake(second.record.id, ALICE);
    const drafts = await harness.service.listIntakes('proj_alpha', ALICE, { statuses: ['draft'] });
    expect(drafts).toHaveLength(1);
  });
});

describe('RequirementIntakeService — authorization', () => {
  it('denies every operation with a DenyAll authorizer', async () => {
    const harness = makeHarness({ authorizer: new DenyAllIntakeAuthorizer() });
    await expect(harness.service.createIntake(CREATE_INPUT, ALICE)).rejects.toBeInstanceOf(
      IntakeAuthorizationError,
    );
    await expect(harness.service.listIntakes('proj_alpha', ALICE)).rejects.toBeInstanceOf(
      IntakeAuthorizationError,
    );
    expect(harness.metrics.count('intake.unauthorized_attempt')).toBeGreaterThan(0);
  });
});
