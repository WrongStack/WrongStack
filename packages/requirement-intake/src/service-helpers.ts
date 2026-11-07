import { ulid } from '@wrongstack/core/utils';
import {
  ANSWER_ID_PREFIX,
  ATTACHMENT_ID_PREFIX,
  INTAKE_PRIORITIES,
  type IntakePriority,
  type IntakeQuestionTemplate,
  MAX_ANSWER_LENGTH,
  MAX_ARRAY_ITEMS,
  MAX_ATTACHMENTS,
  MAX_RELATED_RESOURCES,
  MAX_STRING_FIELD_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  RELATED_RESOURCE_ID_PREFIX,
} from './constants.js';
import { IntakeValidationError, type IntakeValidationIssue } from './errors.js';
import { buildInitialQuestions, upsertQuestion } from './questions.js';
import { newIntakeId } from './store.js';
import { assertSuggestionString } from './suggestions.js';
import type {
  AddAnswerInput,
  AttachResourceInput,
  CreateIntakeInput,
  IntakeAnswer,
  IntakeAttachment,
  IntakeContext,
  LlmSuggestionProposal,
  RelatedResource,
  RequirementIntakeRecord,
} from './types.js';
import { deterministicSummary, deterministicTitle, normalizeRequestType } from './validation.js';
import { deriveVibeState, hasVibeTag } from './vibe.js';

