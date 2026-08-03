/**
 * Requirements Intake — domain constants.
 *
 * Deterministic enums and size limits. The authoritative request-type and
 * status values live here; unknown values are normalized (see validation.ts)
 * and never persisted as uncontrolled strings.
 */

export const INTAKE_ID_PREFIX = 'reqi_';
export const ANSWER_ID_PREFIX = 'ans_';
export const ATTACHMENT_ID_PREFIX = 'attach_';
export const RELATED_RESOURCE_ID_PREFIX = 'relres_';
export const QUESTION_ID_PREFIX = 'q_';
export const SUGGESTION_ID_PREFIX = 'sug_';

/**
 * Supported request types. `unspecified` is the neutral default; `other`
 * absorbs any unknown/unsupported value supplied by callers or the LLM.
 */
export const REQUEST_TYPES = [
  'feature',
  'bug_fix',
  'refactor',
  'performance',
  'security',
  'ui_change',
  'api_change',
  'infrastructure',
  'migration',
  'testing',
  'documentation',
  'maintenance',
  'other',
  'unspecified',
] as const;

export type RequestType = (typeof REQUEST_TYPES)[number];

/** Deterministic lifecycle. Only application logic may change status. */
export const INTAKE_STATUSES = [
  'draft',
  'collecting_information',
  'submitted',
  'cancelled',
  'archived',
] as const;

export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

export const INTAKE_PRIORITIES = ['unspecified', 'low', 'medium', 'high', 'critical'] as const;

export type IntakePriority = (typeof INTAKE_PRIORITIES)[number];

/** Who produced a stored value. Distinguishes user vs machine content. */
export const INTAKE_FIELD_SOURCES = ['user', 'llm', 'deterministic', 'system'] as const;

export type IntakeFieldSource = (typeof INTAKE_FIELD_SOURCES)[number];

/** Record fields that carry a source annotation. */
export const INTAKE_FIELDS = [
  'title',
  'normalized_summary',
  'request_type',
  'priority',
  'business_goal',
  'target_users',
  'expected_outcome',
  'scope_notes',
  'constraints',
  'provided_context',
  'attachments',
  'related_resources',
] as const;

export type IntakeField = (typeof INTAKE_FIELDS)[number];

export const INTAKE_ATTACHMENT_KINDS = ['file', 'image', 'document', 'link', 'other'] as const;

export type IntakeAttachmentKind = (typeof INTAKE_ATTACHMENT_KINDS)[number];

export const RELATED_RESOURCE_KINDS = ['spec', 'issue', 'pr', 'doc', 'url', 'other'] as const;

export type RelatedResourceKind = (typeof RELATED_RESOURCE_KINDS)[number];

export const INTAKE_QUESTION_STATUSES = ['unanswered', 'answered', 'skipped'] as const;

export type IntakeQuestionStatus = (typeof INTAKE_QUESTION_STATUSES)[number];

export const SUGGESTION_STATUSES = ['pending', 'accepted', 'rejected'] as const;

export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export const SUGGESTION_KINDS = [
  'title',
  'summary',
  'request_type',
  'priority',
  'question',
  'constraint',
  'target_user',
  'outcome',
] as const;

export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

// ---------------------------------------------------------------------------
// Size / shape limits — deterministic input validation.
// ---------------------------------------------------------------------------

/** Maximum length of the original request, in characters. */
export const MAX_REQUEST_LENGTH = 100_000;
/** Maximum length of a title, in characters. */
export const MAX_TITLE_LENGTH = 200;
/** Maximum length of the normalized summary, in characters. */
export const MAX_SUMMARY_LENGTH = 2_000;
/** Maximum length of any free-form string field (goal, outcome, scope notes, …). */
export const MAX_STRING_FIELD_LENGTH = 5_000;
/** Maximum number of items in a list field (target users, constraints, …). */
export const MAX_ARRAY_ITEMS = 50;
/** Maximum number of attachments on one intake record. */
export const MAX_ATTACHMENTS = 20;
/** Maximum number of related resources on one intake record. */
export const MAX_RELATED_RESOURCES = 50;
/** Maximum number of top-level metadata keys. */
export const MAX_METADATA_ENTRIES = 50;
/** Maximum serialized metadata size, in bytes. */
export const MAX_METADATA_BYTES = 64 * 1024;
/** Maximum length of an intake answer, in characters. */
export const MAX_ANSWER_LENGTH = 50_000;
/** Maximum length of an idempotency key, in characters. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
/** Maximum length of an attachment/related-resource reference. */
export const MAX_REFERENCE_LENGTH = 500;
/** Maximum length of a question text. */
export const MAX_QUESTION_LENGTH = 500;
/** Maximum number of change-history entries retained per record. */
export const MAX_HISTORY_ENTRIES = 200;
/** Maximum number of pending LLM suggestions retained per record. */
export const MAX_SUGGESTIONS = 100;

/** Deterministic fallback summary length when no LLM summary is available. */
export const DETERMINISTIC_SUMMARY_LENGTH = 240;

/**
 * Default intake question catalog. Hosts may override via create options.
 * `field` values map to record properties through the answer pipeline
 * (see service.ts) or stay as structured answers for later modules.
 */
export interface IntakeQuestionTemplate {
  field: string;
  question: string;
  required: boolean;
}

export const DEFAULT_INTAKE_QUESTIONS: readonly IntakeQuestionTemplate[] = [
  { field: 'description_scope', question: 'What should be changed or created?', required: true },
  { field: 'business_goal', question: 'What problem should this request solve?', required: true },
  { field: 'target_users', question: 'Who will use this functionality?', required: false },
  { field: 'expected_outcome', question: 'What outcome is expected?', required: false },
  {
    field: 'project_component',
    question: 'Which project or component is affected?',
    required: false,
  },
  { field: 'constraints', question: 'Are there known constraints?', required: false },
  {
    field: 'related_resources',
    question: 'Is there an existing implementation or reference?',
    required: false,
  },
  { field: 'priority', question: 'Is there a desired priority?', required: false },
  {
    field: 'attachments',
    question: 'Are any files, screenshots, documents, or links relevant?',
    required: false,
  },
] as const;
