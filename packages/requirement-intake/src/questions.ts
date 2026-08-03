/**
 * Requirements Intake — question selection.
 *
 * Deterministic rules decide which intake questions to ask:
 *  - questions whose field was already provided at creation are skipped;
 *  - questions whose field is already answerable from existing project data
 *    (passed as `knownFields`) are skipped;
 *  - `description_scope` is always skipped because the original request
 *    itself answers "what should be changed or created?".
 *
 * Never re-ask for information that is already present on the record.
 */
import { ulid } from '@wrongstack/core/utils';
import {
  DEFAULT_INTAKE_QUESTIONS,
  QUESTION_ID_PREFIX,
  type IntakeQuestionTemplate,
} from './constants.js';
import type { CreateIntakeInput, IntakeQuestion, RequirementIntakeRecord } from './types.js';

/** Catalog fields that map to a create-input property directly. */
const FIELD_TO_INPUT_PROPERTY: Readonly<Record<string, (input: CreateIntakeInput) => boolean>> = {
  description_scope: () => true, // always answered by the original request
  business_goal: (input) =>
    input.businessGoal !== undefined && input.businessGoal.trim().length > 0,
  target_users: (input) => (input.targetUsers?.length ?? 0) > 0,
  expected_outcome: (input) =>
    input.expectedOutcome !== undefined && input.expectedOutcome.trim().length > 0,
  project_component: (input) => (input.providedContext?.length ?? 0) > 0,
  constraints: (input) => (input.constraints?.length ?? 0) > 0,
  related_resources: (input) => (input.relatedResources?.length ?? 0) > 0,
  priority: (input) => input.priority !== undefined && input.priority !== 'unspecified',
  attachments: (input) => (input.attachments?.length ?? 0) > 0,
};

function makeQuestion(
  template: IntakeQuestionTemplate,
  order: number,
  skipped: boolean,
): IntakeQuestion {
  return {
    id: `${QUESTION_ID_PREFIX}${ulid()}`,
    field: template.field,
    question: template.question,
    required: template.required,
    status: skipped ? 'skipped' : 'unanswered',
    order,
  };
}

/**
 * Build the initial question set for a new record. Skipped questions are
 * retained with status `skipped` so the record documents why they were never
 * asked; `pendingQuestions()` only surfaces unanswered ones.
 */
export function buildInitialQuestions(
  input: CreateIntakeInput,
  catalog: readonly IntakeQuestionTemplate[] = DEFAULT_INTAKE_QUESTIONS,
): IntakeQuestion[] {
  const known = new Set((input.knownFields ?? []).map((field) => field.trim()));
  return catalog.map((template, index) => {
    const answeredByInput = FIELD_TO_INPUT_PROPERTY[template.field]?.(input) ?? false;
    const skipped = answeredByInput || known.has(template.field);
    return makeQuestion(template, index, skipped);
  });
}

/** Questions still awaiting an answer on a record. */
export function pendingQuestions(record: RequirementIntakeRecord): IntakeQuestion[] {
  return record.questions
    .filter((question) => question.status === 'unanswered')
    .sort((a, b) => a.order - b.order);
}

/** Merge a question template into a record's question list (no duplicates). */
export function upsertQuestion(
  record: RequirementIntakeRecord,
  template: IntakeQuestionTemplate,
): boolean {
  const existing = record.questions.find(
    (question) => question.field === template.field && question.status !== 'skipped',
  );
  if (existing) return false;
  record.questions.push(makeQuestion(template, record.questions.length, false));
  return true;
}
