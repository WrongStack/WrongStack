/**
 * Requirements Intake — LLM suggestion pipeline.
 *
 * LLM output is always treated as a *proposal*:
 *  1. returned in structured form,
 *  2. validated against a zod schema (malformed output is rejected),
 *  3. stored separately with `source: 'llm'`,
 *  4. never allowed to overwrite the original request,
 *  5. accept/reject is an explicit user decision,
 *  6. never controls persistence, authorization, or workflow state directly.
 */
import { z } from 'zod';
import { ulid } from '@wrongstack/core/utils';
import {
  INTAKE_PRIORITIES,
  MAX_ANSWER_LENGTH,
  MAX_ARRAY_ITEMS,
  MAX_QUESTION_LENGTH,
  MAX_STRING_FIELD_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  SUGGESTION_ID_PREFIX,
  type IntakePriority,
  type RequestType,
  type SuggestionKind,
} from './constants.js';
import { IntakeSuggestionError, IntakeValidationError } from './errors.js';
import type {
  IntakeQuestionTemplateInput,
  LlmSuggestionProposal,
  RequirementIntakeRecord,
} from './types.js';
import { normalizeRequestType } from './validation.js';

/** What the module hands to the host's LLM adapter. */
export interface LlmSuggestionRequest {
  record: RequirementIntakeRecord;
  /** Optional focus hint, e.g. ['title', 'questions']. */
  focus?: string[] | undefined;
}

/** Structured output contract for the LLM adapter. */
export interface LlmSuggestionOutput {
  suggested_title?: string | undefined;
  normalized_summary?: string | undefined;
  suggested_request_type?: string | undefined;
  suggested_priority?: string | undefined;
  extracted_constraints?: string[] | undefined;
  extracted_target_users?: string[] | undefined;
  suggested_outcome?: string | undefined;
  suggested_questions?: IntakeQuestionTemplateInput[] | undefined;
}

/** Host-provided LLM adapter. Must return structured output. */
export interface LlmSuggestionGenerator {
  generate(request: LlmSuggestionRequest): Promise<LlmSuggestionOutput>;
}

const outputQuestionSchema = z.object({
  field: z.string().trim().min(1).max(64),
  question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
  required: z.boolean().optional(),
});

const outputStringArraySchema = z
  .array(z.string().trim().min(1).max(MAX_STRING_FIELD_LENGTH))
  .max(MAX_ARRAY_ITEMS);

/** Schema for raw (untrusted) LLM output. */
export const llmSuggestionOutputSchema = z.object({
  suggested_title: z.string().trim().min(1).max(MAX_TITLE_LENGTH).optional(),
  normalized_summary: z.string().trim().min(1).max(MAX_SUMMARY_LENGTH).optional(),
  suggested_request_type: z.string().trim().min(1).max(64).optional(),
  suggested_priority: z.string().trim().min(1).max(32).optional(),
  extracted_constraints: outputStringArraySchema.optional(),
  extracted_target_users: outputStringArraySchema.optional(),
  suggested_outcome: z.string().trim().min(1).max(MAX_ANSWER_LENGTH).optional(),
  suggested_questions: z.array(outputQuestionSchema).max(20).optional(),
});

/** Validated + normalized LLM output ready for proposal conversion. */
export interface NormalizedLlmSuggestion {
  suggestedTitle?: string | undefined;
  normalizedSummary?: string | undefined;
  suggestedRequestType?: RequestType | undefined;
  suggestedPriority?: IntakePriority | undefined;
  extractedConstraints: string[];
  extractedTargetUsers: string[];
  suggestedOutcome?: string | undefined;
  suggestedQuestions: IntakeQuestionTemplateInput[];
}

/**
 * Validate raw LLM output. Throws `IntakeSuggestionError` when the shape is
 * malformed; unknown request-type/priority values are normalized, not kept.
 */
export function validateLlmSuggestionOutput(raw: unknown): NormalizedLlmSuggestion {
  const parsed = llmSuggestionOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw new IntakeSuggestionError(`Malformed LLM suggestion output: ${issues}`);
  }
  const value = parsed.data;
  const requestType = value.suggested_request_type
    ? normalizeRequestType(value.suggested_request_type)
    : undefined;
  const priority = value.suggested_priority
    ? (INTAKE_PRIORITIES as readonly string[]).includes(value.suggested_priority)
      ? (value.suggested_priority as IntakePriority)
      : undefined
    : undefined;
  return {
    suggestedTitle: value.suggested_title,
    normalizedSummary: value.normalized_summary,
    suggestedRequestType: requestType,
    suggestedPriority: priority,
    extractedConstraints: value.extracted_constraints ?? [],
    extractedTargetUsers: value.extracted_target_users ?? [],
    suggestedOutcome: value.suggested_outcome,
    suggestedQuestions: value.suggested_questions ?? [],
  };
}

function proposal(
  kind: SuggestionKind,
  field: string | undefined,
  value: unknown,
): LlmSuggestionProposal {
  return {
    id: `${SUGGESTION_ID_PREFIX}${ulid()}`,
    kind,
    field,
    value,
    status: 'pending',
    createdAt: Date.now(),
  };
}

/** Convert validated LLM output into pending proposals. */
export function toProposals(suggestion: NormalizedLlmSuggestion): LlmSuggestionProposal[] {
  const proposals: LlmSuggestionProposal[] = [];
  if (suggestion.suggestedTitle !== undefined) {
    proposals.push(proposal('title', 'title', suggestion.suggestedTitle));
  }
  if (suggestion.normalizedSummary !== undefined) {
    proposals.push(proposal('summary', 'normalized_summary', suggestion.normalizedSummary));
  }
  if (suggestion.suggestedRequestType !== undefined) {
    proposals.push(proposal('request_type', 'request_type', suggestion.suggestedRequestType));
  }
  if (suggestion.suggestedPriority !== undefined) {
    proposals.push(proposal('priority', 'priority', suggestion.suggestedPriority));
  }
  for (const constraint of suggestion.extractedConstraints) {
    proposals.push(proposal('constraint', 'constraints', constraint));
  }
  for (const targetUser of suggestion.extractedTargetUsers) {
    proposals.push(proposal('target_user', 'target_users', targetUser));
  }
  if (suggestion.suggestedOutcome !== undefined) {
    proposals.push(proposal('outcome', 'expected_outcome', suggestion.suggestedOutcome));
  }
  for (const question of suggestion.suggestedQuestions) {
    proposals.push(proposal('question', question.field, question));
  }
  return proposals;
}

/** Ensure a raw value is a non-blank string within a length bound. */
export function assertSuggestionString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new IntakeValidationError([
      { field: `suggestion.${label}`, message: `invalid ${label} suggestion value` },
    ]);
  }
  return value;
}
