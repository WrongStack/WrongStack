/**
 * Requirements Intake — public surface.
 *
 * Collect, preserve, validate, normalize, and submit unstructured software
 * development requests as structured intake records. Upstream of spec-driven
 * development; this module never plans, specifies, or implements.
 */

// Authorization
export {
  AllowAllIntakeAuthorizer,
  DenyAllIntakeAuthorizer,
  INTAKE_OPERATIONS,
  type IntakeAuthorizer,
  type IntakeOperation,
  ProjectMembershipIntakeAuthorizer,
  type ProjectMembershipIntakeAuthorizerOptions,
} from './authorization.js';
// Constants & enums
export {
  DEFAULT_INTAKE_QUESTIONS,
  INTAKE_ATTACHMENT_KINDS,
  INTAKE_FIELD_SOURCES,
  INTAKE_FIELDS,
  INTAKE_ID_PREFIX,
  INTAKE_PRIORITIES,
  INTAKE_QUESTION_STATUSES,
  INTAKE_STATUSES,
  type IntakeAttachmentKind,
  type IntakeField,
  type IntakeFieldSource,
  type IntakePriority,
  type IntakeQuestionStatus,
  type IntakeQuestionTemplate,
  type IntakeStatus,
  MAX_ANSWER_LENGTH,
  MAX_ARRAY_ITEMS,
  MAX_ATTACHMENTS,
  MAX_HISTORY_ENTRIES,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_METADATA_BYTES,
  MAX_METADATA_ENTRIES,
  MAX_QUESTION_LENGTH,
  MAX_REFERENCE_LENGTH,
  MAX_RELATED_RESOURCES,
  MAX_REQUEST_LENGTH,
  MAX_STRING_FIELD_LENGTH,
  MAX_SUGGESTIONS,
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  RELATED_RESOURCE_KINDS,
  REQUEST_TYPES,
  type RelatedResourceKind,
  type RequestType,
  SUGGESTION_KINDS,
  SUGGESTION_STATUSES,
  type SuggestionKind,
  type SuggestionStatus,
} from './constants.js';

// Errors
export {
  IntakeAuthorizationError,
  IntakeConflictError,
  IntakeError,
  type IntakeErrorCode,
  IntakeNotFoundError,
  IntakeStateTransitionError,
  IntakeStatusLockedError,
  IntakeSuggestionError,
  IntakeValidationError,
  type IntakeValidationIssue,
} from './errors.js';
export { IntakeEventEmitter } from './events.js';

// Lifecycle
export {
  ALLOWED_TRANSITIONS,
  assertTransition,
  canTransition,
  isKnownStatus,
  isMutableStatus,
  isTerminalStatus,
  MUTABLE_STATUSES,
} from './lifecycle.js';
// Observability
export {
  InMemoryIntakeLogger,
  type IntakeLogFields,
  type IntakeLogger,
  NoopIntakeLogger,
} from './logger.js';
export {
  INTAKE_COUNTERS,
  INTAKE_TIMERS,
  InMemoryIntakeMetrics,
  type IntakeCounter,
  type IntakeMetrics,
  type IntakeTimer,
  NoopIntakeMetrics,
} from './metrics.js';
// Questions
export { buildInitialQuestions, pendingQuestions, upsertQuestion } from './questions.js';
// Service
export {
  type IntakeCreateResult,
  type IntakeListFilter,
  type IntakeSubmitResult,
  RequirementIntakeService,
  type RequirementIntakeServiceOptions,
} from './service.js';
// Store
export {
  type IntakeIndexEntry,
  newIntakeId,
  RequirementIntakeStore,
  type RequirementIntakeStoreOptions,
  type StoreCreateResult,
  type StoreUpdateOptions,
} from './store.js';
// Suggestions
export {
  assertSuggestionString,
  type LlmSuggestionGenerator,
  type LlmSuggestionOutput,
  type LlmSuggestionRequest,
  llmSuggestionOutputSchema,
  type NormalizedLlmSuggestion,
  toProposals,
  validateLlmSuggestionOutput,
} from './suggestions.js';
// Types
export {
  type AddAnswerInput,
  type AttachResourceInput,
  type ChangeHistoryEntry,
  type CreateIntakeInput,
  INTAKE_EVENT_NAMES,
  type IntakeActor,
  type IntakeAnswer,
  type IntakeAttachment,
  type IntakeAttachmentInput,
  type IntakeContext,
  type IntakeEvent,
  type IntakeEventName,
  type IntakeQuestion,
  type IntakeQuestionTemplateInput,
  type LlmSuggestionProposal,
  type RelatedResource,
  type RelatedResourceInput,
  type RequirementIntakeRecord,
  type UpdateIntakeInput,
} from './types.js';
// Validation
export {
  answerInputSchema,
  attachmentInputSchema,
  attachResourceInputSchema,
  createIntakeSchema,
  deterministicSummary,
  deterministicTitle,
  isBlank,
  metadataSchema,
  normalizeRequestType,
  parseWithIssues,
  prioritySchema,
  questionTemplateInputSchema,
  relatedResourceInputSchema,
  requestTypeSchema,
  updateIntakeSchema,
  validateAnswerInput,
  validateAttachmentInput,
  validateAttachResourceInput,
  validateCreateInput,
  validateFieldSource,
  validateQuestionTemplateInput,
  validateRelatedResourceInput,
  validateUpdateInput,
} from './validation.js';

// Vibe Protocol
export {
  deriveVibeState,
  hasVibeTag,
  stripVibeTag,
  VIBE_TAG_REGEX,
  type VibeProtocolStage,
  type VibeProtocolState,
} from './vibe.js';
