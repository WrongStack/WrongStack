export * from '@wrongstack/contracts/kernel';
export * from '@wrongstack/contracts/types';
export type { Compactor, CompactReport } from '@wrongstack/contracts/types/compactor';
export {
  CONTEXT_WINDOW_MODE_PINNED_META_KEY,
  CONTEXT_WINDOW_MODES,
  type ContextWindowAggressiveOn,
  type ContextWindowConfigLike,
  type ContextWindowMode,
  type ContextWindowModeId,
  type ContextWindowModeSelectionId,
  type ContextWindowPolicy,
  type ContextWindowThresholds,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  DEPRECATED_CONTEXT_WINDOW_MODE_ALIASES,
  type DeprecatedContextWindowModeId,
  formatContextWindowModeList,
  getContextWindowMode,
  isContextWindowModeId,
  isContextWindowModeSelectionId,
  isDeprecatedContextWindowModeId,
  LARGE_WINDOW_DEEP_MODE_THRESHOLD,
  listContextWindowModes,
  normalizeContextWindowModeId,
  resolveContextWindowPolicy,
} from '@wrongstack/contracts/types/context-window';
export { DEFAULT_SESSION_PRUNE_DAYS } from '@wrongstack/contracts/types/default-config';
export type { FileEventRecord } from '@wrongstack/contracts/types/file-event-record';
export type { Logger, LogLevel } from '@wrongstack/contracts/types/logger';
// Explicit type re-exports keep the top-level public surface stable for types
// that are reachable through multiple export chains (types/, execution/, …).
// Consumers (e.g. @wrongstack/providers) import these directly from '@wrongstack/core'.
export type {
  ModelsDevModel,
  ModelsDevPayload,
  ModelsDevProvider,
  ModelsRegistry,
  ResolvedModel,
  ResolvedProvider,
  WireFamily,
} from '@wrongstack/contracts/types/models-registry';
export type {
  ProviderRunner,
  RunProviderOptions,
} from '@wrongstack/contracts/types/provider-runner';
export type { SecretScrubber } from '@wrongstack/contracts/types/secret-scrubber';
export type { RotatableSecretVault, SecretVault } from '@wrongstack/contracts/types/secret-vault';
export {
  encryptedPrefixForVersion,
  noOpVault,
  parseEncryptedVersion,
} from '@wrongstack/contracts/types/secret-vault';
export type {
  CacheStats,
  LastRequestCacheStats,
  ProviderCacheStats,
  TokenCounter,
} from '@wrongstack/contracts/types/token-counter';
export {
  isSystemSessionId,
  requireSessionId,
  SESSION_ID_REQUIRED,
  SessionIdRequiredError,
  SYSTEM_SESSION_PREFIX,
  systemSessionId,
} from '@wrongstack/primitives';
export {
  assertProjectRootOutsideStateDir,
  type BootConfigOptions,
  type BootConfigResult,
  bootConfig,
  flagsToConfigPatch,
} from './boot.js';
export * from './chronicle/index.js';
export {
  Agent,
  type AgentInit,
  type AgentInput,
  type AgentPipelines,
  createDefaultPipelines,
  DEFAULT_MAX_ITERATIONS,
  type RunResult,
  type ToolCallPipelinePayload,
  type UserInputPayload,
} from './core/agent.js';
export {
  buildBtwBlock,
  consumeBtwNotes,
  pendingBtwCount,
  setBtwNote,
} from './core/btw.js';
export {
  Context,
  type ContextInit,
  type ProviderMemoryEvidence,
  type RunOptions,
  type TodoItem,
} from './core/context.js';
export {
  type ContinuationInput,
  type ContinuationSource,
  detectContinueIntent,
  type ResolvedContinuation,
  resolveContinuation,
} from './core/continue-intent.js';
export {
  type ContinueDirective,
  makeContinueToNextIterationTool,
  parseContinueDirective,
} from './core/continue-to-next-iteration.js';
export {
  ConversationState,
  type ReadonlyConversationState,
  type StateChange,
  type StateChangeHandler,
  wrapAsState,
} from './core/conversation-state.js';
export {
  createFallbackModelExtension,
  effectiveFallbackChain,
  type FallbackModelDeps,
  fallbackProfileChain,
  formatModelRef,
  normalizeModelRef,
  parseModelRef,
  runtimeFallbackChain,
  smartDefaultFallbackChain,
} from './core/fallback-model.js';
export type {
  FallbackChain,
  FallbackChainEntry,
  ProviderHealth,
} from './core/fallback-profile-manager.js';
export { FallbackProfileManager } from './core/fallback-profile-manager.js';
export {
  InputBuilder,
  type InputBuilderEvent,
  type InputBuilderOptions,
} from './core/input-builder.js';
export {
  type InstructionBundle,
  type InstructionBundlePaths,
  loadInstructionBundle,
  mergeInstructionBundle,
  type SystemInstructionBundle,
  type SystemInstructionVariant,
} from './core/instruction-bundle.js';
export {
  type InstructionTemplateContext,
  renderInstructionLayer,
} from './core/instruction-template.js';
export {
  buildMailboxBlock,
  buildMailboxBtwAwarenessBlock,
  createMailboxChecker,
  injectPendingMailboxMessages,
  type MailboxDeliveryMode,
  type MailboxLoopOptions,
} from './core/mailbox-loop.js';
export {
  evaluateModelCalendar,
  logicalCalendarTarget,
  type ModelBlackoutRule,
  type ModelCalendarDecision,
} from './core/model-availability-calendar.js';
export { runProviderWithRetry } from './core/provider-runner.js';
export {
  buildQueuedMessagesBlock,
  consumeQueuedMessagesUpdate,
  peekQueuedMessages,
  setQueuedMessagesSnapshot,
} from './core/queued-messages.js';
export { extractRunEnv, type RunEnv } from './core/run-env.js';
export {
  buildSessionNoteBlock,
  consumeSessionNotes,
  enqueueSessionNote,
  pendingSessionNoteCount,
  type SessionNote,
  type SessionNoteKind,
} from './core/session-notes.js';
export {
  DefaultSystemPromptBuilder,
  type DefaultSystemPromptBuilderOptions,
  LAYER_1_IDENTITY,
  SYSTEM_BLOCK_SOURCE,
  type SystemBlockSource,
} from './core/system-prompt-builder.js';
export {
  type DomainGlossaryOptions,
  renderDomainGlossary,
} from './core/system-prompt-glossary.js';
// Extension API
export {
  type AfterIterationHook,
  type AfterRunHook,
  type AfterToolExecutionHook,
  type AgentExtension,
  type BeforeIterationHook,
  type BeforeRunHook,
  type BeforeToolExecutionHook,
  type BeforeTurnEndHook,
  ExtensionRegistry,
  type OnErrorHook,
  type ProviderRunnerWrapper,
} from './extension/index.js';
export {
  countShellHooks,
  HookRegistry,
  type HookRunEnv,
  HookRunner,
  type HookRunnerOptions,
  hookMatcherMatches,
  type PreToolUseResult,
  type PromptResult,
  runShellHook,
  type ShellHookSpec,
  shellHooksEqual,
} from './hooks/index.js';
export {
  DefaultLogger,
  type DefaultLoggerOptions,
  type LogFormat,
} from './infrastructure/logger.js';
export { allServers } from './infrastructure/mcp-servers.js';
export {
  type ProviderCacheEntry,
  ProviderCacheLedger,
} from './infrastructure/provider-cache-ledger.js';
export { attachMailboxChecker } from './mailbox-attach.js';
// ---- Notifications (one-way channel-agnostic delivery) ----
export {
  type NotificationChannel,
  type NotificationChannelStatus,
  type NotificationLevel,
  type NotificationMessage,
  type NotificationResult,
  type Notifier,
  type NotifierCounters,
  NotifierImpl,
} from './notifications/index.js';
export * from './observability/network-telemetry.js';
export * from './observability/process-telemetry.js';
export { DefaultPluginAPI, definePlugin, type PluginAPIInit } from './plugin/api.js';
export {
  diffPluginConfig,
  type PluginConfigChange,
  type PluginConfigSource,
  type ResolvedPluginConfig,
  type ResolvePluginConfigInput,
  redactPluginConfig,
  resolvePluginConfig,
  resolvePluginManifestConfig,
  validatePluginConfigMetadata,
} from './plugin/config.js';
export {
  KERNEL_API_VERSION,
  type LoadPluginsOptions,
  loadPlugins,
  type PluginHostHandle,
  type PluginLoadFailure,
  unloadPlugins,
} from './plugin/loader.js';
// Built-in plugins
export {
  buildReviewerModelPool,
  createAutoReviewPlugin,
  parseReviewSeverity,
  type ReviewerModelAssignment,
  selectRoundRobinReviewerAssignment,
} from './plugins/auto-review-plugin.js';
export type {
  CascadeAgentKind,
  ChimeraCascadeNeededPayload,
  ChimeraReviewCompletePayload,
  ChimeraReviewNeededPayload,
  ResolvedChimeraConfig,
  ReviewContextBundle,
} from './plugins/chimera-plugin.js';
export {
  CHIMERA_REVIEW_PROMPT,
  createChimeraPlugin,
  resolveChimeraConfig,
} from './plugins/chimera-plugin.js';
export { createCloudConfigSyncPlugin } from './plugins/cloud-config-sync-plugin.js';
export { createPromptsPlugin } from './plugins/prompts-plugin.js';
export {
  executeFindingCommand,
  type FindingCommandContext,
  transitionReport,
} from './plugins/review-finding-commands.js';
export {
  type FindingsIntegrationResult,
  integrateFindings,
} from './plugins/review-finding-integration.js';
export {
  FINDING_STORE_FILE,
  type FindingStore,
  JsonlFindingStore,
  type ListOptions as FindingListOptions,
  type UpsertContext,
  type UpsertResult,
} from './plugins/review-finding-store.js';
export type {
  ChimeraFinding,
  ChimeraFindingLocation,
  ChimeraFindingOrigin,
  ChimeraFindingResolution,
  FindingEventType,
  FindingLifecycleEvent,
  FindingSeverity,
  FindingSource,
  FindingStatus,
  ResolutionOutcome,
} from './plugins/review-finding-types.js';
export {
  persistReviewReport,
  type ReportIntegrationResult,
  type ReportReopenResult,
  type ReportSyncResult,
  syncReportCompletion,
  syncReportReopen,
} from './plugins/review-report-integration.js';
export {
  JsonlReportStore,
  type ListReportsOptions,
  type PersistReportInput,
  REPORT_STORE_FILE,
  type ReportActor,
  type ReportStore,
} from './plugins/review-report-store.js';
export type {
  ReportEventType,
  ReportLifecycleStatus,
  ReviewReport,
  ReviewReportCounts,
  ReviewReportEvent,
  ReviewReportFile,
} from './plugins/review-report-types.js';
export { createSkillsPlugin } from './plugins/skills-plugin.js';
export { createSyncPlugin } from './plugins/sync-plugin.js';
export * from './prompts/index.js';
export {
  ensureGitignore,
  getPromptJournalEntries,
  type PromptCategory,
  type PromptJournalEntry,
  type PromptJournalFilter,
  type RecordPromptOptions,
  recordPromptJournalEntry,
} from './prompts/index.js';
export * from './public-coordination.js';
export * from './public-execution.js';
export * from './public-storage.js';
export { ProviderAuthRegistry } from './registry/provider-auth-registry.js';
export { type ProviderFactory, ProviderRegistry } from './registry/provider-registry.js';
export {
  type SlashCommand,
  type SlashCommandNotice,
  SlashCommandRegistry,
  type SlashCommandRegistryOptions,
} from './registry/slash-command-registry.js';
export type { ToolWrapper } from './registry/tool-registry.js';
export { ToolRegistry } from './registry/tool-registry.js';
export {
  hashRequest,
  stableStringify,
} from './replay/hash.js';
export {
  type ReplayMode,
  ReplayProviderRunner,
  type ReplayProviderRunnerOptions,
} from './replay/replay-provider-runner.js';
// Well-known tool capabilities + subagent capability helpers. Public so
// first-party consumers (CLI fleet host, plugins) can reason about and widen
// subagent capability allowlists instead of hardcoding capability strings.
export {
  DANGEROUS_FOR_SUBAGENTS,
  getDangerousCapabilities,
  hasCapability,
  hasDangerousCapabilityForSubagents,
  ToolCapabilities,
  type ToolCapability,
  WIDE_SUBAGENT_CAPABILITIES,
} from './security/capabilities.js';
export {
  evaluateToolKanbanBoundary,
  type ToolKanbanBoundaryEvaluation,
} from './security/kanban-boundary.js';
export {
  TRUST_POLICY_JSON_SCHEMA,
  TRUST_POLICY_LIMITS,
  TRUST_POLICY_SCHEMA_VERSION,
  type TrustPolicyDiagnostic,
  type TrustPolicyDiagnosticCode,
  type TrustPolicyValidationResult,
  validateTrustPolicy,
} from './security/permission-policy-schema.js';
export { DefaultSecretScrubber } from './security/secret-scrubber.js';
export * from './session-catalog/index.js';
export {
  getProjectSessionRegistry as getSessionRegistry,
  hasProjectSessionRegistry as hasSessionRegistry,
  ProjectSessionRegistry as SessionRegistry,
} from './session-catalog/registry.js';
export type {
  SessionLiveStatus,
  SessionRegistryEntry,
} from './session-catalog/session-registry.js';
export { attachSessionNotes } from './session-note-attach.js';
export * from './skills/index.js';
// DefaultTaskStore lives in task-store.ts (a sibling of task-tracker.ts).
// Re-exporting here from the package root so consumers can do
// `import { DefaultTaskStore, TaskTracker } from '@wrongstack/core'`
// without depending on the undeclared
// `@wrongstack/core/tasking/task-store.js` subpath (the package's
// `exports` field only declares the whole `./tasking` directory).
export { DefaultTaskStore } from './tasking/task-store.js';
// TaskTracker + TaskStore (the public task-graph mutation API). Lives
// under `tasking/` so it's not bundled with the heavy `types/` chain.
// Previously re-exported via `packages/sdd/src/task-tracker.js` only;
// the core re-export was missing, which broke consumers that tried
// `import { TaskTracker } from '@wrongstack/core/tasking/task-tracker.js'`
// (Node 16+ refuses the subpath under the new package.json exports
// contract, and the SDD re-export was never wired up to do it for them).
export {
  type TaskStore,
  TaskTracker,
  type TaskTrackerChange,
  type TaskTrackerListener,
  type TaskTrackerOptions,
  type TaskTransition,
} from './tasking/task-tracker.js';
export { expectDefined } from './utils/expect-defined.js';
export * from './utils/index.js';
export {
  readBundledInstructionText,
  renderInstructionTemplate,
} from './utils/instruction-file.js';
// Re-export safeParse explicitly at the top-level export for consumers
// who import from '@wrongstack/core' directly (e.g. providers package).
export {
  safeParse,
  safeStringify,
  sanitizeJsonString,
  stripCodeFences,
} from './utils/safe-json.js';
// Likewise pin the terminal helpers at the top-level public surface; consumers
// import them directly from '@wrongstack/core' rather than the util subpath.
export {
  getTermSize,
  isInteractive,
  isStdinTTY,
  isStdoutTTY,
  type OutputLineGuard,
  onResize,
  setOutputLineGuard,
  setRawMode,
  writeErr,
  writeOut,
} from './utils/term.js';
export {
  type AllocateOpts,
  assertSafePath,
  type MergeOpts,
  type MergeResult,
  type WorktreeHandle,
  WorktreeManager,
  type WorktreeManagerOptions,
  type WorktreeRunResult,
  type WorktreeStatus,
} from './worktree/index.js';