function splitItems(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function appendItems(target: string[], raw: string): void {
  for (const item of splitItems(raw)) {
    if (!target.includes(item) && target.length < MAX_ARRAY_ITEMS) {
      target.push(item);
    }
  }
}

/** Answer fields that also update a record property. */
export const ANSWER_FIELD_MAPPING: Readonly<
  Record<
    string,
    {
      set: (record: RequirementIntakeRecord, value: string) => void;
      /** The list an append-only answer feeds; an update takes its old items back out. */
      list?: (record: RequirementIntakeRecord) => string[];
      /** Canonical fieldSources key to mark as `'user'` when this answer applies. */
      sourceField?: keyof RequirementIntakeRecord['fieldSources'];
    }
  >
> = {
  business_goal: {
    set: (record, value) => {
      record.businessGoal = value;
    },
    sourceField: 'business_goal',
  },
  expected_outcome: {
    set: (record, value) => {
      record.expectedOutcome = value;
    },
    sourceField: 'expected_outcome',
  },
  scope_notes: {
    set: (record, value) => {
      record.scopeNotes = value;
    },
    sourceField: 'scope_notes',
  },
  description_scope: {
    set: (record, value) => {
      record.scopeNotes = value;
    },
    sourceField: 'scope_notes',
  },
  target_users: {
    set: (record, value) => {
      appendItems(record.targetUsers, value);
    },
    list: (record) => record.targetUsers,
    sourceField: 'target_users',
  },
  constraints: {
    set: (record, value) => {
      appendItems(record.constraints, value);
    },
    list: (record) => record.constraints,
    sourceField: 'constraints',
  },
  provided_context: {
    set: (record, value) => {
      appendItems(record.providedContext, value);
    },
    list: (record) => record.providedContext,
    sourceField: 'provided_context',
  },
  project_component: {
    set: (record, value) => {
      appendItems(record.providedContext, value);
    },
    list: (record) => record.providedContext,
    sourceField: 'provided_context',
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

export function buildNewIntakeRecord(
  input: CreateIntakeInput,
  ctx: IntakeContext,
  now: number,
  catalog: readonly IntakeQuestionTemplate[],
): RequirementIntakeRecord {
  const titleProvided = input.title !== undefined && input.title.trim().length > 0;
  const title = titleProvided ? input.title!.trim() : deterministicTitle(input.originalRequest);
  const requestType = normalizeRequestType(input.requestType);
  const idempotencyKey = input.idempotencyKey?.trim();
  const businessGoal = input.businessGoal?.trim();
  const expectedOutcome = input.expectedOutcome?.trim();
  const scopeNotes = input.scopeNotes?.trim();
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

  const initialVibeSeed = input.vibeProtocol
    ? input.isVibeMode
      ? { ...input.vibeProtocol, isVibeMode: true }
      : input.vibeProtocol
    : input.isVibeMode
      ? { isVibeMode: true, detectedAt: now, stage: 'synthesizer' as const }
      : undefined;
  const vibeState = deriveVibeState(input.originalRequest, initialVibeSeed, now);

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
    ...(vibeState ? { isVibeMode: true, vibeProtocol: vibeState } : {}),
    ...(businessGoal ? { businessGoal } : {}),
    targetUsers: [...(input.targetUsers ?? [])],
    ...(expectedOutcome ? { expectedOutcome } : {}),
    ...(scopeNotes ? { scopeNotes } : {}),
    constraints: [...(input.constraints ?? [])],
    providedContext: [...(input.providedContext ?? [])],
    attachments,
    relatedResources,
    answers: [],
    questions: buildInitialQuestions(input, catalog),
    llmSuggestions: [],
    metadata: { ...(input.metadata ?? {}) },
    fieldSources: {
      ...(titleProvided ? { title: 'user' as const } : { title: 'deterministic' as const }),
      normalized_summary: 'deterministic',
      request_type: input.requestType !== undefined ? 'user' : 'deterministic',
      priority: input.priority !== undefined ? 'user' : 'deterministic',
      ...(businessGoal ? { business_goal: 'user' as const } : {}),
      ...(input.targetUsers !== undefined ? { target_users: 'user' as const } : {}),
      ...(expectedOutcome ? { expected_outcome: 'user' as const } : {}),
      ...(scopeNotes ? { scope_notes: 'user' as const } : {}),
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

export function assertIntakeSubmitReady(record: RequirementIntakeRecord): void {
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
    throw new IntakeValidationError(issues, 'Requirement intake is not ready for submission');
  }
}

export function findSuggestionProposal(
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

export function applySuggestionProposal(
  record: RequirementIntakeRecord,
  proposal: LlmSuggestionProposal,
): void {
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
        if (value !== 'unspecified') {
          markQuestionAnswered(record, 'priority', value);
        }
      }
      break;
    }
    case 'constraint': {
      const value = assertSuggestionString(proposal.value, 'constraint', MAX_STRING_FIELD_LENGTH);
      appendItems(record.constraints, value);
      record.fieldSources.constraints = 'llm';
      markQuestionAnswered(record, 'constraints', value);
      break;
    }
    case 'target_user': {
      const value = assertSuggestionString(proposal.value, 'target_user', MAX_STRING_FIELD_LENGTH);
      appendItems(record.targetUsers, value);
      record.fieldSources.target_users = 'llm';
      markQuestionAnswered(record, 'target_users', value);
      break;
    }
    case 'outcome': {
      const value = assertSuggestionString(proposal.value, 'outcome', MAX_ANSWER_LENGTH);
      record.expectedOutcome = value;
      record.fieldSources.expected_outcome = 'llm';
      markQuestionAnswered(record, 'expected_outcome', value);
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
          required: typeof template.required === 'boolean' ? template.required : false,
        });
      }
      break;
    }
  }
}

export function applyOptionalString(
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

export function markUserSources(record: RequirementIntakeRecord, changedKeys: string[]): void {
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
      const clearedOptional =
        (key === 'businessGoal' || key === 'expectedOutcome' || key === 'scopeNotes') &&
        record[key] === undefined;
      const clearedArray =
        (key === 'targetUsers' || key === 'constraints' || key === 'providedContext') &&
        record[key].length === 0;
      if (clearedOptional || clearedArray) {
        delete record.fieldSources[sourceField];
      } else {
        record.fieldSources[sourceField] = 'user';
      }
    }
  }
}

