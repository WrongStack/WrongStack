// ── blocks (10 symbols) ──

export type { BrowserElementSelection } from '@wrongstack/primitives';
// ── attachment (6 symbols) ──
export type {
  AddAttachmentInput,
  Attachment,
  AttachmentKind,
  AttachmentMeta,
  AttachmentRef,
  AttachmentStore,
} from './attachment.js';
// ── autonomy (1 symbols) ──
export type { AutonomyStage } from './autonomy.js';
export type {
  ContentBlock,
  DocumentBlock,
  ImageBlock,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from './blocks.js';
export {
  documentAsText,
  isImageBlock,
  isTextBlock,
  isToolResultBlock,
  isToolUseBlock,
  isVolatileSystemBlock,
  markVolatileSystemBlock,
  VOLATILE_SYSTEM_BLOCKS,
} from './blocks.js';
export type {
  CompactionObserver,
  CompactionTrigger,
  CompactOptions,
  Compactor,
  CompactReport,
} from './compactor.js';
export type {
  AdaptiveConcurrencyConfig,
  AgentLearningConfig,
  AutonomyConfig,
  AutoThinConfig,
  BrainConfig,
  BrainCouncilConfig,
  BrainCouncilVoterConfig,
  BrainModelEntry,
  CircuitBreakerRuntimeConfig,
  ConcreteTokenSavingTier,
  Config,
  ConfigLoader,
  ConfigStore,
  ContextConfig,
  CouncilPersonaDefinition,
  CouncilToolConfig,
  CouncilToolProfileDefinition,
  CustomModelDefinition,
  DisabledToolMeta,
  ExecDangerConfig,
  ExecToolConfig,
  FeaturesConfig,
  FleetChatVerbosity,
  FleetConfig,
  FleetSupervisorConfig,
  GitBehaviorConfig,
  HqClientConfig,
  IndexingAtlasConfig,
  IndexingConceptsConfig,
  IndexingConfig,
  IndexingEmbeddingsConfig,
  InputHistoryConfig,
  LaunchConfig,
  LaunchMenuChoice,
  LimitBound,
  LimitsBudgetKey,
  LimitsConfig,
  LimitsScalarKey,
  LogConfig,
  LoopDetectionConfig,
  MCPHealthConfig,
  MCPHealthThresholds,
  MCPServerConfig,
  ModelMatrixEntry,
  ModelRuntimeCacheConfig,
  ModelRuntimeConfig,
  ModelRuntimeParametersConfig,
  ModelRuntimeReasoningConfig,
  ModelRuntimeStreamingConfig,
  ModelTierId,
  ModelTierLeaderConfig,
  ModelTierLeaderMode,
  ModelTierLevel,
  ModelTierRouting,
  ModelTiersConfig,
  NextStepsMode,
  NextStepsToolConfig,
  ObservabilityConfig,
  OtlpExportConfig,
  PluginConfig,
  PluginManagerConfig,
  ProviderApiKey,
  ProviderConfig,
  SageConfig,
  SessionLoggingConfig,
  SkillSuggestConfig,
  SkillsConfig,
  SyncCategory,
  SyncConfig,
  ThemeName,
  ThemePresetId,
  ThemePresetMeta,
  TokenSavingTier,
  ToolDescriptionMode,
  ToolDescriptionModeConfig,
  ToolResultRenderMode,
  ToolResultRenderModeConfig,
  ToolsConfig,
} from './config.js';
// ── config (59 symbols) ──
export {
  activeLimits,
  BUILTIN_MODEL_TIER_IDS,
  clampLimit,
  clampLimits,
  DEFAULT_TUI_THINKING_WORD,
  FLEET_CHAT_VERBOSITY_VALUES,
  formatLimitRange,
  installLimitsSource,
  LIMIT_BOUNDS,
  LIMITS_BUDGET_KEYS,
  LIMITS_SCALAR_KEYS,
  limitValueError,
  MAX_TUI_THINKING_WORD_LENGTH,
  MAX_WRONGPROXY_URL_LENGTH,
  NEXT_STEPS_MODES,
  normalizeTokenSavingTier,
  normalizeTuiThinkingWord,
  positiveLimit,
  resolveFleetChatVerbosity,
  resolveNextStepsMode,
  resolveTokenSavingTier,
  THEME_PRESET_IDS,
  THEME_PRESET_META,
  THEME_RANDOM_ID,
  TOOL_MEMORY_GUARD_BYTES,
} from './config.js';
// ── context (2 symbols) ──
export type { NestedToolCaller, NestedToolCallResult } from './context.js';
// ── context-evidence (8 symbols) ──
export type {
  CompletedWorkEvidence,
  CompletedWorkSource,
  ContextEvidenceState,
  ToolOutputMetadata,
} from './context-evidence.js';
export type {
  ContextSnapshot,
  ContextWindowAggressiveOn,
  ContextWindowConfigLike,
  ContextWindowMode,
  ContextWindowModeId,
  ContextWindowModeSelectionId,
  ContextWindowPolicy,
  ContextWindowThresholds,
  DeprecatedContextWindowModeId,
} from './context-window.js';
// ── context-window (13 symbols) ──
export {
  CONTEXT_WINDOW_MODE_PINNED_META_KEY,
  CONTEXT_WINDOW_MODES,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  DEPRECATED_CONTEXT_WINDOW_MODE_ALIASES,
  formatContextWindowModeList,
  getContextWindowMode,
  isContextWindowModeId,
  isContextWindowModeSelectionId,
  isDeprecatedContextWindowModeId,
  LARGE_WINDOW_DEEP_MODE_THRESHOLD,
  listContextWindowModes,
  normalizeContextWindowModeId,
  resolveContextWindowPolicy,
} from './context-window.js';
// ── council (15 symbols) ──
export type {
  CouncilDistinctness,
  CouncilLLMCaller,
  CouncilModelTarget,
  CouncilOption,
  CouncilPersona,
  CouncilProfileConfig,
  CouncilQuestion,
  CouncilResolutionMethod,
  CouncilResult,
  CouncilSeatConfig,
  CouncilUsage,
  CouncilVoteResult,
  CouncilVoteStatus,
  ResolvedCouncilProfile,
  ResolvedCouncilSeat,
} from './council.js';
// ── default-config (6 symbols) ──
export {
  DEFAULT_AUTONOMY_CONFIG,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_SESSION_LOGGING_CONFIG,
  DEFAULT_SESSION_PRUNE_DAYS,
  DEFAULT_TOOLS_CONFIG,
} from './default-config.js';
export type {
  DesignKitEntry,
  DesignKitLoader,
  DesignKitManifest,
  DesignKitTokens,
  DesignStack,
  DesignStudioState,
  DesignTokenSet,
  TokenValueKind,
} from './design-kit.js';
// ── design-kit (12 symbols) ──
export {
  DESIGN_STACKS,
  isDesignStack,
  KNOWN_TOKEN_GROUPS,
  KNOWN_TOKEN_NAMES,
} from './design-kit.js';
export type { ErrorCode, ErrorSeverity, ErrorSubsystem } from './errors.js';
// ── errors (28 symbols) ──
export {
  AgentError,
  ConfigError,
  ERROR_CODES,
  FetchError,
  FsError,
  hasModifiedPaths,
  isAgentError,
  isConfigError,
  isFetchError,
  isFsError,
  isParseError,
  isPluginError,
  isSddError,
  isSessionError,
  isToolError,
  isToolValidationError,
  isWrongStackError,
  ParseError,
  PartialWriteError,
  PluginError,
  SddError,
  SessionError,
  ToolError,
  ToolValidationError,
  toWrongStackError,
  WrongStackError,
} from './errors.js';
// ── fallback (1 symbols) ──
export type { FallbackProfileManagerPort } from './fallback.js';
// ── file-event-record (1 symbols) ──
export type { FileEventRecord } from './file-event-record.js';
// ── hooks (18 symbols) ──
export type {
  AnyHookOutcome,
  ConfiguredHook,
  HookEntry,
  HookEvent,
  HookFailurePolicy,
  HookInput,
  HookInvocationContext,
  HookMatcher,
  HookOutcome,
  HookRegistrationOptions,
  HookRegistryPort,
  HttpHook,
  InProcessHook,
  ObservationalHookEvent,
  PreToolUseOutcome,
  PreToolUseStage,
  ShellHook,
} from './hooks.js';
export { HOOK_EVENTS, isHookEvent } from './hooks.js';
export type {
  GeneratedImage,
  ImageGenerationRequest,
  ImageGenerationResult,
} from './image-generation.js';
// ── input-reader (2 symbols) ──
export type { InputReader, PromptOption, ReadKeyOptions } from './input-reader.js';
// ── hq-mailbox-publisher (5 symbols) ──
export type {
  HqMailboxEventAction,
  MailboxHqPublisherFactory,
  MailboxHqPublisherFactoryOptions,
  MailboxHqPublisherPort,
} from './hq-mailbox-publisher.js';
// ── logger (2 symbols) ──
export type { Logger, LogLevel } from './logger.js';
export type {
  MemoryCapability,
  MemoryClearedPayload,
  MemoryConsolidatedPayload,
  MemoryEntry,
  MemoryForgottenPayload,
  MemoryHealth,
  MemoryPort,
  MemoryPriority,
  MemoryRelevanceContext,
  MemoryRememberedPayload,
  MemoryScope,
  MemoryStore,
  MemoryType,
  ScoredEntry,
} from './memory.js';
// ── memory (16 symbols) ──
export { defineMemoryCapability, MEMORY_TYPE_LABELS } from './memory.js';
// ── messages (2 symbols) ──
export type { Message, MessageRole } from './messages.js';
export type { Mode, ModeConfig, ModeManifest, ModeStore } from './mode.js';
// ── models-registry (8 symbols) ──
export type {
  ModelCatalogSource,
  ModelProvenance,
  ModelsDevModel,
  ModelsDevPayload,
  ModelsDevProvider,
  ModelsDevReasoningOption,
  ModelsRegistry,
  ResolvedModel,
  ResolvedProvider,
  WireFamily,
} from './models-registry.js';
// ── multi-agent (20 symbols) ──
export type {
  AwaitAnyResult,
  CoordinatorEvents,
  CoordinatorStatus,
  DoneCondition,
  MultiAgentConfig,
  MultiAgentCoordinator,
  SpawnResult,
  SubagentConfig,
  SubagentContext,
  SubagentError,
  SubagentErrorKind,
  SubagentPartialResult,
  SubagentRunContext,
  SubagentRunner,
  SubagentRunOutcome,
  SubagentSpawnLineage,
  SubagentStructuredReport,
  TaskDelegation,
  TaskResult,
  TaskSpec,
} from './multi-agent.js';
// ── observability (12 symbols) ──
export type {
  AggregateHealth,
  HealthCheck,
  HealthCheckResult,
  HealthRegistry,
  HealthStatus,
  MetricLabels,
  MetricSeries,
  MetricsRuntimeStatus,
  MetricsSink,
  MetricsSnapshot,
  Span,
  Tracer,
} from './observability.js';
// ── one-shot LLM (5 symbols) ──
export type {
  OneShotLLMInput,
  OneShotLLMResult,
  OneShotModelPick,
  OneShotModelRouter,
  OneShotOrchestratorOptions,
} from './one-shot-llm.js';
// ── permission (8 symbols) ──
export type {
  DirectoryPolicy,
  DirectoryRule,
  PermissionDecision,
  PermissionPolicy,
  PermissionRule,
  PermissionTrace,
  PermissionTraceStep,
  TrustPolicy,
} from './permission.js';
// ── plugin (20 symbols) ──
export type {
  MCPRegistryView,
  MetricsSinkView,
  Notifier,
  Plugin,
  PluginAPI,
  PluginCapabilities,
  PluginConfigFieldLifecycle,
  PluginConfigFieldMetadata,
  PluginConfigFields,
  PluginCouncilOptions,
  PluginDependency,
  PluginJev,
  PluginLLM,
  PluginLLMOptions,
  PluginLLMResult,
  PluginPipelines,
  PluginRuntime,
  ProviderAuthRegistryView,
  ProviderFactory,
  ProviderRegistryView,
  SessionWriterView,
  SlashCommandRegistryView,
  ToolRegistryView,
} from './plugin.js';
export type {
  BuiltinPromptCategory,
  PromptCategory,
  PromptCategoryCount,
  PromptEntry,
  PromptLoader,
  PromptManifest,
  PromptManifestRef,
  PromptSearchOptions,
  PromptSource,
  PromptVariable,
} from './prompt.js';
// ── prompt (13 symbols) ──
export { BUILTIN_PROMPT_CATEGORIES, isBuiltinCategory, PROMPT_CATEGORY_LABELS } from './prompt.js';
export type {
  InstalledPromptEntry,
  PromptManifestData,
  PromptRegistryManifest,
  PromptRegistryRef,
  RegistryDiff,
} from './prompt-registry.js';
// ── prompt-registry (8 symbols) ──
export { diffRegistry, validateRegistryManifest } from './prompt-registry.js';
export type {
  AgentContextUsage,
  CacheTtl,
  Capabilities,
  JsonSchemaSpec,
  Provider,
  ProviderContextLimit,
  ProviderErrorBody,
  ProviderErrorKind,
  ReasoningConfig,
  ReasoningEffort,
  ReasoningRequest,
  Request,
  RequestCacheControl,
  Response,
  ResponseFormat,
  SafetySetting,
  StopReason,
  StreamEvent,
  Usage,
} from './provider.js';
// ── provider (27 symbols) ──
export {
  classifyProviderError,
  effectiveInputTokens,
  freshInputTokens,
  isContextOverflowShaped,
  isFallbackWorthy,
  isReasoningEffort,
  isRetryableKind,
  isSafetyPolicyCode,
  isSafetyPolicyRefusal,
  ProviderError,
  promptCacheHitRatio,
  REASONING_EFFORT_LEVELS,
  SAFETY_POLICY_GUIDANCE,
  StreamHangError,
  totalUsageTokens,
} from './provider.js';
export type {
  ProviderAuthBeginDeps,
  ProviderAuthInteraction,
  ProviderAuthInteractionType,
  ProviderAuthOutcome,
  ProviderAuthSession,
  ProviderAuthStrategy,
  ProviderAuthStrategyMetadata,
} from './provider-auth.js';
export {
  clearProviderReportedMaxOutputs,
  parseProviderReportedMaxOutput,
  providerReportedMaxOutput,
  recordProviderReportedMaxOutput,
} from './provider-output-caps.js';
// ── provider-runner (2 symbols) ──
export type { ProviderRunner, RunProviderOptions } from './provider-runner.js';
// ── provider-status (1 symbols) ──
export type { ProviderStatusTrackerPort } from './provider-status.js';
// ── renderer (1 symbols) ──
export type { Renderer } from './renderer.js';
// ── secret-scrubber (1 symbols) ──
export type { SecretScrubber } from './secret-scrubber.js';
// ── secret-vault (2 symbols) ──
export type { RotatableSecretVault, SecretVault } from './secret-vault.js';
// ── session (19 symbols) ──
export type {
  FileSnapshot,
  ForkedSession,
  ResumedSession,
  ResumeFileStatus,
  ResumeFileValidationEntry,
  ResumeValidation,
  SessionArchiveIdleResult,
  SessionArchiveResult,
  SessionData,
  SessionEvent,
  SessionForkOptions,
  SessionLoadProgress,
  SessionMetadata,
  SessionMoveResult,
  SessionMoveTarget,
  SessionStoragePolicy,
  SessionStore,
  SessionSummary,
  SessionWriter,
  WorkspaceCheckpointRef,
  WorkspaceMaterializationResult,
} from './session.js';
export type {
  SessionMarker,
  SessionMarkerDetail,
  SessionMarkerLevel,
} from './session-markers.js';
// ── session-markers (8 symbols) ──
export {
  CHAT_MARKER_SOURCES,
  isSystemInjectedMessage,
  projectSessionMarkers,
  SESSION_MARKER_EVENT_TYPES,
  SYSTEM_INJECTION_PREFIXES,
  sessionEventToMarker,
} from './session-markers.js';
export type { SessionPermissionOverride } from './session-permission-override.js';
// ── session-reader (8 symbols) ──
export type {
  DefaultSessionReaderOptions,
  SessionEventType,
  SessionExportOptions,
  SessionQuery,
  SessionReader,
  SessionSearchHit,
  SessionSearchQuery,
  SessionSummaryLite,
} from './session-reader.js';
// ── session-rewinder (4 symbols) ──
export type {
  CheckpointInfo,
  RewindResult,
  RewindResultExtended,
  SessionRewinder,
} from './session-rewinder.js';
// ── session-timeline (10 symbols) ──
export type {
  ProjectSessionTimelineInput,
  SessionTimelineAssistantEntry,
  SessionTimelineEntry,
  SessionTimelineImage,
  SessionTimelineMarkerEntry,
  SessionTimelineSystemEntry,
  SessionTimelineThinkingEntry,
  SessionTimelineToolEntry,
  SessionTimelineUserEntry,
  SessionToolMeta,
  TextBlockMode,
  ThinkingPlacement,
} from './session-timeline.js';
export { projectSessionTimeline, projectSessionToolMeta } from './session-timeline.js';
// ── side-effect (2 symbols) ──
export type { SideEffect } from './side-effect.js';
// ── skill (3 symbols) ──
export type { SkillEntry, SkillLoader, SkillManifest } from './skill.js';
// ── slash-command (1 symbols) ──
export type { SlashCommand } from './slash-command.js';
export type {
  SpecAnalysis,
  SpecApiEndpoint,
  Specification,
  SpecRequirement,
  SpecSection,
  SpecSectionType,
  SpecStatus,
  SpecTemplate,
  SpecValidationResult,
} from './spec.js';
// ── spec (10 symbols) ──
export { DEFAULT_SPEC_TEMPLATE } from './spec.js';
export type {
  BuildContext,
  ModelCapabilities,
  SystemPromptBuilder,
  SystemPromptRegions,
} from './system-prompt.js';
// ── system-prompt (5 symbols) ──
export { flattenSystemPromptRegions } from './system-prompt.js';
// ── system-prompt-contributor (1 symbols) ──
export type { SystemPromptContributor } from './system-prompt-contributor.js';
// ── task-graph (15 symbols) ──
export type {
  CriticalPathResult,
  SerializableTaskGraph,
  SerializedTaskGraph,
  TaskAssignment,
  TaskDependency,
  TaskEdge,
  TaskFilter,
  TaskGraph,
  TaskNode,
  TaskPriority,
  TaskProgress,
  TaskSort,
  TaskStatus,
  TaskType,
} from './task-graph.js';
// ── token-counter (2 symbols) ──
export type {
  CacheStats,
  LastRequestCacheStats,
  ProviderCacheStats,
  TokenCounter,
} from './token-counter.js';
export type {
  JSONSchema,
  Permission,
  RiskTier,
  Tool,
  ToolCallContext,
  ToolErrorInfo,
  ToolFinalEvent,
  ToolIconId,
  ToolProgressEvent,
  ToolSettlement,
  ToolStreamEvent,
} from './tool.js';
// ── tool (11 symbols) ──
export { ToolErrorCategory } from './tool.js';
export type {
  ConfirmAwaiter,
  GovernedToolExecutionResult,
  GovernedToolExecutor,
  ToolBatchResult,
  ToolConfirmPendingResult,
  ToolExecution,
  ToolExecutionOutput,
  ToolExecutorLike,
  ToolExecutorStrategy,
} from './tool-executor.js';
// ── tool-executor (12 symbols) ──
export { GOVERNED_TOOL_EXECUTOR_META_KEY } from './tool-executor.js';
// ── tool-markers (1 symbols) ──
export { MALFORMED_ARG_MARKERS } from './tool-markers.js';
export type {
  UserInputAnswer,
  UserInputAwaiter,
  UserInputOption,
  UserInputQuestion,
  UserInputQuestionKind,
  UserInputRequest,
  UserInputResponse,
  UserInputTab,
} from './user-input.js';
// ── utility-types (1 symbols) ──
export type { DistributiveOmit } from './utility-types.js';
// ── worktree (1 symbols) ──
export type { WorktreeManagerPort } from './worktree.js';
