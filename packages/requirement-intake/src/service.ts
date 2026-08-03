/**
 * Requirements Intake — service.
 *
 * The single entry point for all intake operations. Enforces:
 *  - deterministic validation of every input (untrusted text stays data),
 *  - authorization on every operation (fail closed),
 *  - lifecycle transitions via application logic only,
 *  - optimistic concurrency (expectedVersion),
 *  - idempotent create (idempotency key) and submit,
 *  - source tracking (user / llm / deterministic),
 *  - domain events + structured logs + metrics with safe fields only.
 *
 * The original request is immutable after creation: no API path can change
 * `originalRequest`, and LLM suggestions can never write to it.
 */
import { ulid } from '@wrongstack/core/utils';
import {
  ANSWER_ID_PREFIX,
  ATTACHMENT_ID_PREFIX,
  DEFAULT_INTAKE_QUESTIONS,
  INTAKE_FIELDS,
  INTAKE_PRIORITIES,
  MAX_ARRAY_ITEMS,
  MAX_ATTACHMENTS,
  MAX_RELATED_RESOURCES,
  MAX_STRING_FIELD_LENGTH,
  MAX_SUGGESTIONS,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  RELATED_RESOURCE_ID_PREFIX,
  type IntakePriority,
  type IntakeQuestionTemplate,
  type IntakeStatus,
} from './constants.js';
import type { IntakeAuthorizer, IntakeOperation } from './authorization.js';
import {
  IntakeAuthorizationError,
  IntakeConflictError,
  IntakeNotFoundError,
  IntakeStatusLockedError,
  IntakeSuggestionError,
  IntakeValidationError,
  type IntakeValidationIssue,
} from './errors.js';
import { IntakeEventEmitter } from './events.js';
import { isMutableStatus, assertTransition } from './lifecycle.js';
import { type IntakeLogger, NoopIntakeLogger } from './logger.js';
import { type IntakeMetrics, InMemoryIntakeMetrics } from './metrics.js';
import { buildInitialQuestions, pendingQuestions, upsertQuestion } from './questions.js';
import {
  type LlmSuggestionGenerator,
  assertSuggestionString,
  toProposals,
  validateLlmSuggestionOutput,
} from './suggestions.js';
import { newIntakeId, type RequirementIntakeStore, type StoreUpdateOptions } from './store.js';
import type {
  AddAnswerInput,
  AttachResourceInput,
  CreateIntakeInput,
  IntakeAnswer,
  IntakeAttachment,
  IntakeContext,
  IntakeEvent,
  IntakeEventName,
  IntakeQuestion,
  LlmSuggestionProposal,
  RelatedResource,
  RequirementIntakeRecord,
  UpdateIntakeInput,
} from './types.js';
import {
  deterministicSummary,
  deterministicTitle,
  normalizeRequestType,
  validateAnswerInput,
  validateAttachResourceInput,
  validateCreateInput,
  validateUpdateInput,
} from './validation.js';

export interface RequirementIntakeServiceOptions {
  store: RequirementIntakeStore;
  authorizer: IntakeAuthorizer;
  /** Optional LLM adapter. `generateSuggestions` fails until one is wired. */
  generator?: LlmSuggestionGenerator | undefined;
  emitter?: IntakeEventEmitter | undefined;
  logger?: IntakeLogger | undefined;
  metrics?: IntakeMetrics | undefined;
  /** Default question catalog override. */
  questions?: readonly IntakeQuestionTemplate[] | undefined;
}

export interface IntakeCreateResult {
  record: RequirementIntakeRecord;
  created: boolean;
  idempotent: boolean;
}

export interface IntakeSubmitResult {
  record: RequirementIntakeRecord;
  idempotent: boolean;
}

export interface IntakeListFilter {
  statuses?: readonly IntakeStatus[] | undefined;
}

/** Answer fields that also update a record property. */
const ANSWER_FIELD_MAPPING: Readonly<
  Record<string, { set: (record: RequirementIntakeRecord, value: string) => void }>
