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
import type { IntakeAuthorizer, IntakeOperation } from './authorization.js';
import {
  DEFAULT_INTAKE_QUESTIONS,
  INTAKE_FIELDS,
  type IntakeQuestionTemplate,
  type IntakeStatus,
} from './constants.js';
import {
  IntakeAuthorizationError,
  IntakeNotFoundError,
  IntakeStatusLockedError,
  IntakeValidationError,
} from './errors.js';
import { IntakeEventEmitter } from './events.js';
import { isMutableStatus } from './lifecycle.js';
import { type IntakeLogger, NoopIntakeLogger } from './logger.js';
import { InMemoryIntakeMetrics, type IntakeMetrics } from './metrics.js';
import { pendingQuestions } from './questions.js';
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
  markQuestionAnswered,
  markUserSources,
  reopenQuestionIfEmpty,
} from './service-helpers.js';
import {
  closeIntake as closeIntakeWithHost,
  type IntakeLifecycleHost,
  type IntakeSubmitResult,
  submitIntake as submitIntakeWithHost,
} from './service-lifecycle.js';

export type { IntakeSubmitResult } from './service-lifecycle.js';

import {
  acceptSuggestion as acceptSuggestionFromHost,
  generateSuggestions as generateSuggestionsFromHost,
  type IntakeSuggestionsHost,
  rejectSuggestion as rejectSuggestionFromHost,
} from './service-suggestions.js';
import type { RequirementIntakeStore, StoreUpdateOptions } from './store.js';
import type { LlmSuggestionGenerator } from './suggestions.js';
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
import { deriveVibeState, hasVibeTag } from './vibe.js';
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
      this.denyUnauthorized('create', ctx, validated.projectId);
    }
    await this.authorize('create', ctx);

    if (validated.idempotencyKey !== undefined && validated.idempotencyKey.trim().length > 0) {
      const existing = await this.store.findByIdempotencyKey(validated.idempotencyKey);
      if (existing) {
        if (existing.projectId !== ctx.projectId) {
          this.recordUnauthorizedAttempt();
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
    // The preflight lookup above is only a fast path. Another process can win
    // the idempotency-key lock between that lookup and create(), so classify
    // the store's authoritative result here as well. Recheck project ownership
    // before returning the winner: concurrent reuse across projects must not
    // expose the record that happened to be created first.
    if (!result.created) {
      if (result.record.projectId !== ctx.projectId) {
        this.recordUnauthorizedAttempt();
        throw new IntakeValidationError([
          {
            field: 'idempotencyKey',
            message: 'idempotency key already used for a different project',
          },
        ]);
      }
      this.metrics.increment('intake.duplicate_create');
      this.logger.info('intake', 'intake.duplicate_create', {
        intakeId: result.record.id,
        projectId: result.record.projectId,
        actorId: ctx.id,
      });
      return result;
    }
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
      this.denyUnauthorized('list', ctx, projectId);
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

    const changedKeys = Object.keys(validated).filter(
      (key) => validated[key as keyof UpdateIntakeInput] !== undefined,
    );
    if (changedKeys.length === 0) return record;

    if (validated.title !== undefined && validated.title.trim().length === 0) {
      throw new IntakeValidationError([{ field: 'title', message: 'title must not be blank' }]);
    }

    return this.store
      .update(id, this.updateMeta(ctx, 'updated', changedKeys, expectedVersion), (next) => {
        this.assertMutable(next, 'updateIntake');
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
          if (validated.priority !== 'unspecified') {
            markQuestionAnswered(next, 'priority', validated.priority);
          } else {
            reopenQuestionIfEmpty(next, 'priority');
          }
        }
        applyOptionalString(next, 'businessGoal', validated.businessGoal);
        if (validated.businessGoal !== undefined) {
          if (next.businessGoal !== undefined) {
            markQuestionAnswered(next, 'business_goal', next.businessGoal);
          } else {
            reopenQuestionIfEmpty(next, 'business_goal');
          }
        }
        applyOptionalString(next, 'expectedOutcome', validated.expectedOutcome);
        if (validated.expectedOutcome !== undefined) {
          if (next.expectedOutcome !== undefined) {
            markQuestionAnswered(next, 'expected_outcome', next.expectedOutcome);
          } else {
            reopenQuestionIfEmpty(next, 'expected_outcome');
          }
        }
        applyOptionalString(next, 'scopeNotes', validated.scopeNotes);
        if (validated.scopeNotes !== undefined) {
          if (next.scopeNotes !== undefined) {
            markQuestionAnswered(next, 'scope_notes', next.scopeNotes);
          } else {
            reopenQuestionIfEmpty(next, 'scope_notes');
          }
        }
        if (validated.targetUsers !== undefined) {
          next.targetUsers = [...validated.targetUsers];
          if (next.targetUsers.length > 0) {
            markQuestionAnswered(next, 'target_users', next.targetUsers.join(', '));
          } else {
            reopenQuestionIfEmpty(next, 'target_users');
          }
        }
        if (validated.constraints !== undefined) {
          next.constraints = [...validated.constraints];
          if (next.constraints.length > 0) {
            markQuestionAnswered(next, 'constraints', next.constraints.join(', '));
          } else {
            reopenQuestionIfEmpty(next, 'constraints');
          }
        }
        if (validated.providedContext !== undefined) {
          next.providedContext = [...validated.providedContext];
          if (next.providedContext.length > 0) {
            const joined = next.providedContext.join(', ');
            markQuestionAnswered(next, 'provided_context', joined);
            markQuestionAnswered(next, 'project_component', joined);
          } else {
            reopenQuestionIfEmpty(next, 'provided_context');
            reopenQuestionIfEmpty(next, 'project_component');
          }
        }
        if (validated.metadata !== undefined) next.metadata = validated.metadata;
        const wasVibeLocked = next.isVibeMode === true || next.vibeProtocol?.isVibeMode === true;
        const textTriggersVibe =
          hasVibeTag(validated.title) ||
          hasVibeTag(validated.businessGoal) ||
          hasVibeTag(validated.expectedOutcome) ||
          hasVibeTag(validated.scopeNotes);
        if (validated.vibeProtocol !== undefined) {
          next.vibeProtocol = wasVibeLocked
            ? { ...validated.vibeProtocol, isVibeMode: true }
            : validated.vibeProtocol;
        }
        if (
          wasVibeLocked ||
          validated.isVibeMode === true ||
          next.vibeProtocol?.isVibeMode === true ||
          textTriggersVibe
        ) {
          next.isVibeMode = true;
          next.vibeProtocol = deriveVibeState(
            [
              next.originalRequest,
              validated.title,
              validated.businessGoal,
              validated.expectedOutcome,
              validated.scopeNotes,
            ]
              .filter((part): part is string => typeof part === 'string')
              .join(' '),
            next.vibeProtocol
              ? { ...next.vibeProtocol, isVibeMode: true }
              : { isVibeMode: true, detectedAt: Date.now(), stage: 'synthesizer' },
          );
        } else if (validated.isVibeMode !== undefined) {
          next.isVibeMode = validated.isVibeMode;
        }
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
    this.assertAnswerField(record, validated.field);

    return this.store
      .update(
        id,
        this.updateMeta(ctx, 'answer_added', [validated.field], expectedVersion),
        (next) => {
          this.assertMutable(next, 'addAnswer');
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
        this.assertMutable(next, 'updateAnswer');
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
            this.assertMutable(next, 'attachResource');
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
          this.assertMutable(next, 'attachResource');
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
    return generateSuggestionsFromHost(this.intakeSuggestionsHost(), id, ctx, focus);
  }

  async acceptSuggestion(
    id: string,
    proposalId: string,
    ctx: IntakeContext,
    expectedVersion?: number | undefined,
  ): Promise<RequirementIntakeRecord> {
    return acceptSuggestionFromHost(
      this.intakeSuggestionsHost(),
      id,
      proposalId,
      ctx,
      expectedVersion,
    );
  }

  async rejectSuggestion(
    id: string,
    proposalId: string,
    ctx: IntakeContext,
    expectedVersion?: number | undefined,
  ): Promise<RequirementIntakeRecord> {
    return rejectSuggestionFromHost(
      this.intakeSuggestionsHost(),
      id,
      proposalId,
      ctx,
      expectedVersion,
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async submitIntake(
    id: string,
    ctx: IntakeContext,
    expectedVersion?: number | undefined,
  ): Promise<IntakeSubmitResult> {
    return submitIntakeWithHost(this.intakeLifecycleHost(), id, ctx, expectedVersion);
  }

  async cancelIntake(
    id: string,
    ctx: IntakeContext,
    reason?: string | undefined,
    expectedVersion?: number | undefined,
  ): Promise<RequirementIntakeRecord> {
    return closeIntakeWithHost(this.intakeLifecycleHost(), id, ctx, 'cancelled', {
      reason,
      expectedVersion,
    });
  }

  async archiveIntake(
    id: string,
    ctx: IntakeContext,
    expectedVersion?: number | undefined,
  ): Promise<RequirementIntakeRecord> {
    return closeIntakeWithHost(this.intakeLifecycleHost(), id, ctx, 'archived', {
      expectedVersion,
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildNewRecord(
    input: CreateIntakeInput,
    ctx: IntakeContext,
    now: number,
  ): RequirementIntakeRecord {
    const catalog = input.questions?.map((question) => ({
      ...question,
      required: question.required ?? false,
    }));
    return buildNewIntakeRecord(input, ctx, now, catalog ?? this.catalog);
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
      this.denyUnauthorized(operation, ctx, ctx.projectId);
    }
  }

  private denyUnauthorized(
    operation: IntakeOperation,
    ctx: IntakeContext,
    projectId: string,
  ): never {
    this.recordUnauthorizedAttempt();
    throw new IntakeAuthorizationError(operation, ctx.id, projectId);
  }

  private recordUnauthorizedAttempt(): void {
    this.metrics.increment('intake.unauthorized_attempt');
  }

  private assertMutable(record: RequirementIntakeRecord, action: string): void {
    if (!isMutableStatus(record.status)) {
      throw new IntakeStatusLockedError(record.id, record.status, action);
    }
  }

  private assertAnswerField(record: RequirementIntakeRecord, field: string): void {
    const catalogFields = new Set(this.catalog.map((template) => template.field));
    const recordHasField = record.questions.some((question) => question.field === field);
    if (
      !recordHasField &&
      !catalogFields.has(field) &&
      !(INTAKE_FIELDS as readonly string[]).includes(field)
    ) {
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

  private intakeLifecycleHost(): IntakeLifecycleHost {
    // Check the complete helper contract while preserving the owner's identity and receivers.
    void ({
      requireRecord: this.requireRecord,
      assertSubmitReady: this.assertSubmitReady,
      metrics: this.metrics,
      logger: this.logger,
      store: this.store,
      emit: this.emit,
    } satisfies IntakeLifecycleHost);
    return this as unknown as IntakeLifecycleHost;
  }

  private intakeSuggestionsHost(): IntakeSuggestionsHost {
    // Check the complete helper contract while preserving the owner's identity and receivers.
    void ({
      requireRecord: this.requireRecord,
      assertMutable: this.assertMutable,
      generator: this.generator,
      metrics: this.metrics,
      logger: this.logger,
      store: this.store,
      emit: this.emit,
      findSuggestion: this.findSuggestion,
      updateMeta: this.updateMeta,
      applyProposal: this.applyProposal,
      afterMutation: this.afterMutation,
    } satisfies IntakeSuggestionsHost);
    return this as unknown as IntakeSuggestionsHost;
  }
}
