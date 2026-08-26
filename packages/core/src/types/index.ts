// ── blocks (10 symbols) ──

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
  ImageBlock,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from './blocks.js';
export { isImageBlock, isTextBlock, isToolResultBlock, isToolUseBlock } from './blocks.js';
export type { Compactor, CompactReport } from './compactor.js';
export type {
  AdaptiveConcurrencyConfig,
  AgentLearningConfig,
  AutonomyConfig,
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
  ExecDangerConfig,
  ExecToolConfig,
  FeaturesConfig,
  FleetChatVerbosity,
  FleetConfig,
  FleetSupervisorConfig,
  GitBehaviorConfig,
  HqClientConfig,
  IndexingConfig,
  InputHistoryConfig,
  LaunchConfig,
  LaunchMenuChoice,
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
  NextStepsToolConfig,
  PluginConfig,
  PluginManagerConfig,
  ProviderApiKey,
  ProviderConfig,
  SageConfig,
  SessionLoggingConfig,
  SkillsConfig,
  SyncCategory,
  SyncConfig,
  ThemePresetId,
  TokenSavingTier,
  ToolDescriptionMode,
  ToolDescriptionModeConfig,
  ToolResultRenderMode,
  ToolResultRenderModeConfig,
  ToolsConfig,
} from './config.js';
// ── config (59 symbols) ──
export {
  DEFAULT_TUI_THINKING_WORD,
  FLEET_CHAT_VERBOSITY_VALUES,
  MAX_TUI_THINKING_WORD_LENGTH,
  MAX_WRONGPROXY_URL_LENGTH,
  normalizeTokenSavingTier,
  normalizeTuiThinkingWord,
  resolveFleetChatVerbosity,
  resolveTokenSavingTier,
  THEME_PRESET_IDS,
} from './config.js';
// ── context-evidence (8 symbols) ──
export type {
  CompletedWorkEvidence,
  CompletedWorkSource,
  ContextEvidenceState,
  ContextFileEvidence,
  ContextIntentEvidence,
  ContextRepeatedReadEvidence,
  ToolEvidenceStatus,
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
// ── errors (27 symbols) ──
export {
  AgentError,
  ConfigError,
  ERROR_CODES,
  FetchError,
  FsError,
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
  PluginError,
  SddError,
  SessionError,
  ToolError,
  ToolValidationError,
  toWrongStackError,
  WrongStackError,
} from './errors.js';
// ── file-event-record (1 symbols) ──
export type { FileEventRecord } from './file-event-record.js';
// ── hooks (15 symbols) ──
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
  HttpHook,
  InProcessHook,
  PreToolUseOutcome,
  PreToolUseStage,
  ShellHook,
} from './hooks.js';
// ── input-reader (2 symbols) ──
export type { InputReader, PromptOption } from './input-reader.js';
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
// ── mode (5 symbols) ──
export { DEFAULT_MODES } from './mode.js';
// ── models-registry (8 symbols) ──
export type {
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
// ── permission (7 symbols) ──
export type {
  DirectoryPolicy,
  DirectoryRule,
  PermissionDecision,
  PermissionPolicy,
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
  PluginLLM,
  PluginLLMOptions,
  PluginLLMResult,
  PluginPipelines,
  PluginRuntime,
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
  ManifestValidation,
  PromptManifestData,
  PromptRegistryManifest,
  PromptRegistryRef,
  RegistryDiff,
} from './prompt-registry.js';
// ── prompt-registry (8 symbols) ──
export { diffRegistry, validateRegistryManifest } from './prompt-registry.js';
export type {
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
// ── provider (24 symbols) ──
export {
  classifyProviderError,
  effectiveInputTokens,
  freshInputTokens,
  isContextOverflowShaped,
  isFallbackWorthy,
  isReasoningEffort,
  isRetryableKind,
  ProviderError,
  promptCacheHitRatio,
  REASONING_EFFORT_LEVELS,
  StreamHangError,
  totalUsageTokens,
} from './provider.js';
// ── provider-runner (2 symbols) ──
export type { ProviderRunner, RunProviderOptions } from './provider-runner.js';
// ── renderer (1 symbols) ──
export type { Renderer } from './renderer.js';
// ── secret-scrubber (1 symbols) ──
export type { SecretScrubber } from './secret-scrubber.js';
// ── secret-vault (2 symbols) ──
export type { RotatableSecretVault, SecretVault } from './secret-vault.js';
// ── session (15 symbols) ──
export type {
  FileSnapshot,
  ForkedSession,
  ResumedSession,
  ResumeFileStatus,
  ResumeFileValidationEntry,
  ResumeValidation,
  SessionData,
  SessionEvent,
  SessionForkOptions,
  SessionMetadata,
  SessionStore,
  SessionSummary,
  SessionWriter,
  WorkspaceCheckpointRef,
  WorkspaceMaterializationResult,
} from './session.js';
export type { SessionMarker, SessionMarkerLevel } from './session-markers.js';
// ── session-markers (8 symbols) ──
export {
  CHAT_MARKER_SOURCES,
  isSystemInjectedMessage,
  projectSessionMarkers,
  SESSION_MARKER_EVENT_TYPES,
  SYSTEM_INJECTION_PREFIXES,
  sessionEventToMarker,
} from './session-markers.js';
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
// ── side-effect (2 symbols) ──
export type { SideEffect, SideEffectRisk } from './side-effect.js';
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
  SerializableTaskGraphNodes,
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
export type { CacheStats, ProviderCacheStats, TokenCounter } from './token-counter.js';
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
  ToolStreamEvent,
} from './tool.js';
// ── tool (10 symbols) ──
export { ToolErrorCategory } from './tool.js';
export type {
  ConfirmAwaiter,
  GovernedToolExecutionResult,
  GovernedToolExecutor,
  ToolBatchResult,
  ToolConfirmPendingResult,
  ToolExecution,
  ToolExecutionOutput,
  ToolExecutorInit,
  ToolExecutorLike,
  ToolExecutorOptions,
  ToolExecutorStrategy,
} from './tool-executor.js';
// ── tool-executor (12 symbols) ──
export { GOVERNED_TOOL_EXECUTOR_META_KEY } from './tool-executor.js';
// ── tool-markers (1 symbols) ──
export { MALFORMED_ARG_MARKERS } from './tool-markers.js';
// ── utility-types (1 symbols) ──
export type { DistributiveOmit } from './utility-types.js';
