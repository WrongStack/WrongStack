import { describe, expect, it } from 'vitest';
import { IntakeStatusLockedError } from '../src/errors.js';
import { RequirementIntakeStore } from '../src/store.js';
import { ALICE, BOB, makeHarness, stubGenerator } from './helpers.js';

describe('integration — end-to-end intake workflow', () => {
  it('creates, answers, attaches, suggests, accepts, and submits', async () => {
    const harness = makeHarness({
      generator: stubGenerator({
        suggested_title: 'Email-based password reset',
        normalized_summary: 'Let users reset forgotten passwords via email link.',
        suggested_request_type: 'feature',
        extracted_constraints: ['Rate-limit reset emails'],
        suggested_questions: [{ field: 'constraints', question: 'Any additional constraints?' }],
      }),
    });

    // 1. Create
    const { record, created } = await harness.service.createIntake(
      {
        projectId: 'proj_alpha',
        originalRequest: 'Please add email-based password reset so users can recover access.',
        requestedBy: 'user-alice',
      },
      ALICE,
    );
    expect(created).toBe(true);
    expect(record.status).toBe('draft');

    // 2. Collect answers for missing fields
    const withGoal = await harness.service.addAnswer(
      record.id,
      { field: 'business_goal', answer: 'Reduce password reset support tickets' },
      ALICE,
    );
    expect(withGoal.businessGoal).toBe('Reduce password reset support tickets');

    // 3. Attach a supporting resource
    const withAttachment = await harness.service.attachResource(
      record.id,
      { attachment: { name: 'flow.png', kind: 'image', path: '/tmp/flow.png' } },
      ALICE,
    );
    expect(withAttachment.attachments).toHaveLength(1);

    // 4. Generate LLM suggestions
    const proposals = await harness.service.generateSuggestions(record.id, ALICE);
    expect(proposals.length).toBeGreaterThan(0);
    const titleProposal = proposals.find((proposal) => proposal.kind === 'title');
    const typeProposal = proposals.find((proposal) => proposal.kind === 'request_type');
    const constraintProposal = proposals.find((proposal) => proposal.kind === 'constraint');
    expect(titleProposal).toBeDefined();

    // 5. Accept a subset of suggestions, reject another
    const accepted = await harness.service.acceptSuggestion(record.id, titleProposal!.id, ALICE);
    expect(accepted.title).toBe('Email-based password reset');
    expect(accepted.fieldSources.title).toBe('llm');
    const withType = await harness.service.acceptSuggestion(record.id, typeProposal!.id, ALICE);
    expect(withType.requestType).toBe('feature');
    await harness.service.rejectSuggestion(record.id, constraintProposal!.id, ALICE);

    // 6. Submit
    const { record: submitted, idempotent } = await harness.service.submitIntake(record.id, ALICE);
    expect(idempotent).toBe(false);
    expect(submitted.status).toBe('submitted');
    expect(submitted.originalRequest).toBe(
      'Please add email-based password reset so users can recover access.',
    );

    // 7. The record is now locked
    await expect(
      harness.service.addAnswer(record.id, { field: 'target_users', answer: 'late' }, ALICE),
    ).rejects.toBeInstanceOf(IntakeStatusLockedError);

    // 8. Listing reflects the submitted record
    const listed = await harness.service.listIntakes('proj_alpha', ALICE, {
      statuses: ['submitted'],
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(record.id);
  });
});

describe('integration — persistence across instances', () => {
  it('survives store re-instantiation on the same directory', async () => {
    const harness = makeHarness();
    const { record } = await harness.service.createIntake(
      {
        projectId: 'proj_alpha',
        originalRequest: 'Persist me',
        requestedBy: 'user-alice',
        idempotencyKey: 'persist-key',
      },
      ALICE,
    );
    await harness.service.submitIntake(record.id, ALICE);

    const secondStore = new RequirementIntakeStore({ baseDir: harness.dir });
    const reloaded = await secondStore.load(record.id);
    expect(reloaded?.status).toBe('submitted');
    expect(reloaded?.originalRequest).toBe('Persist me');

    const byKey = await secondStore.findByIdempotencyKey('persist-key');
    expect(byKey?.id).toBe(record.id);
  });
});

describe('integration — concurrent safety', () => {
  it('serializes unconditional updates without losing any', async () => {
    const harness = makeHarness();
    const { record } = await harness.service.createIntake(
      { projectId: 'proj_alpha', originalRequest: 'concurrent', requestedBy: 'user-alice' },
      ALICE,
    );
    const writes = Array.from({ length: 5 }, (_, index) =>
      harness.service.updateIntake(record.id, { scopeNotes: `writer-${index}` }, ALICE),
    );
    const results = await Promise.all(writes);
    const final = await harness.service.getIntake(record.id, ALICE);
    expect(results.map((result) => result.version).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6]);
    expect(final?.version).toBe(6);
    expect(final?.scopeNotes).toMatch(/^writer-/);
  });

  it('handles duplicate submissions safely under concurrency', async () => {
    const harness = makeHarness();
    const { record } = await harness.service.createIntake(
      { projectId: 'proj_alpha', originalRequest: 'race submit', requestedBy: 'user-alice' },
      ALICE,
    );
    const [a, b] = await Promise.all([
      harness.service.submitIntake(record.id, ALICE),
      harness.service.submitIntake(record.id, BOB),
    ]);
    const submitted = [a, b].filter((result) => !result.idempotent);
    const idempotent = [a, b].filter((result) => result.idempotent);
    expect(submitted).toHaveLength(1);
    expect(idempotent).toHaveLength(1);
    const final = await harness.service.getIntake(record.id, ALICE);
    expect(final?.status).toBe('submitted');
    expect(final?.history.filter((entry) => entry.action === 'submitted')).toHaveLength(1);
  });

  it('keeps separate intakes independent under parallel creation', async () => {
    const harness = makeHarness();
    const inputs = Array.from({ length: 4 }, (_, index) => ({
      projectId: 'proj_alpha',
      originalRequest: `request ${index}`,
      requestedBy: 'user-alice',
    }));
    const results = await Promise.all(
      inputs.map((input) => harness.service.createIntake(input, ALICE)),
    );
    expect(results.every((result) => result.created)).toBe(true);
    const ids = new Set(results.map((result) => result.record.id));
    expect(ids.size).toBe(4);
    expect((await harness.service.listIntakes('proj_alpha', ALICE)).length).toBe(4);
  });
});