export function markQuestionAnswered(
  record: RequirementIntakeRecord,
  field: string,
  value: string,
): void {
  const question = record.questions.find((candidate) => candidate.field === field);
  if (question && (question.status === 'unanswered' || question.status === 'answered')) {
    question.status = 'answered';
    question.answer = value;
  }
}

export function reopenQuestionIfEmpty(record: RequirementIntakeRecord, field: string): void {
  const question = record.questions.find((candidate) => candidate.field === field);
  if (!question) return;
  const latestAnswer = [...record.answers].reverse().find((candidate) => candidate.field === field);
  if (latestAnswer) {
    if (field === 'priority') {
      const normalized = latestAnswer.answer.trim().toLowerCase();
      if (
        !(INTAKE_PRIORITIES as readonly string[]).includes(normalized) ||
        normalized === 'unspecified'
      ) {
        question.status = 'unanswered';
        delete question.answer;
        return;
      }
    }
    question.status = 'answered';
    question.answer = latestAnswer.answer;
    return;
  }
  question.status = 'unanswered';
  delete question.answer;
}

function isConcretePriorityAnswer(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    (INTAKE_PRIORITIES as readonly string[]).includes(normalized) && normalized !== 'unspecified'
  );
}

function syncVibeFromAnswer(
  record: RequirementIntakeRecord,
  answerText: string,
  now: number,
): void {
  if (
    record.isVibeMode === true ||
    record.vibeProtocol?.isVibeMode === true ||
    hasVibeTag(answerText)
  ) {
    record.isVibeMode = true;
    record.vibeProtocol = deriveVibeState(
      answerText,
      record.vibeProtocol ? { ...record.vibeProtocol, isVibeMode: true } : undefined,
      now,
    );
  }
}

export function applyAnswerToRecord(
  record: RequirementIntakeRecord,
  validated: AddAnswerInput,
  actorId: string,
  now: number,
): IntakeAnswer {
  const matchingQuestion = record.questions.find(
    (candidate) => candidate.field === validated.field,
  );
  const answer: IntakeAnswer = {
    id: `${ANSWER_ID_PREFIX}${ulid()}`,
    field: validated.field,
    question: validated.question ?? matchingQuestion?.question ?? validated.field,
    answer: validated.answer,
    answeredBy: actorId,
    answeredAt: now,
    source: 'user',
  };
  record.answers.push(answer);
  if (validated.field !== 'priority' || isConcretePriorityAnswer(validated.answer)) {
    markQuestionAnswered(record, validated.field, validated.answer);
  }
  syncVibeFromAnswer(record, validated.answer, now);
  const mapping = ANSWER_FIELD_MAPPING[validated.field];
  if (mapping) {
    const before = mapping.list?.(record).slice();
    mapping.set(record, validated.answer);
    if (before) {
      // Record what this answer introduced so a later update withdraws only
      // its own contribution, never items the create input already supplied.
      answer.contributedItems = splitItems(validated.answer).filter(
        (item) => !before.includes(item),
      );
    }
    if (mapping.sourceField) {
      record.fieldSources[mapping.sourceField] = 'user';
    }
  }
  return answer;
}