> = {
  business_goal: {
    set: (record, value) => {
      record.businessGoal = value;
    },
  },
  expected_outcome: {
    set: (record, value) => {
      record.expectedOutcome = value;
    },
  },
  scope_notes: {
    set: (record, value) => {
      record.scopeNotes = value;
    },
  },
  description_scope: {
    set: (record, value) => {
      record.scopeNotes = value;
    },
  },
  target_users: {
    set: (record, value) => {
      appendItems(record.targetUsers, value);
    },
  },
  constraints: {
    set: (record, value) => {
      appendItems(record.constraints, value);
    },
  },
  provided_context: {
    set: (record, value) => {
      appendItems(record.providedContext, value);
    },
  },
  project_component: {
    set: (record, value) => {
      appendItems(record.providedContext, value);
    },
  },
  priority: {
    set: (record, value) => {
      const trimmed = value.trim().toLowerCase();
      if ((INTAKE_PRIORITIES as readonly string[]).includes(trimmed)) {
        record.priority = trimmed as IntakePriority;
        record.fieldSources.priority = 'user';
      }
    },
  },
};

function appendItems(target: string[], value: string): void {
  const items = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const remaining = Math.max(0, MAX_ARRAY_ITEMS - target.length);
  target.push(...items.slice(0, remaining));
}

export class RequirementIntakeService {
  private readonly store: RequirementIntakeStore;
  private readonly authorizer: IntakeAuthorizer;
  private readonly generator: LlmSuggestionGenerator | undefined;
  private readonly emitter: IntakeEventEmitter;
  private readonly logger: IntakeLogger;
  private readonly metrics: IntakeMetrics;
  private readonly catalog: readonly IntakeQuestionTemplate[];

  constructor(options: RequirementIntakeServiceOptions) {
    this.store = options.store;
    this.authorizer = options.authorizer;
    this.generator = options.generator;
    this.emitter = options.emitter ?? new IntakeEventEmitter();
    this.logger = options.logger ?? new NoopIntakeLogger();
    this.metrics = options.metrics ?? new InMemoryIntakeMetrics();
    this.catalog = options.questions ?? DEFAULT_INTAKE_QUESTIONS;
  }

