import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AllowAllIntakeAuthorizer,
  DenyAllIntakeAuthorizer,
  ProjectMembershipIntakeAuthorizer,
} from '../src/authorization.js';
import {
  DEFAULT_INTAKE_QUESTIONS,
  MAX_ATTACHMENTS,
  MAX_HISTORY_ENTRIES,
  MAX_RELATED_RESOURCES,
  MAX_SUGGESTIONS,
} from '../src/constants.js';
import {
  IntakeAuthorizationError,
  IntakeConflictError,
  IntakeNotFoundError,
  IntakeStateTransitionError,
  IntakeValidationError,
} from '../src/errors.js';
import { IntakeEventEmitter } from '../src/events.js';
import {
  assertTransition,
  canTransition,
  isKnownStatus,
  isMutableStatus,
  isTerminalStatus,
} from '../src/lifecycle.js';
import { InMemoryIntakeLogger, NoopIntakeLogger } from '../src/logger.js';
import { InMemoryIntakeMetrics, NoopIntakeMetrics } from '../src/metrics.js';
import { buildInitialQuestions, upsertQuestion } from '../src/questions.js';
import { RequirementIntakeService } from '../src/service.js';
import {
  ANSWER_FIELD_MAPPING,
  appendItems,
  applyAnswerToRecord,
  applyAnswerUpdateToRecord,
  applyAttachmentToRecord,
  applyOptionalString,
  applyRelatedResourceToRecord,
  applySuggestionProposal,
  assertIntakeSubmitReady,
  buildNewIntakeRecord,
  findSuggestionProposal,
} from '../src/service-helpers.js';
import { RequirementIntakeStore } from '../src/store.js';
import {
  assertSuggestionString,
  toProposals,
  validateLlmSuggestionOutput,
} from '../src/suggestions.js';
import type { IntakeContext, RequirementIntakeRecord } from '../src/types.js';
import {
  deterministicTitle,
  isBlank,
  validateAttachmentInput,
  validateFieldSource,
  validateQuestionTemplateInput,
  validateRelatedResourceInput,
} from '../src/validation.js';

