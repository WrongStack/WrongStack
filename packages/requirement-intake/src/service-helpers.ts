import { ulid } from '@wrongstack/core/utils';
import {
  ANSWER_ID_PREFIX,
  ATTACHMENT_ID_PREFIX,
  INTAKE_PRIORITIES,
  MAX_ARRAY_ITEMS,
  MAX_ATTACHMENTS,
  MAX_RELATED_RESOURCES,
  MAX_STRING_FIELD_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  RELATED_RESOURCE_ID_PREFIX,
  type IntakePriority,
  type IntakeQuestionTemplate,
} from './constants.js';
import { IntakeValidationError, type IntakeValidationIssue } from './errors.js';
import { buildInitialQuestions, upsertQuestion } from './questions.js';
import { assertSuggestionString } from './suggestions.js';
import { newIntakeId } from './store.js';
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
import { deriveVibeState } from './vibe.js';

export function appendItems(target: string[], raw: string): void {
  const items = raw
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  for (const item of items) {
    if (!target.includes(item) && target.length < MAX_ARRAY_ITEMS) {
      target.push(item);
    }
  }
}

/** Answer fields that also update a record property. */
export const ANSWER_FIELD_MAPPING: Readonly<
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

  const vibeState = deriveVibeState(
    input.originalRequest,
    input.vibeProtocol ??
      (input.isVibeMode ? { isVibeMode: true, detectedAt: now, stage: 'synthesizer' } : undefined),
    now,
  );

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
    ...(input.businessGoal !== undefined ? { businessGoal: input.businessGoal } : {}),
    targetUsers: [...(input.targetUsers ?? [])],
    ...(input.expectedOutcome !== undefined ? { expectedOutcome: input.expectedOutcome } : {}),
    ...(input.scopeNotes !== undefined ? { scopeNotes: input.scopeNotes } : {}),
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
      const value = assertSuggestionString(proposal.value, 'target_user', MAX_STRING_FIELD_LENGTH);
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
      record.fieldSources[sourceField] = 'user';
    }
  }
}

export function markQuestionAnswered(
  record: RequirementIntakeRecord,
  field: string,
  value: string,
): void {
  const question = record.questions.find((candidate) => candidate.field === field);
  if (question && question.status === 'unanswered') {
    question.status = 'answered';
    question.answer = value;
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
  markQuestionAnswered(record, validated.field, validated.answer);
  const mapping = ANSWER_FIELD_MAPPING[validated.field];
  if (mapping) {
    mapping.set(record, validated.answer);
    const sourceKey = validated.field as keyof RequirementIntakeRecord['fieldSources'];
    record.fieldSources[sourceKey] = 'user';
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
  answer.answer = newAnswer;
  answer.answeredAt = Date.now();
  const question = record.questions.find((candidate) => candidate.field === answer.field);
  if (question) {
    question.answer = newAnswer;
    question.status = 'answered';
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
