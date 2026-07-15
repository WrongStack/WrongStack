// AutoPhase - autonomous phase-based workflow
export {
  type AutoPhaseOptions,
  AutoPhasePlanner,
  type AutoPhasePlannerOptions,
  type AutoPhasePlanResult,
  AutoPhaseRunner,
  type AutoPhaseRunnerOptions,
  type Checkpoint,
  CheckpointManager,
  type CheckpointManagerOptions,
  createAutoPhaseFromTaskGraph,
  PHASE_EVENT_NAMES,
  type PhaseEventMap,
  type PhaseEventName,
  type PhaseExecutionContext,
  type PhaseFilter,
  type PhaseGraph,
  PhaseGraphBuilder,
  type PhaseGraphBuilderOptions,
  type PhaseNode,
  PhaseOrchestrator,
  type PhaseOrchestratorOptions,
  type PhaseProgress,
  type PhaseSort,
  type PhaseStatus,
  PhaseStore,
  type PhaseStoreOptions,
  type PhaseTemplate,
} from './autophase/index.js';
export {
  type BootConfigOptions,
  type BootConfigResult,
  bootConfig,
  flagsToConfigPatch,
} from './boot.js';
export { allServers } from './infrastructure/mcp-servers.js';
export {
  type AgentFactory,
  type AgentFactoryResult,
  type AgentRunnerOptions,
  makeAgentSubagentRunner,
} from './coordination/agent-subagent-runner.js';
export {
  AGENT_CATALOG,
  AGENTS_BY_PHASE,
  type AgentDefinition,
  type AgentPhase,
  ALL_AGENT_DEFINITIONS,
  getAgentDefinition,
} from './coordination/agents/index.js';
// ---- Coordination (fleet/multi-agent tools) ----
export {
  type BrainArbiter,
  type BrainDecision,
  type BrainDecisionOption,
  BrainDecisionQueue,
  type BrainDecisionRequest,
  type BrainDecisionSource,
  type BrainFallback,
  type BrainRisk,
  type BrainEscalationMode,
  DefaultBrainArbiter,
  type DefaultBrainArbiterOptions,
  EscalationRoutingBrainArbiter,
  formatHumanPrompt,
  HumanEscalatingBrainArbiter,
  ObservableBrainArbiter,
  terminalPolicyDecision,
} from './coordination/brain.js';
export {
  brainDecisionKey,
  BrainDecisionLedger,
  type BrainDecisionLedgerOptions,
  type BrainLedgerEntry,
  createLedgerGuardBrainArbiter,
  type LedgerGuardBrainArbiterOptions,
} from './coordination/brain-ledger.js';
export {
  type BrainInterventionInput,
  BrainMonitor,
  type BrainMonitorOptions,
} from './coordination/brain-monitor.js';
export {
  type CollabBusState,
  CollaborationBus,
  type ConsumedInjectionInfo,
} from './coordination/collab-bus.js';
export {
  assessCommitSafety,
  type CommitSafetyOptions,
  type CommitSafetyReport,
  type ForeignFile,
} from './coordination/commit-safety.js';
// ── Dependency watcher — file-change → mailbox bridge ────────────────────
export {
  DEPENDENCY_FILE_PATTERNS,
  type DependencyWatcherConfig,
  type DepWatchEntry,
  makeDependencyWatcherConfig,
} from './coordination/dep-watcher.js';
export {
  attachDepWatcherBridge,
  type DepWatcherBridgeOptions,
} from './coordination/dep-watcher-bridge.js';
// Re-exported from ./coordination/index.js so they are available at the
// top-level @wrongstack/core import path.  Without this, consumers that
// `import { makeFleetEmitTool } from '@wrongstack/core'` get a runtime
// error even though the symbol exists in the ./coordination submodule.
export {
  Director,
  FleetCostCapError,
  FleetSpawnBudgetError,
  FleetTokenCapError,
  type TaskResultNotification,
} from './coordination/director.js';
export {
  DEFAULT_MAX_FLEET_SPAWNS,
  HARD_MAX_SPAWN_DEPTH,
  resolveMaxSpawnDepth,
} from './coordination/spawn-budget.js';
export {
  type DirectorSessionFactory,
  type DirectorSessionFactoryOptions,
  makeDirectorSessionFactory,
} from './coordination/director-session.js';
export {
  makeAskTool,
  makeAssignTool,
  makeAwaitTasksTool,
  makeCollabDebugTool,
  makeFleetEmitTool,
  makeFleetTool,
  makeKanbanQueueTool,
  makeQualityGateTool,
  makeRollUpTool,
  makeSpawnTool,
  makeTerminateTool,
} from './coordination/director-tools.js';
export {
  formatSubagentStructuredReport,
  MAX_SUBAGENT_STRUCTURED_REPORT_CHARS,
  makeSubagentResultTool,
  normalizeSubagentStructuredReport,
  readSubagentStructuredReport,
  SUBAGENT_STRUCTURED_REPORT_META_KEY,
} from './coordination/subagent-result-tool.js';
export {
  DEFAULT_DISPATCH_ROLE,
  type DispatchCandidate,
  type DispatchClassifier,
  type DispatchMethod,
  type DispatchOptions,
  type DispatchResult,
  dispatchAgent,
  makeLLMClassifier,
  scoreAgents,
} from './coordination/dispatcher.js';
export {
  compactLog,
  type FileAuthorEntry,
  type FileAuthorLog,
  type FileAuthorTrackerOptions,
  getFileHistory,
  getFilesByAgent,
  getFullLog,
  getLastAuthor,
  recordFileAction,
} from './coordination/file-author-tracker.js';
export {
  ACP_AGENTS,
  ALL_FLEET_AGENTS,
  applyRosterBudget,
  FLEET_ROSTER,
  FLEET_ROSTER_BUDGETS,
  FLEET_ROSTER_WITHACP,
  type FleetRosterBudget,
} from './coordination/fleet.js';
export {
  FleetBus,
  type FleetEvent,
  type FleetHandler,
  type FleetUsage,
  FleetUsageAggregator,
  type SubagentUsageSnapshot,
} from './coordination/fleet-bus.js';
export {
  FleetManager,
  type FleetManagerOptions,
} from './coordination/fleet-manager.js';
export {
  type FleetStatusToolOptions,
  makeFleetStatusTool,
} from './coordination/fleet-status-tool.js';
export {
  FleetSupervisor,
  type FleetSupervisorActions,
  type FleetSupervisorOptions,
  type FleetSupervisorSource,
  type SupervisedSubagent,
  type SupervisorLogEntry,
} from './coordination/fleet-supervisor.js';
export { GlobalMailbox, resolveProjectDir, getSharedMailbox, _clearMailboxSingletons } from './coordination/global-mailbox.js';
export type { AutoCompactOptions, AutoCompactResult } from './coordination/mailbox-types.js';
export { MailboxEventEmitter } from './coordination/mailbox-events.js';
export type { MailboxEvent, MailboxEventType, MailboxEventListener } from './coordination/mailbox-events.js';
export {
  SessionRegistry,
  getSessionRegistry,
  hasSessionRegistry,
  type SessionRegistryEntry,
  type SessionLiveStatus,
} from './session-registry.js';
export * from './coordination/index.js';
export {
  type MailToolsOptions,
  makeMailInboxTool,
  makeMailSendTool,
} from './coordination/mail-tools.js';
// ── Mailbox — inter-agent messaging ──────────────────────────────────────
export { DefaultMailbox } from './coordination/mailbox.js';
export {
  type MailboxResolver,
  type MailboxToolOptions,
  mailboxSessionTag,
  makeMailboxTool,
  resolveMailboxIdentity,
} from './coordination/mailbox-tool.js';
export type {
  AgentHeartbeatInput,
  AgentRegistrationInput,
  Mailbox,
  MailboxAckInput,
  MailboxAgentStatus,
  MailboxMessage,
  MailboxMessageType,
  MailboxQuery,
  MailboxSendInput,
  MailboxTaskContext,
  ReadReceipts,
  RegisteredAgent,
} from './coordination/mailbox-types.js';
export { normalizeRecipient } from './coordination/mailbox-types.js';
export {
  isValidMatrixKey,
  MATRIX_PHASE_KEYS,
  type MatrixKeyKind,
  type ModelMatrixResolution,
  type ModelMatrixResolutionSource,
  type ModelReference,
  matrixKeyKind,
  phaseForRole,
  type ResolvedModelTarget,
  type ResolvedSubagentModelTarget,
  resolveImplementationModelTarget,
  resolveModelMatrix,
  resolveModelMatrixResolution,
  resolveModelTargetFromEntry,
  resolveSubagentModelTarget,
  roleNeedsIndependentReviewModel,
  sameModelReference,
} from './coordination/model-matrix.js';
export { NULL_FLEET_BUS } from './coordination/null-fleet-bus.js';
export {
  detectEcosystem as detectPackageEcosystem,
  getFullPackageLog,
  getManifestPackages,
  getPackageAuthor,
  getPackagesByAgent,
  type PackageAuthorEntry,
  type PackageAuthorLog,
  type PackageAuthorTrackerOptions,
  recordPackageAction,
  updatePackageOutdatedStatus,
} from './coordination/package-author-tracker.js';
export {
  type OutdatedNotifyMessage,
  type PackageOutdatedEntry,
  type PackageOutdatedResult,
  type PackageOutdatedWatcherOptions,
  startPackageOutdatedWatcher,
} from './coordination/package-outdated-watcher.js';
export {
  assignNickname,
  type NicknameAssignment,
  nicknameKeyFromDisplay,
} from './coordination/subagent-nicknames.js';
export {
  startTechStackConsumer,
  type TechStackConsumerOptions,
} from './coordination/techstack-mailbox-consumer.js';
export {
  type FleetWorktreePolicy,
  resolveSubagentWorktreeDecision,
  subagentNeedsWorktree,
  WorktreeIntegrationError,
  type WorktreeIsolationDecision,
  type WorktreeTaskRunnerOptions,
  type WorktreeTaskStateUpdate,
  wrapSubagentRunnerWithWorktrees,
} from './coordination/worktree-task-runner.js';
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
export { Context, type ContextInit, type RunOptions, type TodoItem } from './core/context.js';
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
  smartDefaultFallbackChain,
} from './core/fallback-model.js';
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
} from './core/instruction-bundle.js';
export {
  buildMailboxBlock,
  buildMailboxBtwAwarenessBlock,
  createMailboxChecker,
  injectPendingMailboxMessages,
  type MailboxDeliveryMode,
  type MailboxLoopOptions,
} from './core/mailbox-loop.js';
export { runProviderWithRetry } from './core/provider-runner.js';
export {
  buildQueuedMessagesBlock,
  consumeQueuedMessagesUpdate,
  peekQueuedMessages,
  setQueuedMessagesSnapshot,
} from './core/queued-messages.js';
export { extractRunEnv, type RunEnv } from './core/run-env.js';
export {
  DefaultSystemPromptBuilder,
  type DefaultSystemPromptBuilderOptions,
  LAYER_1_IDENTITY,
} from './core/system-prompt-builder.js';
export * from './defaults/index.js';
export {
  AutoCompactionMiddleware,
  type CompactorOptions,
  type CompactorStrategy,
  createStrategyCompactor,
  HybridCompactor,
  IntelligentCompactor,
  type IntelligentCompactorOptions,
  SelectiveCompactor,
  type SelectiveCompactorOptions,
  type StrategyCompactorOptions,
} from './defaults/index.js';
export {
  type AutonomyBrainOptions,
  type BrainAutoRisk,
  type BrainLlmTarget,
  buildBrainUserMessage,
  completeBrainLlm,
  createAutonomyBrain,
  createTieredBrainArbiter,
  formatDecisionSummary,
  parseOptionDecision,
  type TieredBrainArbiterOptions,
} from './execution/autonomy-brain.js';
export {
  assembleBrainTiers,
  type BrainTierAssembly,
  type BrainTierAssemblyOptions,
} from './execution/brain-chain.js';
export {
  BRAIN_EVALUATION_CASE_VERSION,
  type BrainEvaluationCaseResult,
  type BrainEvaluationCaseV1,
  type BrainEvaluationCaseValidation,
  type BrainEvaluationExpectations,
  type BrainEvaluationFailure,
  type BrainEvaluationFailureCode,
  type BrainEvaluationMetrics,
  type BrainEvaluationReport,
  runBrainEvaluation,
  validateBrainEvaluationCase,
} from './execution/brain-evaluation.js';
export {
  type BrainApplyResult,
  type BrainConfigPatch,
  type BrainConfigSnapshot,
  type BrainCouncilMinRisk,
  type BrainCouncilPatch,
  type BrainDefaultsContext,
  type BrainPoolStrategy,
  type BrainRuntime,
  type BrainRuntimeLedgerHost,
  type BrainRuntimeOptions,
  createBrainRuntime,
  resolveBrainConfigDefaults,
} from './execution/brain-runtime.js';
export {
  COUNCIL_REFUSE_OPTION_ID,
  type CouncilBrainOptions,
  type CouncilVoter,
  createCouncilBrainArbiter,
} from './execution/council-brain.js';
export {
  BUILTIN_COUNCIL_PERSONAS,
  CouncilPersonaRegistry,
  createCouncilPersonaRegistry,
  DEFAULT_COUNCIL_PERSONA_REGISTRY,
} from './execution/council-personas.js';
export {
  BUILTIN_COUNCIL_PROFILES,
  CouncilProfileRegistry,
  createCouncilProfileRegistry,
  DEFAULT_COUNCIL_APPROVAL_FRACTION,
  DEFAULT_COUNCIL_JUDGE_MAX_TOKENS,
  DEFAULT_COUNCIL_OVERALL_TIMEOUT_MS,
  DEFAULT_COUNCIL_PER_CALL_TIMEOUT_MS,
  DEFAULT_COUNCIL_PROFILE_REGISTRY,
  DEFAULT_COUNCIL_QUORUM_FRACTION,
  DEFAULT_COUNCIL_VOTER_MAX_TOKENS,
  normalizeCouncilProfile,
  resolveCouncilProfile,
} from './execution/council-profiles.js';
export {
  buildCouncilJudgeSystemPrompt,
  buildCouncilJudgeUserPrompt,
  buildCouncilQuestionPrompt,
  buildCouncilVoterSystemPrompt,
  buildCouncilVoterUserPrompt,
  COUNCIL_JUDGE_PROMPT_PATH,
  COUNCIL_VOTER_PROMPT_PATH,
} from './execution/council-prompts.js';
export {
  COUNCIL_REFUSAL_OPTION_ID,
  CouncilOrchestrator,
  type CouncilOrchestratorOptions,
  DEFAULT_COUNCIL_MAX_CONCURRENCY,
  MAX_COUNCIL_CONCURRENCY,
} from './execution/council-orchestrator.js';
export {
  type CouncilResolution,
  type CouncilResolutionInput,
  type CouncilResolutionSeat,
  type CouncilResolutionVote,
  resolveCouncilVotes,
} from './execution/council-resolution.js';
export {
  buildLosslessDigest,
  buildSmartDigest,
  type ContentScore,
  type EliseResult,
  eliseOldToolResults,
  estimateMessages,
  extractText,
  findPreserveStart,
  hasTextContent,
  scoreMessage,
} from './execution/compaction-core.js';
export {
  applyModelRuntime,
  type ModelRuntimeMiddlewareOptions,
  mergeModelRuntime,
  type ResolvedModelRuntime,
  resolveCacheForRequest,
  resolveModelRuntime,
  resolveReasoningForRequest,
} from './execution/model-runtime.js';
export {
  ENHANCE_BASE_TIMEOUT_MS,
  ENHANCE_MIN_RETRY_TIMEOUT_MS,
  nextEnhanceTimeout,
  resolveEnhanceFallbackRef,
} from './execution/enhance-recovery.js';
export {
  type ConversationTurn,
  ENHANCER_SYSTEM_PROMPT,
  type EnhanceFailureKind,
  type EnhanceResult,
  type EnhanceUserPromptOptions,
  enhanceUserPrompt,
  gatedEnhancerReasoning,
  normalizedEqual,
  recentTextTurns,
  shouldEnhance,
} from './execution/prompt-enhancer.js';
// Extension API
export {
  type AfterIterationHook,
  type AfterRunHook,
  type AfterToolExecutionHook,
  type AgentExtension,
  type BeforeIterationHook,
  type BeforeRunHook,
  type BeforeToolExecutionHook,
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
export * from './hq/index.js';
export * from './kernel/index.js';
export { attachMailboxChecker } from './mailbox-attach.js';
export {
  type CollabPauseMiddlewareOptions,
  collabInjectMiddleware,
  collabPauseMiddleware,
  type InjectedToolResult as CollabInjectedToolResult,
} from './middleware/collab-pause.js';
export { DefaultPluginAPI, definePlugin, type PluginAPIInit } from './plugin/api.js';
export {
  KERNEL_API_VERSION,
  type LoadPluginsOptions,
  loadPlugins,
  unloadPlugins,
} from './plugin/loader.js';
export type {
  ChimeraReviewNeededPayload,
  ResolvedChimeraConfig,
} from './plugins/chimera-plugin.js';
export {
  CHIMERA_REVIEW_PROMPT,
  createChimeraPlugin,
  resolveChimeraConfig,
} from './plugins/chimera-plugin.js';

// Built-in plugins
export { createAutoReviewPlugin } from './plugins/auto-review-plugin.js';
export { createPromptsPlugin } from './plugins/prompts-plugin.js';
export { createSecurityPlugin } from './plugins/security-plugin.js';
export { createSkillsPlugin } from './plugins/skills-plugin.js';
export { createSyncPlugin } from './plugins/sync-plugin.js';
export * from './prompts/index.js';
export { type ProviderFactory, ProviderRegistry } from './registry/provider-registry.js';
export {
  type SlashCommand,
  SlashCommandRegistry,
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
export { DefaultSecretScrubber } from './security/secret-scrubber.js';
export * from './skills/index.js';
export * from './storage/index.js';
// Explicit re-exports for the new session audit bridge (helps some consumers
// and declaration bundlers pick them up reliably).
export {
  type AuditLevel,
  createSessionEventBridge,
  resolveAuditLevel,
  resolveSessionLoggingConfig,
  type SessionEventBridge,
  type SessionEventBridgeOptions,
  type SessionSamplingOptions,
  type ToolProgressSamplingOptions,
} from './storage/session-event-bridge.js';
export { createMcpControlTool, type MCPRegistryHandle } from './tools/mcp-control.js';
export { createMcpUseTool } from './tools/mcp-use.js';
export {
  COUNCIL_TOOL_NAME,
  type CouncilToolInput,
  type CreateCouncilToolOptions,
  createCouncilTool,
  MAX_COUNCIL_CONTEXT_CHARS,
  MAX_COUNCIL_QUESTION_CHARS,
  MAX_COUNCIL_TOOL_OPTIONS,
} from './tools/council-tool.js';
export { createOneShotLLMTool, ONE_SHOT_LLM_TOOL_NAME, type CreateOneShotLLMToolOptions } from './tools/one-shot-llm-tool.js';
export { OneShotOrchestrator } from './execution/one-shot-llm.js';
export type { Compactor, CompactReport } from './types/compactor.js';
export {
  CONTEXT_WINDOW_MODES,
  type ContextWindowAggressiveOn,
  type ContextWindowConfigLike,
  type ContextWindowMode,
  type ContextWindowModeId,
  type ContextWindowPolicy,
  type ContextWindowThresholds,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  formatContextWindowModeList,
  getContextWindowMode,
  isContextWindowModeId,
  listContextWindowModes,
  resolveContextWindowPolicy,
} from './types/context-window.js';
export { DEFAULT_SESSION_PRUNE_DAYS } from './types/default-config.js';
export * from './types/index.js';
export type { Logger, LogLevel } from './types/logger.js';
// Explicit type re-exports keep the top-level public surface stable for types
// that are reachable through both types/ and defaults/ export chains.
// Consumers (e.g. @wrongstack/providers) import these directly from '@wrongstack/core'.
export type {
  ModelsDevModel,
  ModelsDevPayload,
  ModelsDevProvider,
  ModelsRegistry,
  ResolvedModel,
  ResolvedProvider,
  WireFamily,
} from './types/models-registry.js';
export type { ProviderRunner, RunProviderOptions } from './types/provider-runner.js';
export type { SecretScrubber } from './types/secret-scrubber.js';
export type { RotatableSecretVault, SecretVault } from './types/secret-vault.js';
export {
  TRUST_POLICY_JSON_SCHEMA,
  TRUST_POLICY_LIMITS,
  TRUST_POLICY_SCHEMA_VERSION,
  type TrustPolicyDiagnostic,
  type TrustPolicyDiagnosticCode,
  type TrustPolicyValidationResult,
  validateTrustPolicy,
} from './security/permission-policy-schema.js';
export {
  encryptedPrefixForVersion,
  noOpVault,
  parseEncryptedVersion,
} from './types/secret-vault.js';
export type { CacheStats, TokenCounter } from './types/token-counter.js';
export { expectDefined } from './utils/expect-defined.js';
export * from './utils/index.js';
export {
  readBundledInstructionText,
  renderInstructionTemplate,
} from './utils/instruction-file.js';
// Re-export safeParse explicitly at the top-level export for consumers
// who import from '@wrongstack/core' directly (e.g. providers package).
export { safeParse, safeStringify, sanitizeJsonString, stripCodeFences } from './utils/safe-json.js';
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
// TaskTracker + TaskStore (the public task-graph mutation API). Lives
// under `tasking/` so it's not bundled with the heavy `types/` chain.
// Previously re-exported via `packages/sdd/src/task-tracker.js` only;
// the core re-export was missing, which broke consumers that tried
// `import { TaskTracker } from '@wrongstack/core/tasking/task-tracker.js'`
// (Node 16+ refuses the subpath under the new package.json exports
// contract, and the SDD re-export was never wired up to do it for them).
export {
  type TaskStore,
  type TaskTrackerOptions,
  type TaskTransition,
  type TaskTrackerChange,
  type TaskTrackerListener,
  TaskTracker,
} from './tasking/task-tracker.js';
// DefaultTaskStore lives in task-store.ts (a sibling of task-tracker.ts).
// Re-exporting here from the package root so consumers can do
// `import { DefaultTaskStore, TaskTracker } from '@wrongstack/core'`
// without depending on the undeclared
// `@wrongstack/core/tasking/task-store.js` subpath (the package's
// `exports` field only declares the whole `./tasking` directory).
export { DefaultTaskStore } from './tasking/task-store.js';