describe('Requirement Intake 100% Coverage Suite', () => {
  let tmpDir: string;
  let store: RequirementIntakeStore;
  let service: RequirementIntakeService;
  const ctx: IntakeContext = {
    id: 'user_1',
    type: 'user',
    projectId: 'proj_main',
  };

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'req-intake-test-'));
    store = new RequirementIntakeStore({ baseDir: tmpDir });
    service = new RequirementIntakeService({
      store,
      authorizer: new AllowAllIntakeAuthorizer(),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('authorization.ts', () => {
    it('handles ProjectMembershipIntakeAuthorizer with undefined ownerOnlyOperations and async resolver', async () => {
      const authorizer = new ProjectMembershipIntakeAuthorizer({
        projectsOf: async (_actorId, _actorType) => new Set(['proj_main']),
      });
      const allowed = await authorizer.isAllowed('create', ctx);
      expect(allowed).toBe(true);

      const deniedCross = await authorizer.isAllowed('create', { ...ctx, projectId: 'proj_other' });
      expect(deniedCross).toBe(false);
    });

    it('denies when record projectId does not match ctx projectId', async () => {
      const authorizer = new ProjectMembershipIntakeAuthorizer({
        projectsOf: () => new Set(['proj_main']),
      });
      const fakeRecord = { projectId: 'proj_other' } as RequirementIntakeRecord;
      const allowed = await authorizer.isAllowed('read', ctx, fakeRecord);
      expect(allowed).toBe(false);
    });

    it('enforces ownerOnlyOperations in ProjectMembershipIntakeAuthorizer', async () => {
      const authorizer = new ProjectMembershipIntakeAuthorizer({
        projectsOf: () => new Set(['proj_main']),
        ownerOnlyOperations: new Set(['submit']),
      });
      const recordOwned = {
        projectId: 'proj_main',
        requestedBy: 'user_1',
      } as RequirementIntakeRecord;
      const recordNotOwned = {
        projectId: 'proj_main',
        requestedBy: 'user_2',
      } as RequirementIntakeRecord;

      expect(await authorizer.isAllowed('submit', ctx, recordOwned)).toBe(true);
      expect(await authorizer.isAllowed('submit', ctx, recordNotOwned)).toBe(false);
    });

    it('covers DenyAllIntakeAuthorizer', () => {
      const authorizer = new DenyAllIntakeAuthorizer();
      expect(authorizer.isAllowed('create', ctx)).toBe(false);
    });
  });

  describe('events.ts', () => {
    it('swallows listener errors on emit', () => {
      const emitter = new IntakeEventEmitter();
      emitter.subscribe(() => {
        throw new Error('listener crash');
      });
      let received = false;
      emitter.subscribe(() => {
        received = true;
      });
      emitter.emit('RequirementIntakeCreated', {
        intakeId: '1',
        projectId: 'p',
        status: 'draft',
      });
      expect(received).toBe(true);
    });

    it('enforces MAX_LISTENERS and handles emitWarning existence checks', () => {
      const emitter = new IntakeEventEmitter();
      const emitWarningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});

      const disposers: Array<() => void> = [];
      for (let i = 0; i < 200; i++) {
        disposers.push(emitter.subscribe(() => {}));
      }
      expect(emitter.listenerCount).toBe(200);

      const noopDisposer = emitter.subscribe(() => {});
      expect(emitWarningSpy).toHaveBeenCalledWith(
        expect.stringContaining('listener limit reached'),
        'IntakeEventEmitterWarning',
      );
      expect(emitter.listenerCount).toBe(200);
      noopDisposer();
      expect(emitter.listenerCount).toBe(200);

      // Disposing a real listener decreases count
      disposers[0]();
      expect(emitter.listenerCount).toBe(199);

      // Re-fill to 200
      emitter.subscribe(() => {});

      // Test false branch of `typeof process.emitWarning === 'function'`
      const originalEmitWarning = process.emitWarning;
      try {
        (process as any).emitWarning = undefined;
        const noopDisposer2 = emitter.subscribe(() => {});
        noopDisposer2();
      } finally {
        process.emitWarning = originalEmitWarning;
      }
    });
  });

  describe('lifecycle.ts', () => {
    it('covers canTransition with unknown from status', () => {
      expect(canTransition('unknown' as any, 'draft')).toBe(false);
    });

    it('covers isTerminalStatus for submitted, cancelled, and archived', () => {
      expect(isTerminalStatus('submitted')).toBe(true);
      expect(isTerminalStatus('cancelled')).toBe(true);
      expect(isTerminalStatus('archived')).toBe(true);
      expect(isTerminalStatus('draft')).toBe(false);
      expect(isTerminalStatus('collecting_information')).toBe(false);
    });

    it('covers isKnownStatus', () => {
      expect(isKnownStatus('draft')).toBe(true);
      expect(isKnownStatus('submitted')).toBe(true);
      expect(isKnownStatus('nonexistent')).toBe(false);
    });

    it('covers isMutableStatus', () => {
      expect(isMutableStatus('draft')).toBe(true);
      expect(isMutableStatus('collecting_information')).toBe(true);
      expect(isMutableStatus('submitted')).toBe(false);
    });

    it('throws assertTransition for invalid transitions', () => {
      expect(() => assertTransition('archived', 'draft')).toThrow(IntakeStateTransitionError);
    });
  });

  describe('logger.ts and metrics.ts', () => {
    it('covers NoopIntakeLogger and InMemoryIntakeLogger with all levels and optional fields', () => {
      const noop = new NoopIntakeLogger();
      noop.info('scope', 'msg');
      noop.warn('scope', 'msg');
      noop.error('scope', 'msg');

      const mem = new InMemoryIntakeLogger();
      mem.info('scope', 'info msg');
      mem.warn('scope', 'warn msg', { key: 'val' });
      mem.warn('scope', 'warn without fields');
      mem.error('scope', 'error msg');
      mem.error('scope', 'error with fields', { err: 'test' });

      expect(mem.entries).toHaveLength(5);
      expect(mem.entries[0].fields).toBeUndefined();
      expect(mem.entries[1].fields).toEqual({ key: 'val' });
      expect(mem.entries[2].fields).toBeUndefined();
      expect(mem.entries[3].fields).toBeUndefined();
      expect(mem.entries[4].fields).toEqual({ err: 'test' });
    });

    it('covers NoopIntakeMetrics and InMemoryIntakeMetrics durationSum branches', () => {
      const noop = new NoopIntakeMetrics();
      noop.increment('intake.created');
      noop.recordDuration('intake.time_to_submit', 100);

      const mem = new InMemoryIntakeMetrics();
      expect(mem.durationSum('intake.time_to_submit')).toBeUndefined();

      mem.recordDuration('intake.time_to_submit', 150);
      mem.recordDuration('intake.time_to_submit', 250);
      expect(mem.durationSum('intake.time_to_submit')).toBe(400);

      // Force empty bucket branch
      mem.durations.set('intake.time_to_submit', []);
      expect(mem.durationSum('intake.time_to_submit')).toBeUndefined();
    });
  });

  describe('questions.ts', () => {
    it('covers FIELD_TO_INPUT_PROPERTY for expectedOutcome and fallback field', () => {
      const initial = buildInitialQuestions(
        {
          projectId: 'proj_main',
          originalRequest: 'Please add a search bar',
          requestedBy: 'user_1',
          expectedOutcome: 'Fast search result display',
          businessGoal: 'Improve navigation',
        },
        [
          ...DEFAULT_INTAKE_QUESTIONS,
          { field: 'custom_unknown_field', question: 'What is custom?', required: false },
        ],
      );
      const outcomeQ = initial.find((q) => q.field === 'expected_outcome');
      expect(outcomeQ?.status).toBe('skipped');

      const customQ = initial.find((q) => q.field === 'custom_unknown_field');
      expect(customQ?.status).toBe('unanswered');
    });

    it('covers upsertQuestion when question already exists', () => {
      const record = {
        questions: [
          {
            id: 'q1',
            field: 'priority',
            question: 'Priority?',
            status: 'unanswered',
            required: true,
            order: 0,
          },
        ],
      } as RequirementIntakeRecord;

      const added = upsertQuestion(record, { field: 'priority', question: 'New priority?' });
      expect(added).toBe(false);
      expect(record.questions).toHaveLength(1);
    });
  });

  describe('suggestions.ts', () => {
    it('covers toProposals with suggestedPriority and outcome', () => {
      const proposals = toProposals({
        suggestedTitle: 'Title',
        normalizedSummary: 'Summary',
        suggestedRequestType: 'feature',
        suggestedPriority: 'critical',
        suggestedOutcome: 'Outcome',
        extractedConstraints: ['c1'],
        extractedTargetUsers: ['u1'],
        suggestedQuestions: [{ field: 'q1', question: 'Question 1?' }],
      });
      expect(proposals.some((p) => p.kind === 'priority')).toBe(true);
      expect(proposals.some((p) => p.kind === 'outcome')).toBe(true);
    });

    it('covers assertSuggestionString validation errors', () => {
      expect(() => assertSuggestionString(123, 'title', 50)).toThrow(IntakeValidationError);
      expect(() => assertSuggestionString('   ', 'title', 50)).toThrow(IntakeValidationError);
      expect(() => assertSuggestionString('toolongstring', 'title', 5)).toThrow(
        IntakeValidationError,
      );
      expect(assertSuggestionString('valid', 'title', 50)).toBe('valid');
    });

    it('normalizes suggested request type and priority in validateLlmSuggestionOutput', () => {
      const result = validateLlmSuggestionOutput({
        suggested_request_type: 'bug-fix',
        suggested_priority: 'high',
      });
      expect(result.suggestedRequestType).toBe('bug_fix');
      expect(result.suggestedPriority).toBe('high');

      const invalidPriority = validateLlmSuggestionOutput({
        suggested_priority: 'super-urgent',
      });
      expect(invalidPriority.suggestedPriority).toBeUndefined();
    });
  });

  describe('validation.ts', () => {
    it('covers URL validator failure and isBlank', () => {
      expect(isBlank('   ')).toBe(true);
      expect(isBlank('hello')).toBe(false);

      expect(() =>
        validateAttachmentInput({
          name: 'doc.pdf',
          kind: 'link',
          url: 'not-a-valid-url',
        }),
      ).toThrow(IntakeValidationError);
    });

    it('covers validateRelatedResourceInput, validateQuestionTemplateInput, and validateFieldSource', () => {
      const related = validateRelatedResourceInput({
        kind: 'issue',
        reference: 'ISSUE-123',
        title: 'Issue title',
      });
      expect(related.reference).toBe('ISSUE-123');

      const question = validateQuestionTemplateInput({
        field: 'custom_field',
        question: 'Custom question?',
        required: true,
      });
      expect(question.field).toBe('custom_field');

      expect(validateFieldSource('user')).toBe('user');
      expect(() => validateFieldSource('invalid_source')).toThrow(IntakeValidationError);
    });

    it('covers deterministicTitle multi-line and blank first line fallbacks', () => {
      expect(deterministicTitle('')).toBe('Untitled request');
      expect(deterministicTitle('\n\nsecond line')).toBe('Untitled request');
      expect(deterministicTitle('Single line without newline')).toBe('Single line without newline');
      const longLine = 'A'.repeat(300);
      expect(deterministicTitle(longLine)).toBe(`${'A'.repeat(199)}…`);
    });

    it('covers metadata serialization error', async () => {
      const nonSerializable = { bigint: BigInt(123) };
      await expect(
        service.createIntake(
          {
            projectId: 'proj_main',
            originalRequest: 'Request',
            requestedBy: 'user_1',
            metadata: nonSerializable as any,
          },
          ctx,
        ),
      ).rejects.toThrow(IntakeValidationError);
    });
  });

  describe('store.ts', () => {
    it('uses default projectRequirementIntakes when baseDir is not specified', () => {
      const defaultStore = new RequirementIntakeStore({});
      expect(defaultStore.directory).toContain('requirement-intakes');
    });

    it('truncates history when exceeding MAX_HISTORY_ENTRIES', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'A long request to update multiple times',
          requestedBy: 'user_1',
        },
        ctx,
      );

      // Check exists returns true for existing record
      expect(await store.exists(created.record.id)).toBe(true);

      // Perform updates to exceed MAX_HISTORY_ENTRIES (50)
      for (let i = 0; i < MAX_HISTORY_ENTRIES + 5; i++) {
        await service.updateIntake(created.record.id, { scopeNotes: `Note update ${i}` }, ctx);
      }

      const reloaded = await store.load(created.record.id);
      expect(reloaded!.history.length).toBe(MAX_HISTORY_ENTRIES);
    });

    it('prunes idempotency map when entries exceed maxIdempotencyEntries', async () => {
      const smallStore = new RequirementIntakeStore({
        baseDir: path.join(tmpDir, 'small-store'),
        maxIdempotencyEntries: 2,
      });

      const smallService = new RequirementIntakeService({
        store: smallStore,
        authorizer: new AllowAllIntakeAuthorizer(),
      });

      await smallService.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Req 1',
          requestedBy: 'user_1',
          idempotencyKey: 'key_1',
        },
        ctx,
      );
      await smallService.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Req 2',
          requestedBy: 'user_1',
          idempotencyKey: 'key_2',
        },
        ctx,
      );
      await smallService.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Req 3',
          requestedBy: 'user_1',
          idempotencyKey: 'key_3',
        },
        ctx,
      );

      // key_1 should have been pruned
      const pruned = await smallStore.findByIdempotencyKey('key_1');
      expect(pruned).toBeNull();

      const existing3 = await smallStore.findByIdempotencyKey('key_3');
      expect(existing3).not.toBeNull();
    });

    it('recovers gracefully from corrupt _index.json and _idempotency.json', async () => {
      await fsp.writeFile(path.join(tmpDir, '_index.json'), '{ invalid json');
      await fsp.writeFile(path.join(tmpDir, '_idempotency.json'), 'null');

      const index = await store.listIndex();
      expect(index).toEqual([]);

      const idemp = await store.findByIdempotencyKey('any_key');
      expect(idemp).toBeNull();
    });

    it('throws IntakeConflictError on expectedVersion mismatch during update', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Req',
          requestedBy: 'user_1',
        },
        ctx,
      );

      await expect(
        store.update(created.record.id, { expectedVersion: 999 }, () => {}),
      ).rejects.toThrow(IntakeConflictError);
    });

    it('returns null / false for non-existent records', async () => {
      expect(await store.load('non-existent')).toBeNull();
      expect(await store.exists('non-existent')).toBe(false);
      await expect(store.update('non-existent', {}, () => {})).rejects.toThrow(IntakeNotFoundError);
    });
  });

  describe('service-helpers.ts', () => {
    it('covers appendItems duplicates and MAX_ARRAY_ITEMS cap', () => {
      const list = ['item1'];
      appendItems(list, 'item1, item2; item3');
      expect(list).toEqual(['item1', 'item2', 'item3']);

      // Fill to cap
      for (let i = 0; i < 50; i++) {
        list.push(`item_${i}`);
      }
      appendItems(list, 'overflow_item');
      expect(list.includes('overflow_item')).toBe(false);
    });

    it('covers ANSWER_FIELD_MAPPING for scope_notes, description_scope, project_component, priority, expected_outcome, constraints, provided_context', () => {
      const record = {
        targetUsers: [],
        constraints: [],
        providedContext: [],
        fieldSources: {},
      } as unknown as RequirementIntakeRecord;

      ANSWER_FIELD_MAPPING.expected_outcome.set(record, 'outcome 1');
      expect(record.expectedOutcome).toBe('outcome 1');

      ANSWER_FIELD_MAPPING.constraints.set(record, 'c1, c2');
      expect(record.constraints).toEqual(['c1', 'c2']);

      ANSWER_FIELD_MAPPING.provided_context.set(record, 'p1, p2');
      expect(record.providedContext).toEqual(['p1', 'p2']);

      ANSWER_FIELD_MAPPING.scope_notes.set(record, 'scope 1');
      expect(record.scopeNotes).toBe('scope 1');

      ANSWER_FIELD_MAPPING.description_scope.set(record, 'scope 2');
      expect(record.scopeNotes).toBe('scope 2');

      ANSWER_FIELD_MAPPING.project_component.set(record, 'comp1, comp2');
      expect(record.providedContext).toEqual(['p1', 'p2', 'comp1', 'comp2']);

      ANSWER_FIELD_MAPPING.priority.set(record, 'invalid-prio');
      expect(record.priority).toBeUndefined();

      ANSWER_FIELD_MAPPING.priority.set(record, 'high');
      expect(record.priority).toBe('high');
      expect(record.fieldSources.priority).toBe('user');
    });

    it('covers assertIntakeSubmitReady validation errors', () => {
      expect(() =>
        assertIntakeSubmitReady({
          originalRequest: '',
          title: '',
          requestedBy: '',
          projectId: '',
        } as RequirementIntakeRecord),
      ).toThrow(IntakeValidationError);
    });

    it('covers findSuggestionProposal error when not found', () => {
      const record = { llmSuggestions: [] } as unknown as RequirementIntakeRecord;
      expect(() => findSuggestionProposal(record, 'sugg_1')).toThrow(IntakeValidationError);
    });

    it('covers applySuggestionProposal with all kinds', () => {
      const record = {
        llmSuggestions: [],
        fieldSources: {},
        questions: [],
        targetUsers: [],
        constraints: [],
      } as unknown as RequirementIntakeRecord;

      // 1. title
      applySuggestionProposal(record, {
        id: 's1',
        kind: 'title',
        value: 'New Title',
        status: 'pending',
        createdAt: Date.now(),
      });
      expect(record.title).toBe('New Title');

      // 2. summary
      applySuggestionProposal(record, {
        id: 's2',
        kind: 'summary',
        value: 'New Summary',
        status: 'pending',
        createdAt: Date.now(),
      });
      expect(record.normalizedSummary).toBe('New Summary');

      // 3. request_type
      applySuggestionProposal(record, {
        id: 's3',
        kind: 'request_type',
        value: 'feature',
        status: 'pending',
        createdAt: Date.now(),
      });
      expect(record.requestType).toBe('feature');

      // 4. valid priority
      applySuggestionProposal(record, {
        id: 's4',
        kind: 'priority',
        value: 'high',
        status: 'pending',
        createdAt: Date.now(),
      });
      expect(record.priority).toBe('high');

      // 5. invalid priority
      applySuggestionProposal(record, {
        id: 's5',
        kind: 'priority',
        value: 'unknown_priority',
        status: 'pending',
        createdAt: Date.now(),
      });

      // 6. constraint
      applySuggestionProposal(record, {
        id: 's6',
        kind: 'constraint',
        value: 'Must be fast',
        status: 'pending',
        createdAt: Date.now(),
      });
      expect(record.constraints).toContain('Must be fast');

      // 7. target_user
      applySuggestionProposal(record, {
        id: 's7',
        kind: 'target_user',
        value: 'Engineers',
        status: 'pending',
        createdAt: Date.now(),
      });
      expect(record.targetUsers).toContain('Engineers');

      // 8. outcome
      applySuggestionProposal(record, {
        id: 's8',
        kind: 'outcome',
        value: 'Success outcome',
        status: 'pending',
        createdAt: Date.now(),
      });
      expect(record.expectedOutcome).toBe('Success outcome');

      // 9. valid question
      applySuggestionProposal(record, {
        id: 's9',
        kind: 'question',
        value: { field: 'new_field', question: 'New Question?', required: true },
        status: 'pending',
        createdAt: Date.now(),
      });
      expect(record.questions.some((q) => q.field === 'new_field')).toBe(true);

      // 10. malformed question branches
      applySuggestionProposal(record, {
        id: 's10a',
        kind: 'question',
        value: null,
        status: 'pending',
        createdAt: Date.now(),
      });
      applySuggestionProposal(record, {
        id: 's10b',
        kind: 'question',
        value: { field: 123, question: 'Q' },
        status: 'pending',
        createdAt: Date.now(),
      });
      applySuggestionProposal(record, {
        id: 's10c',
        kind: 'question',
        value: { field: 'f', question: 123 },
        status: 'pending',
        createdAt: Date.now(),
      });
      applySuggestionProposal(record, {
        id: 's10d',
        kind: 'question',
        value: 'not-an-object',
        status: 'pending',
        createdAt: Date.now(),
      });
    });

    it('covers applyOptionalString clearing field on blank', () => {
      const record = { businessGoal: 'goal' } as RequirementIntakeRecord;
      applyOptionalString(record, 'businessGoal', '  ');
      expect(record.businessGoal).toBeUndefined();
    });

    it('covers applyAnswerUpdateToRecord error when answerId is missing', () => {
      const record = { answers: [], questions: [] } as unknown as RequirementIntakeRecord;
      expect(() => applyAnswerUpdateToRecord(record, 'nonexistent', 'answer')).toThrow(
        IntakeValidationError,
      );
    });

    it('covers applyAttachmentToRecord and applyRelatedResourceToRecord cap limits', () => {
      const record = {
        attachments: Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({ id: `a_${i}` })) as any,
        relatedResources: Array.from({ length: MAX_RELATED_RESOURCES }, (_, i) => ({
          id: `r_${i}`,
        })) as any,
        fieldSources: {},
        questions: [],
      } as unknown as RequirementIntakeRecord;

      expect(() =>
        applyAttachmentToRecord(
          record,
          { attachment: { name: 'file.txt', kind: 'file', path: '/path' } },
          'user_1',
          Date.now(),
        ),
      ).toThrow(IntakeValidationError);

      expect(() =>
        applyRelatedResourceToRecord(
          record,
          { relatedResource: { kind: 'doc', reference: 'ref' } },
          'user_1',
          Date.now(),
        ),
      ).toThrow(IntakeValidationError);
    });

    it('covers buildNewIntakeRecord with explicit vibeProtocol and isVibeMode', () => {
      const record = buildNewIntakeRecord(
        {
          projectId: 'proj_main',
          originalRequest: 'Vibe mode request',
          requestedBy: 'user_1',
          isVibeMode: true,
          businessGoal: 'Goal',
          targetUsers: ['user1'],
          expectedOutcome: 'Outcome',
          scopeNotes: 'Notes',
          constraints: ['c1'],
          providedContext: ['p1'],
          attachments: [{ name: 'a.txt', kind: 'file', path: '/path' }],
          relatedResources: [{ kind: 'pr', reference: 'https://example.com/pr/1' }],
        },
        ctx,
        Date.now(),
        DEFAULT_INTAKE_QUESTIONS,
      );

      expect(record.isVibeMode).toBe(true);
      expect(record.vibeProtocol?.isVibeMode).toBe(true);
      expect(record.businessGoal).toBe('Goal');
      expect(record.targetUsers).toEqual(['user1']);
      expect(record.attachments).toHaveLength(1);
      expect(record.relatedResources).toHaveLength(1);
    });
  });

  describe('service.ts edge cases', () => {
    it('throws error when idempotency key is reused across projects', async () => {
      await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request 1',
          requestedBy: 'user_1',
          idempotencyKey: 'shared_key',
        },
        ctx,
      );

      await expect(
        service.createIntake(
          {
            projectId: 'proj_other',
            originalRequest: 'Request 2',
            requestedBy: 'user_1',
            idempotencyKey: 'shared_key',
          },
          { ...ctx, projectId: 'proj_other' },
        ),
      ).rejects.toThrow(IntakeValidationError);
    });

    it('throws IntakeAuthorizationError on listIntakes cross-project call', async () => {
      await expect(service.listIntakes('proj_other', ctx)).rejects.toThrow(
        IntakeAuthorizationError,
      );
    });

    it('returns null on getIntake when record does not exist', async () => {
      expect(await service.getIntake('non-existent', ctx)).toBeNull();
    });

    it('returns record unmodified when updateIntake patch is empty, and applies all optional properties', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request',
          requestedBy: 'user_1',
        },
        ctx,
      );
      const unchanged = await service.updateIntake(created.record.id, {}, ctx);
      expect(unchanged.version).toBe(created.record.version);

      const updated = await service.updateIntake(
        created.record.id,
        {
          providedContext: ['p1', 'p2'],
          constraints: ['c1'],
          targetUsers: ['u_updated'],
          businessGoal: 'new goal',
          expectedOutcome: 'new outcome',
          scopeNotes: 'new scope',
          metadata: { env: 'staging' },
          isVibeMode: true,
          vibeProtocol: { isVibeMode: true, detectedAt: Date.now(), stage: 'synthesizer' },
        },
        ctx,
      );
      expect(updated.providedContext).toEqual(['p1', 'p2']);
      expect(updated.targetUsers).toEqual(['u_updated']);
      expect(updated.metadata).toEqual({ env: 'staging' });
      expect(updated.isVibeMode).toBe(true);
      expect(updated.vibeProtocol?.stage).toBe('synthesizer');
    });

    it('rejects blank title on updateIntake', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request',
          requestedBy: 'user_1',
        },
        ctx,
      );
      await expect(service.updateIntake(created.record.id, { title: '   ' }, ctx)).rejects.toThrow(
        IntakeValidationError,
      );
    });

    it('throws when updating an answer that does not exist', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request',
          requestedBy: 'user_1',
        },
        ctx,
      );
      await expect(
        service.updateAnswer(created.record.id, 'ans_nonexistent', { answer: 'New' }, ctx),
      ).rejects.toThrow(IntakeValidationError);
    });

    it('attaches related resource through attachResource', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request',
          requestedBy: 'user_1',
        },
        ctx,
      );
      const updated = await service.attachResource(
        created.record.id,
        { relatedResource: { kind: 'doc', reference: 'https://docs.example.com' } },
        ctx,
      );
      expect(updated.relatedResources).toHaveLength(1);
    });

    it('handles generateSuggestions failures and zero proposals', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request',
          requestedBy: 'user_1',
        },
        ctx,
      );

      // 1. Generator throws error
      const failingService = new RequirementIntakeService({
        store,
        authorizer: new AllowAllIntakeAuthorizer(),
        generator: {
          generate: async () => {
            throw new Error('LLM down');
          },
        },
      });
      await expect(failingService.generateSuggestions(created.record.id, ctx)).rejects.toThrow(
        'LLM suggestion generation failed',
      );

      // 2. Generator returns empty output (0 proposals)
      const emptyService = new RequirementIntakeService({
        store,
        authorizer: new AllowAllIntakeAuthorizer(),
        generator: {
          generate: async () => ({}),
        },
      });
      await expect(emptyService.generateSuggestions(created.record.id, ctx)).rejects.toThrow(
        'LLM suggestion output contained no usable proposals',
      );
    });

    it('truncates suggestions when exceeding MAX_SUGGESTIONS', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request with many suggestions',
          requestedBy: 'user_1',
        },
        ctx,
      );

      // Pre-seed 50 suggestions
      await store.update(created.record.id, {}, (next) => {
        for (let i = 0; i < MAX_SUGGESTIONS; i++) {
          next.llmSuggestions.push({
            id: `sugg_existing_${i}`,
            kind: 'title',
            value: `Title ${i}`,
            status: 'pending',
            createdAt: Date.now(),
          });
        }
      });

      const suggService = new RequirementIntakeService({
        store,
        authorizer: new AllowAllIntakeAuthorizer(),
        generator: {
          generate: async () => ({
            suggested_title: 'Title overflow',
          }),
        },
      });

      await suggService.generateSuggestions(created.record.id, ctx);
      const reloaded = await store.load(created.record.id);
      expect(reloaded!.llmSuggestions).toHaveLength(MAX_SUGGESTIONS);
    });

    it('handles suggestions without questions and emits RequirementIntakeUpdated', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request',
          requestedBy: 'user_1',
        },
        ctx,
      );

      const suggService = new RequirementIntakeService({
        store,
        authorizer: new AllowAllIntakeAuthorizer(),
        generator: {
          generate: async () => ({
            suggested_title: 'Suggested title',
          }),
        },
      });

      const events: string[] = [];
      suggService.subscribe((evt) => events.push(evt.event));

      const proposals = await suggService.generateSuggestions(created.record.id, ctx);
      expect(proposals).toHaveLength(1);
      expect(events).toContain('RequirementIntakeUpdated');
    });

    it('rejects acceptSuggestion and rejectSuggestion on non-pending suggestions and missing mutator target', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request',
          requestedBy: 'user_1',
        },
        ctx,
      );

      const suggService = new RequirementIntakeService({
        store,
        authorizer: new AllowAllIntakeAuthorizer(),
        generator: {
          generate: async () => ({
            suggested_title: 'Suggested title',
          }),
        },
      });

      const [proposal] = await suggService.generateSuggestions(created.record.id, ctx);
      await suggService.acceptSuggestion(created.record.id, proposal.id, ctx);

      // Accepting again should fail
      await expect(
        suggService.acceptSuggestion(created.record.id, proposal.id, ctx),
      ).rejects.toThrow(IntakeValidationError);

      // Rejecting an accepted proposal should fail
      await expect(
        suggService.rejectSuggestion(created.record.id, proposal.id, ctx),
      ).rejects.toThrow(IntakeValidationError);

      // Generate a fresh pending proposal
      const [freshProposal] = await suggService.generateSuggestions(created.record.id, ctx);

      // Simulate mutator target not found in acceptSuggestion
      vi.spyOn(store, 'update').mockImplementationOnce(async (_id, _opts, mutate) => {
        const fake = { ...created.record, llmSuggestions: [] };
        await mutate(fake);
        return fake;
      });
      await expect(
        suggService.acceptSuggestion(created.record.id, freshProposal.id, ctx),
      ).rejects.toThrow(IntakeValidationError);

      // Simulate mutator target not found in rejectSuggestion
      vi.spyOn(store, 'update').mockImplementationOnce(async (_id, _opts, mutate) => {
        const fake = { ...created.record, llmSuggestions: [] };
        await mutate(fake);
        return fake;
      });
      await expect(
        suggService.rejectSuggestion(created.record.id, freshProposal.id, ctx),
      ).rejects.toThrow(IntakeValidationError);

      // Simulate mutator target not pending in rejectSuggestion
      vi.spyOn(store, 'update').mockImplementationOnce(async (_id, _opts, mutate) => {
        const fake = {
          ...created.record,
          llmSuggestions: [
            { id: freshProposal.id, kind: 'title', value: 't', status: 'accepted', createdAt: 0 },
          ],
        };
        await mutate(fake as any);
        return fake as any;
      });
      await expect(
        suggService.rejectSuggestion(created.record.id, freshProposal.id, ctx),
      ).rejects.toThrow(IntakeValidationError);
    });

    it('submits idempotently when record is already submitted', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request to submit',
          requestedBy: 'user_1',
        },
        ctx,
      );

      const sub1 = await service.submitIntake(created.record.id, ctx);
      expect(sub1.idempotent).toBe(false);
      expect(sub1.record.status).toBe('submitted');

      const sub2 = await service.submitIntake(created.record.id, ctx);
      expect(sub2.idempotent).toBe(true);
    });

    it('covers submit CAS race conflict resolution and re-throw', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request CAS',
          requestedBy: 'user_1',
        },
        ctx,
      );

      // Simulate conflict where latest record is indeed submitted
      vi.spyOn(store, 'update').mockRejectedValueOnce(
        new IntakeConflictError(created.record.id, 1, 2),
      );
      vi.spyOn(store, 'load').mockResolvedValueOnce({
        ...created.record,
        status: 'submitted',
      });

      const res = await service.submitIntake(created.record.id, ctx);
      expect(res.idempotent).toBe(true);

      // Simulate conflict where latest record is NOT submitted -> rethrows error
      vi.spyOn(store, 'update').mockRejectedValueOnce(
        new IntakeConflictError(created.record.id, 1, 2),
      );
      vi.spyOn(store, 'load').mockResolvedValueOnce({
        ...created.record,
        status: 'collecting_information',
      });

      await expect(service.submitIntake(created.record.id, ctx)).rejects.toThrow(
        IntakeConflictError,
      );
    });

    it('covers cancelIntake with and without reason', async () => {
      const created1 = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Cancel 1',
          requestedBy: 'user_1',
        },
        ctx,
      );
      const c1 = await service.cancelIntake(created1.record.id, ctx, 'No longer needed');
      expect(c1.status).toBe('cancelled');
      expect(c1.cancelledReason).toBe('No longer needed');

      const created2 = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Cancel 2',
          requestedBy: 'user_1',
        },
        ctx,
      );
      const c2 = await service.cancelIntake(created2.record.id, ctx);
      expect(c2.status).toBe('cancelled');
      expect(c2.cancelledReason).toBeUndefined();
    });

    it('covers guardValidation and assertSubmitReady with non-IntakeValidationError', () => {
      expect(() =>
        (service as any).guardValidation(() => {
          throw new Error('generic validation error');
        }),
      ).toThrow('generic validation error');

      expect(() =>
        (service as any).assertSubmitReady({
          get originalRequest(): string {
            throw new Error('getter error');
          },
        } as any),
      ).toThrow('getter error');
    });

    it('covers non-IntakeConflictError in submitIntake', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request CAS Generic Error',
          requestedBy: 'user_1',
        },
        ctx,
      );

      vi.spyOn(store, 'update').mockRejectedValueOnce(new Error('generic database error'));
      await expect(service.submitIntake(created.record.id, ctx)).rejects.toThrow(
        'generic database error',
      );
    });

    it('covers non-IntakeSuggestionError during proposal validation in generateSuggestions', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request for suggestion failure',
          requestedBy: 'user_1',
        },
        ctx,
      );

      const faultyService = new RequirementIntakeService({
        store,
        authorizer: new AllowAllIntakeAuthorizer(),
        generator: {
          generate: async () => ({
            get suggested_title(): string {
              throw new TypeError('unexpected generator property error');
            },
          }),
        },
      });

      await expect(faultyService.generateSuggestions(created.record.id, ctx)).rejects.toThrow(
        'LLM suggestion output could not be validated',
      );
    });

    it('covers applyAnswerToRecord question fallbacks and missing mapping', () => {
      const record = {
        answers: [],
        questions: [{ field: 'has_q', question: 'Existing Question text', status: 'unanswered' }],
        fieldSources: {},
      } as unknown as RequirementIntakeRecord;

      // 1. validated.question is undefined, matching question exists
      const ans1 = applyAnswerToRecord(
        record,
        { field: 'has_q', answer: 'a1' },
        'user_1',
        Date.now(),
      );
      expect(ans1.question).toBe('Existing Question text');

      // 2. validated.question is undefined, matching question does NOT exist, and no mapping
      const ans2 = applyAnswerToRecord(
        record,
        { field: 'no_q_no_map', answer: 'a2' },
        'user_1',
        Date.now(),
      );
      expect(ans2.question).toBe('no_q_no_map');
    });

    it('covers applyAnswerUpdateToRecord when record.questions has no matching question', () => {
      const record = {
        answers: [
          {
            id: 'ans_orphan',
            field: 'orphan_field',
            question: 'q',
            answer: 'old',
            answeredBy: 'u',
            answeredAt: 0,
            source: 'user',
          },
        ],
        questions: [],
      } as unknown as RequirementIntakeRecord;

      applyAnswerUpdateToRecord(record, 'ans_orphan', 'new answer');
      expect(record.answers[0].answer).toBe('new answer');
    });

    it('covers unknown field in assertAnswerField', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request',
          requestedBy: 'user_1',
        },
        ctx,
      );

      await expect(
        service.addAnswer(
          created.record.id,
          { field: 'totally_unknown_field_xyz', answer: 'some answer' },
          ctx,
        ),
      ).rejects.toThrow(IntakeValidationError);
    });

    it('covers validation failure metric in submitIntake', async () => {
      const created = await service.createIntake(
        {
          projectId: 'proj_main',
          originalRequest: 'Request',
          requestedBy: 'user_1',
        },
        ctx,
      );

      // Artificially blank out title in storage to trigger assertSubmitReady error
      await store.update(created.record.id, {}, (next) => {
        next.title = '';
      });

      await expect(service.submitIntake(created.record.id, ctx)).rejects.toThrow(
        IntakeValidationError,
      );
    });
  });
});
