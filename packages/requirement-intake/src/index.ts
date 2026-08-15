/**
 * Requirements Intake — public surface.
 *
 * Collect, preserve, validate, normalize, and submit unstructured software
 * development requests as structured intake records. Upstream of spec-driven
 * development; this module never plans, specifies, or implements.
 */

// Constants & enums
export {
  INTAKE_ID_PREFIX,
  REQUEST_TYPES,
  INTAKE_STATUSES,
  INTAKE_PRIORITIES,
  INTAKE_FIELD_SOURCES,
  INTAKE_FIELDS,
  INTAKE_ATTACHMENT_KINDS,
  RELATED_RESOURCE_KINDS,
  INTAKE_QUESTION_STATUSES,
  SUGGESTION_STATUSES,
  SUGGESTION_KINDS,
  MAX_REQUEST_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_STRING_FIELD_LENGTH,
  MAX_ARRAY_ITEMS,
  MAX_ATTACHMENTS,
  MAX_RELATED_RESOURCES,
  MAX_METADATA_ENTRIES,
  MAX_METADATA_BYTES,
  MAX_ANSWER_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_REFERENCE_LENGTH,
  MAX_QUESTION_LENGTH,
  MAX_HISTORY_ENTRIES,
  MAX_SUGGESTIONS,
  DEFAULT_INTAKE_QUESTIONS,
  type RequestType,
  type IntakeStatus,
  type IntakePriority,
  type IntakeFieldSource,
  type IntakeField,
  type IntakeAttachmentKind,
  type RelatedResourceKind,
  type IntakeQuestionStatus,
  type SuggestionStatus,
  type SuggestionKind,
  type IntakeQuestionTemplate,
} from './constants.js';

// Types
export {
  INTAKE_EVENT_NAMES,
  type IntakeActor,
  type IntakeContext,
  type IntakeAttachment,
  type RelatedResource,
  type IntakeAnswer,
  type IntakeQuestion,
  type ChangeHistoryEntry,
  type LlmSuggestionProposal,
  type RequirementIntakeRecord,
  type CreateIntakeInput,
  type IntakeAttachmentInput,
  type RelatedResourceInput,
  type IntakeQuestionTemplateInput,
  type UpdateIntakeInput,
  type AddAnswerInput,
  type AttachResourceInput,
  type IntakeEvent,
  type IntakeEventName,
} from './types.js';

// Errors
export {
  IntakeError,
  IntakeValidationError,
  IntakeNotFoundError,
  IntakeStateTransitionError,
  IntakeStatusLockedError,
  IntakeConflictError,
  IntakeAuthorizationError,
  IntakeSuggestionError,
  type IntakeErrorCode,
  type IntakeValidationIssue,
} from './errors.js';

// Validation
export {
  requestTypeSchema,
  prioritySchema,
  metadataSchema,
  attachmentInputSchema,
  relatedResourceInputSchema,
  questionTemplateInputSchema,
  createIntakeSchema,
  updateIntakeSchema,
  answerInputSchema,
  attachResourceInputSchema,
  normalizeRequestType,
  isBlank,
  parseWithIssues,
  validateCreateInput,
  validateUpdateInput,
  validateAnswerInput,
  validateAttachResourceInput,
  validateAttachmentInput,
  validateRelatedResourceInput,
  validateQuestionTemplateInput,
  validateFieldSource,
  deterministicSummary,
  deterministicTitle,
} from './validation.js';

// Lifecycle
export {
  ALLOWED_TRANSITIONS,
  MUTABLE_STATUSES,
  canTransition,
  assertTransition,
  isMutableStatus,
  isTerminalStatus,
  isKnownStatus,
} from './lifecycle.js';

// Questions
export { buildInitialQuestions, pendingQuestions, upsertQuestion } from './questions.js';

// Authorization
export {
  INTAKE_OPERATIONS,
  AllowAllIntakeAuthorizer,
  DenyAllIntakeAuthorizer,
  ProjectMembershipIntakeAuthorizer,
  type IntakeAuthorizer,
  type IntakeOperation,
  type ProjectMembershipIntakeAuthorizerOptions,
} from './authorization.js';

// Observability
export {
  NoopIntakeLogger,
  InMemoryIntakeLogger,
  type IntakeLogger,
  type IntakeLogFields,
} from './logger.js';
export {
  INTAKE_COUNTERS,
  INTAKE_TIMERS,
  NoopIntakeMetrics,
  InMemoryIntakeMetrics,
  type IntakeCounter,
  type IntakeTimer,
  type IntakeMetrics,
} from './metrics.js';
export { IntakeEventEmitter } from './events.js';

// Store
export {
  RequirementIntakeStore,
  newIntakeId,
  type RequirementIntakeStoreOptions,
  type IntakeIndexEntry,
  type StoreUpdateOptions,
  type StoreCreateResult,
} from './store.js';

// Suggestions
export {
  llmSuggestionOutputSchema,
  validateLlmSuggestionOutput,
  toProposals,
  assertSuggestionString,
  type LlmSuggestionRequest,
  type LlmSuggestionOutput,
  type LlmSuggestionGenerator,
  type NormalizedLlmSuggestion,
} from './suggestions.js';

// Service
export {
  RequirementIntakeService,
  type RequirementIntakeServiceOptions,
  type IntakeCreateResult,
  type IntakeSubmitResult,
  type IntakeListFilter,
} from './service.js';

// Vibe Protocol
export {
  VIBE_TAG_REGEX,
  hasVibeTag,
  stripVibeTag,
  deriveVibeState,
  type VibeProtocolStage,
  type VibeProtocolState,
} from './vibe.js';
