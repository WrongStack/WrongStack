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
import {
  DEFAULT_INTAKE_QUESTIONS,
  INTAKE_FIELDS,
  MAX_SUGGESTIONS,
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
} from './errors.js';
import { IntakeEventEmitter } from './events.js';
import { isMutableStatus, assertTransition } from './lifecycle.js';
import { type IntakeLogger, NoopIntakeLogger } from './logger.js';
import { type IntakeMetrics, InMemoryIntakeMetrics } from './metrics.js';
import { pendingQuestions } from './questions.js';
import {
  type LlmSuggestionGenerator,
  toProposals,
  validateLlmSuggestionOutput,
} from './suggestions.js';
import type { RequirementIntakeStore, StoreUpdateOptions } from './store.js';
import type {
  AddAnswerInput,
  AttachResourceInput,
  CreateIntakeInput,
  IntakeContext,
  IntakeEvent,
  IntakeEventName,
  IntakeQuestion,
  LlmSuggestionProposal,
  RequirementIntakeRecord,
  UpdateIntakeInput,
} from './types.js';
import {
  normalizeRequestType,
  validateAnswerInput,
  validateAttachResourceInput,
  validateCreateInput,
  validateUpdateInput,
} from './validation.js';
import {
  applyAnswerToRecord,
  applyAnswerUpdateToRecord,
  applyAttachmentToRecord,
  applyOptionalString,
  applyRelatedResourceToRecord,
  applySuggestionProposal,
  assertIntakeSubmitReady,
  buildNewIntakeRecord,
  findSuggestionProposal,
  markUserSources,
} from './service-helpers.js';

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
        if (validated.isVibeMode !== undefined) next.isVibeMode = validated.isVibeMode;
        if (validated.vibeProtocol !== undefined) next.vibeProtocol = validated.vibeProtocol;
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
          applyAnswerToRecord(next, validated, ctx.id, Date.now());
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
        applyAnswerUpdateToRecord(next, answerId, validated.answer);
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
      return this.store
        .update(
          id,
          this.updateMeta(ctx, 'attachment_added', ['attachments'], expectedVersion),
          (next) => {
            applyAttachmentToRecord(next, validated, ctx.id, now);
          },
        )
        .then((updated) => {
          this.afterMutation(updated, ctx, 'RequirementIntakeUpdated');
          return updated;
        });
    }

    return this.store
      .update(
        id,
        this.updateMeta(ctx, 'related_resource_added', ['related_resources'], expectedVersion),
        (next) => {
          applyRelatedResourceToRecord(next, validated, ctx.id, now);
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
    return buildNewIntakeRecord(input, ctx, now, this.catalog);
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
    try {
      assertIntakeSubmitReady(record);
    } catch (error) {
      if (error instanceof IntakeValidationError) {
        this.metrics.increment('intake.validation_failure');
      }
      throw error;
    }
  }

  private findSuggestion(
    record: RequirementIntakeRecord,
    proposalId: string,
  ): LlmSuggestionProposal {
    return findSuggestionProposal(record, proposalId);
  }

  private applyProposal(record: RequirementIntakeRecord, proposal: LlmSuggestionProposal): void {
    applySuggestionProposal(record, proposal);
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