  /** Subscribe to domain events. Returns a disposer. */
  subscribe(listener: (event: IntakeEvent) => void): () => void {
    return this.emitter.subscribe(listener);
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  async createIntake(input: CreateIntakeInput, ctx: IntakeContext): Promise<IntakeCreateResult> {
    const validated = this.guardValidation(() => validateCreateInput(input));
    if (validated.projectId !== ctx.projectId) {
      throw new IntakeAuthorizationError('create', ctx.id, validated.projectId);
    }
    await this.authorize('create', ctx);

    if (validated.idempotencyKey !== undefined && validated.idempotencyKey.trim().length > 0) {
      const existing = await this.store.findByIdempotencyKey(validated.idempotencyKey);
      if (existing) {
        if (existing.projectId !== ctx.projectId) {
          throw new IntakeValidationError([
            {
              field: 'idempotencyKey',
              message: 'idempotency key already used for a different project',
            },
          ]);
        }
        this.metrics.increment('intake.duplicate_create');
        this.logger.info('intake', 'intake.duplicate_create', {
          intakeId: existing.id,
          projectId: existing.projectId,
          actorId: ctx.id,
        });
        return { record: existing, created: false, idempotent: true };
      }
    }

    const now = Date.now();
    const record: RequirementIntakeRecord = this.buildNewRecord(validated, ctx, now);
    const result = await this.store.create(record, validated.idempotencyKey?.trim());
    this.logger.info('intake', 'intake.created', {
      intakeId: result.record.id,
      projectId: result.record.projectId,
      actorId: ctx.id,
    });
    this.metrics.increment('intake.created');
    this.emit('RequirementIntakeCreated', {
      intakeId: result.record.id,
      projectId: result.record.projectId,
      actorId: ctx.id,
      actorType: ctx.type,
      status: result.record.status,
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getIntake(id: string, ctx: IntakeContext): Promise<RequirementIntakeRecord | null> {
    const record = await this.store.load(id);
    if (!record) return null;
    await this.authorize('read', ctx, record);
    return record;
  }

  async listIntakes(
    projectId: string,
    ctx: IntakeContext,
    filter?: IntakeListFilter | undefined,
  ): Promise<RequirementIntakeRecord[]> {
    if (projectId !== ctx.projectId) {
      throw new IntakeAuthorizationError('list', ctx.id, projectId);
    }
    await this.authorize('list', ctx);
    return this.store.list(projectId, filter);
  }

  async pendingQuestions(id: string, ctx: IntakeContext): Promise<IntakeQuestion[]> {
    const record = await this.requireRecord(id, ctx, 'read');
    return pendingQuestions(record);
  }

  // -------------------------------------------------------------------------
  // Draft editing
  // -------------------------------------------------------------------------

  async updateIntake(
    id: string,
    patch: UpdateIntakeInput,
    ctx: IntakeContext,
    expectedVersion?: number | undefined,
  ): Promise<RequirementIntakeRecord> {
    const record = await this.requireRecord(id, ctx, 'update');
    this.assertMutable(record, 'updateIntake');
    const validated = this.guardValidation(() => validateUpdateInput(patch));

    const changedKeys = Object.keys(validated);
    if (changedKeys.length === 0) return record;

    if (validated.title !== undefined && validated.title.trim().length === 0) {
      throw new IntakeValidationError([{ field: 'title', message: 'title must not be blank' }]);
    }

    return this.store
      .update(id, this.updateMeta(ctx, 'updated', changedKeys, expectedVersion), (next) => {
        if (validated.title !== undefined) {
          next.title = validated.title.trim();
          next.fieldSources.title = 'user';
        }
        if (validated.requestType !== undefined) {
          next.requestType = normalizeRequestType(validated.requestType);
          next.fieldSources.request_type = 'user';
        }
        if (validated.priority !== undefined) {
          next.priority = validated.priority;
          next.fieldSources.priority = 'user';
        }
        applyOptionalString(next, 'businessGoal', validated.businessGoal);
        applyOptionalString(next, 'expectedOutcome', validated.expectedOutcome);
        applyOptionalString(next, 'scopeNotes', validated.scopeNotes);
        if (validated.targetUsers !== undefined) next.targetUsers = [...validated.targetUsers];
        if (validated.constraints !== undefined) next.constraints = [...validated.constraints];
        if (validated.providedContext !== undefined)
          next.providedContext = [...validated.providedContext];
        if (validated.metadata !== undefined) next.metadata = validated.metadata;
        markUserSources(next, changedKeys);
      })
      .then((updated) => {
        this.afterMutation(updated, ctx, 'RequirementIntakeUpdated');
        return updated;
      });
  }

  async addAnswer(
    id: string,
    input: AddAnswerInput,
    ctx: IntakeContext,
    expectedVersion?: number | undefined,
  ): Promise<RequirementIntakeRecord> {
    const record = await this.requireRecord(id, ctx, 'answer');
    this.assertMutable(record, 'addAnswer');
    const validated = this.guardValidation(() => validateAnswerInput(input));
    this.assertAnswerField(validated.field);

    return this.store
      .update(
        id,
        this.updateMeta(ctx, 'answer_added', [validated.field], expectedVersion),
        (next) => {
          const question = next.questions.find((candidate) => candidate.field === validated.field);
          const answer: IntakeAnswer = {
            id: `${ANSWER_ID_PREFIX}${ulid()}`,
            field: validated.field,
            question: validated.question ?? question?.question ?? validated.field,
            answer: validated.answer,
            source: 'user',
            answeredBy: ctx.id,
            answeredAt: Date.now(),
          };
          next.answers.push(answer);
          if (question && question.status === 'unanswered') {
            question.status = 'answered';
            question.answer = validated.answer;
          }
          ANSWER_FIELD_MAPPING[validated.field]?.set(next, validated.answer);
          if ((INTAKE_FIELDS as readonly string[]).includes(validated.field)) {
            next.fieldSources[validated.field as keyof RequirementIntakeRecord['fieldSources']] =
              'user';
          }
        },
      )
      .then((updated) => {
        this.afterMutation(updated, ctx, 'RequirementIntakeUpdated');
        return updated;
      });
  }

  async updateAnswer(
    id: string,
    answerId: string,
    patch: { answer: string },
    ctx: IntakeContext,
    expectedVersion?: number | undefined,
  ): Promise<RequirementIntakeRecord> {
    const record = await this.requireRecord(id, ctx, 'answer');
    this.assertMutable(record, 'updateAnswer');
    const validated = this.guardValidation(() =>
      validateAnswerInput({
        field: record.answers.find((a) => a.id === answerId)?.field ?? 'unknown',
        answer: patch.answer,
      }),
    );

    return this.store
      .update(id, this.updateMeta(ctx, 'answer_updated', [answerId], expectedVersion), (next) => {
        const answer = next.answers.find((candidate) => candidate.id === answerId);
        if (!answer) {
          throw new IntakeValidationError([
            { field: 'answerId', message: `answer not found: ${answerId}` },
          ]);
        }
        answer.answer = validated.answer;
        answer.answeredAt = Date.now();
        const question = next.questions.find((candidate) => candidate.field === answer.field);
        if (question) {
          question.answer = validated.answer;
          question.status = 'answered';
        }
      })
      .then((updated) => {
        this.afterMutation(updated, ctx, 'RequirementIntakeUpdated');
        return updated;
      });
  }

  async attachResource(
    id: string,
    input: AttachResourceInput,
    ctx: IntakeContext,
    expectedVersion?: number | undefined,
  ): Promise<RequirementIntakeRecord> {
    const record = await this.requireRecord(id, ctx, 'attach');
    this.assertMutable(record, 'attachResource');
    const validated = this.guardValidation(() => validateAttachResourceInput(input));
    const now = Date.now();

    if (validated.attachment !== undefined) {
      if (record.attachments.length >= MAX_ATTACHMENTS) {
        throw new IntakeValidationError([
          { field: 'attachments', message: `maximum of ${MAX_ATTACHMENTS} attachments reached` },
        ]);
      }
      return this.store
        .update(
          id,
          this.updateMeta(ctx, 'attachment_added', ['attachments'], expectedVersion),
          (next) => {
            const attachment: IntakeAttachment = {
              id: `${ATTACHMENT_ID_PREFIX}${ulid()}`,
              name: validated.attachment!.name,
              kind: validated.attachment!.kind,
              path: validated.attachment?.path,
              url: validated.attachment?.url,
              sizeBytes: validated.attachment?.sizeBytes,
              mimeType: validated.attachment?.mimeType,
              source: 'user',
              addedBy: ctx.id,
              addedAt: now,
            };
            next.attachments.push(attachment);
            next.fieldSources.attachments = 'user';
            markQuestionAnswered(next, 'attachments', attachment.name);
          },
        )
        .then((updated) => {
          this.afterMutation(updated, ctx, 'RequirementIntakeUpdated');
          return updated;
        });
    }

    if (record.relatedResources.length >= MAX_RELATED_RESOURCES) {
      throw new IntakeValidationError([
        {
          field: 'relatedResources',
          message: `maximum of ${MAX_RELATED_RESOURCES} related resources reached`,
        },
      ]);
    }
    return this.store
      .update(
        id,
        this.updateMeta(ctx, 'related_resource_added', ['related_resources'], expectedVersion),
        (next) => {
          const resource: RelatedResource = {
            id: `${RELATED_RESOURCE_ID_PREFIX}${ulid()}`,
            kind: validated.relatedResource!.kind,
            reference: validated.relatedResource!.reference,
            title: validated.relatedResource?.title,
            source: 'user',
            addedBy: ctx.id,
            addedAt: now,
          };
          next.relatedResources.push(resource);
          next.fieldSources.related_resources = 'user';
          markQuestionAnswered(next, 'related_resources', resource.reference);
        },
      )
      .then((updated) => {
        this.afterMutation(updated, ctx, 'RequirementIntakeUpdated');
        return updated;
      });
  }

  // -------------------------------------------------------------------------
  // LLM suggestions (always proposals)
  // -------------------------------------------------------------------------

  async generateSuggestions(
    id: string,
    ctx: IntakeContext,
    focus?: string[] | undefined,
  ): Promise<LlmSuggestionProposal[]> {
    const record = await this.requireRecord(id, ctx, 'suggest');
    this.assertMutable(record, 'generateSuggestions');
    if (!this.generator) {
      throw new IntakeSuggestionError('No LLM suggestion generator is configured on this service');
    }
    this.metrics.increment('intake.suggestions.requested');

    let output;
    try {
      output = await this.generator.generate({ record, focus });
    } catch (error) {
      this.metrics.increment('intake.suggestions.failed');
      this.logger.error('intake', 'intake.suggestions.failed', {
        intakeId: record.id,
        projectId: record.projectId,
        actorId: ctx.id,
      });
      throw new IntakeSuggestionError('LLM suggestion generation failed', { cause: error });
    }

    let proposals: LlmSuggestionProposal[];
    try {
      proposals = toProposals(validateLlmSuggestionOutput(output));
    } catch (error) {
      this.metrics.increment('intake.suggestions.failed');
      throw error instanceof IntakeSuggestionError
        ? error
        : new IntakeSuggestionError('LLM suggestion output could not be validated', {
            cause: error,
          });
    }
    if (proposals.length === 0) {
      this.metrics.increment('intake.suggestions.failed');
      throw new IntakeSuggestionError('LLM suggestion output contained no usable proposals');
    }

    const hadQuestions = proposals.some((proposal) => proposal.kind === 'question');
    const previousStatus = record.status;
    const nextStatus: IntakeStatus =
      previousStatus === 'draft' ? 'collecting_information' : previousStatus;

    const updated = await this.store.update(
      id,
      {
        actorId: ctx.id,
        actorType: ctx.type,
        action: hadQuestions ? 'information_requested' : 'suggestions_added',
        from: previousStatus === nextStatus ? undefined : previousStatus,
        to: previousStatus === nextStatus ? undefined : nextStatus,
      },
      (next) => {
        next.llmSuggestions.push(...proposals);
        if (next.llmSuggestions.length > MAX_SUGGESTIONS) {
          next.llmSuggestions = next.llmSuggestions.slice(
            next.llmSuggestions.length - MAX_SUGGESTIONS,
          );
        }
        if (previousStatus === 'draft' && nextStatus === 'collecting_information') {
          next.status = nextStatus;
        }
      },
    );

    this.metrics.increment('intake.suggestions.succeeded');
    this.logger.info('intake', 'intake.suggestions.succeeded', {
      intakeId: updated.id,
      projectId: updated.projectId,
      actorId: ctx.id,
      count: proposals.length,
    });
    this.emit(hadQuestions ? 'RequirementIntakeInformationRequested' : 'RequirementIntakeUpdated', {
      intakeId: updated.id,
      projectId: updated.projectId,
      actorId: ctx.id,
      actorType: ctx.type,
      previousStatus,
      status: updated.status,
    });
    return proposals;
  }

  async acceptSuggestion(
    id: string,
    proposalId: string,
    ctx: IntakeContext,
    expectedVersion?: number | undefined,
  ): Promise<RequirementIntakeRecord> {
    const record = await this.requireRecord(id, ctx, 'accept_suggestion');
    this.assertMutable(record, 'acceptSuggestion');
    const proposal = this.findSuggestion(record, proposalId);
    if (proposal.status !== 'pending') {
      throw new IntakeValidationError([
        { field: 'suggestionId', message: `suggestion is already ${proposal.status}` },
      ]);
    }

    return this.store
      .update(
        id,
        this.updateMeta(ctx, 'suggestion_accepted', [proposal.kind], expectedVersion),
        (next) => {
          const target = next.llmSuggestions.find((candidate) => candidate.id === proposalId);
          if (!target) {
            throw new IntakeValidationError([
              { field: 'suggestionId', message: `suggestion not found: ${proposalId}` },
            ]);
          }
          this.applyProposal(next, target);
          target.status = 'accepted';
          target.resolvedAt = Date.now();
        },
      )
      .then((updated) => {
        this.afterMutation(updated, ctx, 'RequirementIntakeUpdated');
        return updated;
      });
  }

  async rejectSuggestion(
    id: string,
    proposalId: string,
    ctx: IntakeContext,
    expectedVersion?: number | undefined,
  ): Promise<RequirementIntakeRecord> {
    const record = await this.requireRecord(id, ctx, 'reject_suggestion');
    this.assertMutable(record, 'rejectSuggestion');
    this.findSuggestion(record, proposalId);

    return this.store
      .update(
        id,
        this.updateMeta(ctx, 'suggestion_rejected', [proposalId], expectedVersion),
        (next) => {
          const target = next.llmSuggestions.find((candidate) => candidate.id === proposalId);
          if (!target) {
            throw new IntakeValidationError([
              { field: 'suggestionId', message: `suggestion not found: ${proposalId}` },
            ]);
          }
          if (target.status !== 'pending') {
            throw new IntakeValidationError([
              { field: 'suggestionId', message: `suggestion is already ${target.status}` },
            ]);
          }
          target.status = 'rejected';
          target.resolvedAt = Date.now();
        },
      )
      .then((updated) => {
        this.afterMutation(updated, ctx, 'RequirementIntakeUpdated');
        return updated;
      });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async submitIntake(
    id: string,
    ctx: IntakeContext,
    expectedVersion?: number | undefined,
  ): Promise<IntakeSubmitResult> {
    const record = await this.requireRecord(id, ctx, 'submit');
    if (record.status === 'submitted') {
      this.metrics.increment('intake.duplicate_submit');
      return { record, idempotent: true };
    }
    assertTransition(record.status, 'submitted');
    this.assertSubmitReady(record);

    const now = Date.now();
    try {
      const updated = await this.store.update(
        id,
        {
          actorId: ctx.id,
          actorType: ctx.type,
          action: 'submitted',
          from: record.status,
          to: 'submitted',
          expectedVersion: expectedVersion ?? record.version,
        },
        (next) => {
          next.status = 'submitted';
          next.submittedAt = now;
          next.submittedBy = ctx.id;
          next.submittedByType = ctx.type;
        },
      );

      this.metrics.increment('intake.submitted');
      this.metrics.recordDuration('intake.time_to_submit', now - updated.createdAt);
      this.logger.info('intake', 'intake.submitted', {
        intakeId: updated.id,
        projectId: updated.projectId,
        actorId: ctx.id,
      });
      this.emit('RequirementIntakeSubmitted', {
        intakeId: updated.id,
        projectId: updated.projectId,
        actorId: ctx.id,
        actorType: ctx.type,
        previousStatus: record.status,
        status: 'submitted',
      });
      return { record: updated, idempotent: false };
    } catch (error) {
      // A concurrent submit won the CAS race. Re-read: if the record is now
      // submitted, this is a safe duplicate — report it idempotently.
      if (error instanceof IntakeConflictError) {
        const latest = await this.store.load(id);
        if (latest && latest.status === 'submitted') {
          this.metrics.increment('intake.duplicate_submit');
          return { record: latest, idempotent: true };
        }
      }
      throw error;
    }
  }

  async cancelIntake(
    id: string,
    ctx: IntakeContext,
    reason?: string | undefined,
    expectedVersion?: number | undefined,
  ): Promise<RequirementIntakeRecord> {
    const record = await this.requireRecord(id, ctx, 'cancel');
    assertTransition(record.status, 'cancelled');

    const updated = await this.store.update(
      id,
      {
        actorId: ctx.id,
        actorType: ctx.type,
        action: 'cancelled',
        from: record.status,
        to: 'cancelled',
        expectedVersion,
      },
      (next) => {
        next.status = 'cancelled';
        next.cancelledAt = Date.now();
        next.cancelledReason = reason?.trim() || undefined;
      },
    );

    this.metrics.increment('intake.cancelled');
    this.logger.info('intake', 'intake.cancelled', {
      intakeId: updated.id,
      projectId: updated.projectId,
      actorId: ctx.id,
    });
    this.emit('RequirementIntakeCancelled', {
      intakeId: updated.id,
      projectId: updated.projectId,
      actorId: ctx.id,
      actorType: ctx.type,
      previousStatus: record.status,
      status: 'cancelled',
    });
    return updated;
  }

  async archiveIntake(
    id: string,
    ctx: IntakeContext,
    expectedVersion?: number | undefined,
  ): Promise<RequirementIntakeRecord> {
    const record = await this.requireRecord(id, ctx, 'archive');
    assertTransition(record.status, 'archived');

    const updated = await this.store.update(
      id,
      {
        actorId: ctx.id,
        actorType: ctx.type,
        action: 'archived',
        from: record.status,
        to: 'archived',
        expectedVersion,
      },
      (next) => {
        next.status = 'archived';
        next.archivedAt = Date.now();
      },
    );

    this.metrics.increment('intake.archived');
    this.logger.info('intake', 'intake.archived', {
      intakeId: updated.id,
      projectId: updated.projectId,
      actorId: ctx.id,
    });
    this.emit('RequirementIntakeArchived', {
      intakeId: updated.id,
      projectId: updated.projectId,
      actorId: ctx.id,
      actorType: ctx.type,
      previousStatus: record.status,
      status: 'archived',
    });
    return updated;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildNewRecord(
    input: CreateIntakeInput,
    ctx: IntakeContext,
    now: number,
  ): RequirementIntakeRecord {
    const titleProvided = input.title !== undefined && input.title.trim().length > 0;
    const title = titleProvided ? input.title!.trim() : deterministicTitle(input.originalRequest);
    const requestType = normalizeRequestType(input.requestType);
    const idempotencyKey = input.idempotencyKey?.trim();
    const attachments: IntakeAttachment[] = (input.attachments ?? []).map((attachment) => ({
      id: `${ATTACHMENT_ID_PREFIX}${ulid()}`,
      name: attachment.name,
      kind: attachment.kind,
      path: attachment.path,
      url: attachment.url,
      sizeBytes: attachment.sizeBytes,
      mimeType: attachment.mimeType,
      source: 'user',
      addedBy: ctx.id,
      addedAt: now,
    }));
    const relatedResources: RelatedResource[] = (input.relatedResources ?? []).map((resource) => ({
      id: `${RELATED_RESOURCE_ID_PREFIX}${ulid()}`,
      kind: resource.kind,
      reference: resource.reference,
      title: resource.title,
      source: 'user',
      addedBy: ctx.id,
      addedAt: now,
    }));

    return {
      id: newIntakeId(),
      projectId: input.projectId,
      title,
      originalRequest: input.originalRequest,
      normalizedSummary: deterministicSummary(input.originalRequest),
      requestType,
      status: 'draft',
      priority: input.priority ?? 'unspecified',
      requestedBy: input.requestedBy,
      ...(input.businessGoal !== undefined ? { businessGoal: input.businessGoal } : {}),
      targetUsers: [...(input.targetUsers ?? [])],
      ...(input.expectedOutcome !== undefined ? { expectedOutcome: input.expectedOutcome } : {}),
      ...(input.scopeNotes !== undefined ? { scopeNotes: input.scopeNotes } : {}),
      constraints: [...(input.constraints ?? [])],
      providedContext: [...(input.providedContext ?? [])],
      attachments,
      relatedResources,
      answers: [],
      questions: buildInitialQuestions(input, this.catalog),
      llmSuggestions: [],
      metadata: { ...(input.metadata ?? {}) },
      fieldSources: {
        ...(titleProvided ? { title: 'user' as const } : { title: 'deterministic' as const }),
        normalized_summary: 'deterministic',
        request_type: input.requestType !== undefined ? 'user' : 'deterministic',
        priority: input.priority !== undefined ? 'user' : 'deterministic',
        ...(input.businessGoal !== undefined ? { business_goal: 'user' as const } : {}),
        ...(input.targetUsers !== undefined ? { target_users: 'user' as const } : {}),
        ...(input.expectedOutcome !== undefined ? { expected_outcome: 'user' as const } : {}),
        ...(input.scopeNotes !== undefined ? { scope_notes: 'user' as const } : {}),
        ...(input.constraints !== undefined ? { constraints: 'user' as const } : {}),
        ...(input.providedContext !== undefined ? { provided_context: 'user' as const } : {}),
        ...(attachments.length > 0 ? { attachments: 'user' as const } : {}),
        ...(relatedResources.length > 0 ? { related_resources: 'user' as const } : {}),
      },
      ...(idempotencyKey !== undefined && idempotencyKey.length > 0 ? { idempotencyKey } : {}),
      version: 1,
      history: [{ at: now, actor: ctx.id, actorType: ctx.type, action: 'created' }],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async requireRecord(
    id: string,
    ctx: IntakeContext,
    operation: IntakeOperation,
  ): Promise<RequirementIntakeRecord> {
    const record = await this.store.load(id);
    if (!record) throw new IntakeNotFoundError(id);
    await this.authorize(operation, ctx, record);
    return record;
  }

  private async authorize(
    operation: IntakeOperation,
    ctx: IntakeContext,
    record?: RequirementIntakeRecord,
  ): Promise<void> {
    const allowed = await this.authorizer.isAllowed(operation, ctx, record);
    if (!allowed) {
      this.metrics.increment('intake.unauthorized_attempt');
      throw new IntakeAuthorizationError(operation, ctx.id, ctx.projectId);
    }
  }

  private assertMutable(record: RequirementIntakeRecord, action: string): void {
    if (!isMutableStatus(record.status)) {
      throw new IntakeStatusLockedError(record.id, record.status, action);
    }
  }

  private assertAnswerField(field: string): void {
    const catalogFields = new Set(this.catalog.map((template) => template.field));
    if (!catalogFields.has(field) && !(INTAKE_FIELDS as readonly string[]).includes(field)) {
      throw new IntakeValidationError([
        { field: 'field', message: `unknown intake field: ${field}` },
      ]);
    }
  }

  private assertSubmitReady(record: RequirementIntakeRecord): void {
    const issues: IntakeValidationIssue[] = [];
    if (record.originalRequest.trim().length === 0) {
      issues.push({ field: 'originalRequest', message: 'original request must not be empty' });
    }
    if (record.title.trim().length === 0) {
      issues.push({ field: 'title', message: 'title must not be empty' });
    }
    if (record.requestedBy.trim().length === 0) {
      issues.push({ field: 'requestedBy', message: 'requester must not be empty' });
    }
    if (record.projectId.trim().length === 0) {
      issues.push({ field: 'projectId', message: 'project must not be empty' });
    }
    if (issues.length > 0) {
      this.metrics.increment('intake.validation_failure');
      throw new IntakeValidationError(issues, 'Requirement intake is not ready for submission');
    }
  }

  private findSuggestion(
    record: RequirementIntakeRecord,
    proposalId: string,
  ): LlmSuggestionProposal {
    const proposal = record.llmSuggestions.find((candidate) => candidate.id === proposalId);
    if (!proposal) {
      throw new IntakeValidationError([
        { field: 'suggestionId', message: `suggestion not found: ${proposalId}` },
      ]);
    }
    return proposal;
  }

  private applyProposal(record: RequirementIntakeRecord, proposal: LlmSuggestionProposal): void {
    switch (proposal.kind) {
      case 'title': {
        const value = assertSuggestionString(proposal.value, 'title', MAX_TITLE_LENGTH);
        record.title = value;
        record.fieldSources.title = 'llm';
        break;
      }
      case 'summary': {
        const value = assertSuggestionString(
          proposal.value,
          'normalized_summary',
          MAX_SUMMARY_LENGTH,
        );
        record.normalizedSummary = value;
        record.fieldSources.normalized_summary = 'llm';
        break;
      }
      case 'request_type': {
        const value = normalizeRequestType(proposal.value);
        record.requestType = value;
        record.fieldSources.request_type = 'llm';
        break;
      }
      case 'priority': {
        const value = String(proposal.value).trim().toLowerCase();
        if ((INTAKE_PRIORITIES as readonly string[]).includes(value)) {
          record.priority = value as IntakePriority;
          record.fieldSources.priority = 'llm';
        }
        break;
      }
      case 'constraint': {
        const value = assertSuggestionString(proposal.value, 'constraint', MAX_STRING_FIELD_LENGTH);
        appendItems(record.constraints, value);
        record.fieldSources.constraints = 'llm';
        break;
      }
      case 'target_user': {
        const value = assertSuggestionString(
          proposal.value,
          'target_user',
          MAX_STRING_FIELD_LENGTH,
        );
        appendItems(record.targetUsers, value);
        record.fieldSources.target_users = 'llm';
        break;
      }
      case 'outcome': {
        const value = assertSuggestionString(proposal.value, 'outcome', MAX_STRING_FIELD_LENGTH);
        record.expectedOutcome = value;
        record.fieldSources.expected_outcome = 'llm';
        break;
      }
      case 'question': {
        const template = proposal.value as IntakeQuestionTemplate;
        if (
          typeof template === 'object' &&
          template !== null &&
          typeof (template as { field?: unknown }).field === 'string' &&
          typeof (template as { question?: unknown }).question === 'string'
        ) {
          upsertQuestion(record, {
            field: (template as { field: string }).field,
            question: (template as { question: string }).question,
            required: template.required,
          });
        }
        break;
      }
    }
  }

  private updateMeta(
    ctx: IntakeContext,
    action: string,
    fields: string[],
    expectedVersion?: number | undefined,
  ): StoreUpdateOptions {
    return {
      actorId: ctx.id,
      actorType: ctx.type,
      action,
      fields,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    };
  }

  private afterMutation(
    record: RequirementIntakeRecord,
    ctx: IntakeContext,
    event: IntakeEventName,
  ): void {
    this.logger.info('intake', 'intake.updated', {
      intakeId: record.id,
      projectId: record.projectId,
      actorId: ctx.id,
    });
    this.emit(event, {
      intakeId: record.id,
      projectId: record.projectId,
      actorId: ctx.id,
      actorType: ctx.type,
      status: record.status,
    });
  }

  private emit(event: IntakeEventName, data: Omit<IntakeEvent, 'event' | 'timestamp'>): void {
    this.emitter.emit(event, data);
  }

  private guardValidation<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof IntakeValidationError) {
        this.metrics.increment('intake.validation_failure');
      }
      throw error;
    }
  }
}

function applyOptionalString(
  record: RequirementIntakeRecord,
  field: 'businessGoal' | 'expectedOutcome' | 'scopeNotes',
  value: string | undefined,
): void {
  if (value === undefined) return;
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    delete record[field];
  } else {
    record[field] = trimmed;
  }
}

function markUserSources(record: RequirementIntakeRecord, changedKeys: string[]): void {
  const mapping: Readonly<Record<string, keyof RequirementIntakeRecord['fieldSources']>> = {
    title: 'title',
    requestType: 'request_type',
    priority: 'priority',
    businessGoal: 'business_goal',
    targetUsers: 'target_users',
    expectedOutcome: 'expected_outcome',
    scopeNotes: 'scope_notes',
    constraints: 'constraints',
    providedContext: 'provided_context',
  };
  for (const key of changedKeys) {
    const sourceField = mapping[key];
    if (sourceField) {
      record.fieldSources[sourceField] = 'user';
    }
  }
}

function markQuestionAnswered(record: RequirementIntakeRecord, field: string, value: string): void {
  const question = record.questions.find((candidate) => candidate.field === field);
  if (question && question.status === 'unanswered') {
    question.status = 'answered';
    question.answer = value;
  }
}