export function applyAnswerUpdateToRecord(
  record: RequirementIntakeRecord,
  answerId: string,
  newAnswer: string,
): void {
  const answer = record.answers.find((candidate) => candidate.id === answerId);
  if (!answer) {
    throw new IntakeValidationError([
      { field: 'answerId', message: `answer not found: ${answerId}` },
    ]);
  }
  const now = Date.now();
  const previous = answer.answer;
  answer.answer = newAnswer;
  answer.answeredAt = now;
  const latestForField =
    [...record.answers].reverse().find((candidate) => candidate.field === answer.field) ?? answer;
  const question = record.questions.find((candidate) => candidate.field === answer.field);
  if (question) {
    if (answer.field === 'priority' && !isConcretePriorityAnswer(latestForField.answer)) {
      if (record.priority === 'unspecified') {
        question.status = 'unanswered';
        delete question.answer;
      }
    } else {
      question.answer = latestForField.answer;
      question.status = 'answered';
    }
  }
  syncVibeFromAnswer(record, newAnswer, now);
  const mapping = ANSWER_FIELD_MAPPING[answer.field];
  const list = mapping?.list?.(record);
  let contribution: string[] | undefined;
  if (list) {
    // Withdraw only what this answer itself introduced. Items shared with the
    // create input or still given by another answer must survive the edit.
    // Answers recorded before `contributedItems` existed fall back to their
    // full previous text (the historical behavior).
    const contributed = answer.contributedItems ?? splitItems(previous);
    const kept = new Set(splitItems(newAnswer));
    const otherAnswers = record.answers.filter(
      (other) => other !== answer && ANSWER_FIELD_MAPPING[other.field]?.list?.(record) === list,
    );
    const stillGiven = new Set(otherAnswers.flatMap((other) => splitItems(other.answer)));
    for (const item of contributed) {
      if (kept.has(item)) continue;
      const at = list.indexOf(item);
      if (at >= 0 && !stillGiven.has(item)) {
        list.splice(at, 1);
      } else if (stillGiven.has(item)) {
        const successor = otherAnswers.find((other) => splitItems(other.answer).includes(item));
        if (successor) {
          const existing = successor.contributedItems ?? [];
          if (!existing.includes(item)) {
            successor.contributedItems = [...existing, item];
          }
        }
      }
    }
    const introduced = splitItems(newAnswer).filter((item) => !list.includes(item));
    contribution = [...new Set([...contributed.filter((item) => kept.has(item)), ...introduced])];
  }
  if (mapping) {
    mapping.set(record, list ? newAnswer : latestForField.answer);
    if (contribution) answer.contributedItems = contribution;
    if (mapping.sourceField) {
      record.fieldSources[mapping.sourceField] = 'user';
    }
  }
}

export function applyAttachmentToRecord(
  record: RequirementIntakeRecord,
  validated: AttachResourceInput,
  actorId: string,
  now: number,
): IntakeAttachment {
  if (record.attachments.length >= MAX_ATTACHMENTS) {
    throw new IntakeValidationError([
      { field: 'attachments', message: `maximum of ${MAX_ATTACHMENTS} attachments reached` },
    ]);
  }
  const attachment: IntakeAttachment = {
    id: `${ATTACHMENT_ID_PREFIX}${ulid()}`,
    name: validated.attachment!.name,
    kind: validated.attachment!.kind,
    path: validated.attachment?.path,
    url: validated.attachment?.url,
    sizeBytes: validated.attachment?.sizeBytes,
    mimeType: validated.attachment?.mimeType,
    source: 'user',
    addedBy: actorId,
    addedAt: now,
  };
  record.attachments.push(attachment);
  record.fieldSources.attachments = 'user';
  markQuestionAnswered(record, 'attachments', attachment.name);
  return attachment;
}

export function applyRelatedResourceToRecord(
  record: RequirementIntakeRecord,
  validated: AttachResourceInput,
  actorId: string,
  now: number,
): RelatedResource {
  if (record.relatedResources.length >= MAX_RELATED_RESOURCES) {
    throw new IntakeValidationError([
      {
        field: 'relatedResources',
        message: `maximum of ${MAX_RELATED_RESOURCES} related resources reached`,
      },
    ]);
  }
  const resource: RelatedResource = {
    id: `${RELATED_RESOURCE_ID_PREFIX}${ulid()}`,
    kind: validated.relatedResource!.kind,
    reference: validated.relatedResource!.reference,
    title: validated.relatedResource?.title,
    source: 'user',
    addedBy: actorId,
    addedAt: now,
  };
  record.relatedResources.push(resource);
  record.fieldSources.related_resources = 'user';
  markQuestionAnswered(record, 'related_resources', resource.reference);
  return resource;
}
