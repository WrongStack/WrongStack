// =============================================================================
// @wrongstack/core — defaults barrel (backward-compatible re-exports)
//
// All implementation lives in top-level domain directories under src/.
// This file re-exports for consumers that use the defaults entrypoint.
// New code should import directly from the domain subpath.
//
// Sections:
//   Infrastructure   — Logger, TokenCounter, PathResolver, ContextManager, MCP servers
//   Storage          — SessionStore, MemoryStore, ConfigStore/Loader, Plan, Todos,
//                      RecoveryLock, SessionReader, DirectorState
//   Security         — SecretScrubber, SecretVault, PermissionPolicy
//   Execution        — RetryPolicy, ErrorHandler, SkillLoader, Compactors,
//                      ToolExecutor, AutonomousRunner, ProviderRunner
//   Coordination     — Director, Delegate, MultiAgentCoordinator, SubagentBudget,
//                      FleetBus, AgentBridge, Fleet roster presets
//   Models           — ModelsRegistry, ModeStore, LLMSelector
//   SDD              — SpecParser, TaskGenerator, TaskTracker, TaskFlow
//   Observability    — Metrics, Traces, Prometheus, OTLP, HealthRegistry
// =============================================================================
//
// =============================================================================

export {
  createMessage,
  InMemoryAgentBridge,
  InMemoryBridgeTransport,
} from '../coordination/agent-bridge.js';
export {
  type AgentFactory,
  type AgentFactoryResult,
  type AgentRunnerOptions,
  makeAgentSubagentRunner,
} from '../coordination/agent-subagent-runner.js';
export {
  AGENT_CATALOG,
  AGENTS_BY_PHASE,
  type AgentBudgetTier,
  type AgentCapability,
  type AgentDefinition,
  type AgentPhase,
  ALL_AGENT_DEFINITIONS,
  getAgentDefinition,
} from '../coordination/agents/index.js';
export {
  type AutoExtendCeiling,
  type AutoExtendPolicy,
  attachAutoExtend,
} from '../coordination/auto-extend.js';
export {
  type CreateDelegateToolOptions,
  createDelegateTool,
  type DelegateHost,
} from '../coordination/delegate-tool.js';
// ---- Coordination (multi-agent) ----
export {
  Director,
  FleetSpawnBudgetError,
} from '../coordination/director.js';
export {
  composeDirectorPrompt,
  composeSubagentPrompt,
  DEFAULT_DIRECTOR_PREAMBLE,
  DEFAULT_SUBAGENT_BASELINE,
  type DirectorPromptParts,
  rosterSummaryFromConfigs,
  type SubagentPromptParts,
} from '../coordination/director-prompts.js';
export {
  type DirectorSessionFactory,
  type DirectorSessionFactoryOptions,
  makeDirectorSessionFactory,
} from '../coordination/director-session.js';
export {
  makeAskTool,
  makeAssignTool,
  makeAwaitTasksTool,
  makeCollabDebugTool,
  makeFleetEmitTool,
  makeFleetHealthTool,
  makeFleetSessionTool,
  makeFleetStatusTool,
  makeFleetUsageTool,
  makeRollUpTool,
  makeSpawnTool,
  makeTerminateTool,
} from '../coordination/director-tools.js';
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
} from '../coordination/dispatcher.js';
export {
  ALL_FLEET_AGENTS,
  AUDIT_LOG_AGENT,
  applyRosterBudget,
  BUG_HUNTER_AGENT,
  FLEET_ROSTER,
  FLEET_ROSTER_BUDGETS,
  type FleetRosterBudget,
  REFACTOR_PLANNER_AGENT,
  SECURITY_SCANNER_AGENT,
} from '../coordination/fleet.js';
export {
  FleetBus,
  type FleetEvent,
  type FleetHandler,
  type FleetUsage,
  FleetUsageAggregator,
  type SubagentUsageSnapshot,
} from '../coordination/fleet-bus.js';
export type { ICoordinator } from '../coordination/icoordinator.js';
export type { IFleetManager } from '../coordination/ifleet-manager.js';
export {
  DefaultMultiAgentCoordinator,
  type MultiAgentCoordinatorOptions,
} from '../coordination/multi-agent-coordinator.js';
export { NULL_FLEET_BUS } from '../coordination/null-fleet-bus.js';
export {
  BudgetExceededError,
  type BudgetKind,
  type BudgetLimits,
  type BudgetUsage,
  SubagentBudget,
} from '../coordination/subagent-budget.js';
export { AutoCompactionMiddleware } from '../execution/auto-compaction-middleware.js';
export {
  AutonomousRunner,
  type AutonomousRunnerOptions,
  type DoneCheckResult,
  DoneConditionChecker,
} from '../execution/autonomous-runner.js';
export {
  type AutonomyPromptContributorOptions,
  makeAutonomyPromptContributor,
} from '../execution/autonomy-prompt-contributor.js';
export {
  type CompactorOptions,
  DEFAULT_AUTONOMY_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_TOOLS_CONFIG,
  HybridCompactor,
} from '../execution/compactor.js';
export {
  activateDesign,
  clearActiveKit,
  detectFrontendFile,
  detectFrontendIntent,
  getDesignState,
  installDesignStudioMiddleware,
  makeDesignDetectToolCallMiddleware,
  makeDesignDetectUserInputMiddleware,
  makeDesignStudioRequestMiddleware,
  setActiveKit,
  setDesignOverrides,
} from '../execution/design-detect.js';
export {
  _resetDesignKitLoaderMemo,
  DefaultDesignKitLoader,
  type DesignKitLoaderOptions,
  getDesignKitLoader,
  resolveBundledDesignKitsDir,
} from '../execution/design-kit-loader.js';
export {
  colorToHex,
  isColorToken,
  oklchToHex,
  parseOklch,
} from '../execution/design-color.js';
export {
  type MaterializeResult,
  materializeTokens,
} from '../execution/design-materialize.js';
export {
  type DesignVerifyReport,
  type DesignViolation,
  verifyFiles,
} from '../execution/design-verify.js';
export {
  _resetDesignRulesCache,
  applyTokenOverrides,
  clearPersistedActiveKit,
  designProjectDir,
  type DesignOverrides,
  loadActiveKit,
  loadProjectDesignRules,
  type PersistedActiveKit,
  recordKitChoice,
  recordOverrides,
} from '../execution/design-project-store.js';
export { DefaultErrorHandler } from '../execution/error-handler.js';
export {
  EternalAutonomyEngine,
  type EternalAutonomyOptions,
  type EternalEngineState,
  type IterationStage,
} from '../execution/eternal-autonomy.js';
export { buildGoalPreamble } from '../execution/goal-preamble.js';
export {
  IntelligentCompactor,
  type IntelligentCompactorOptions,
} from '../execution/intelligent-compactor.js';
export {
  type ParallelEngineState,
  ParallelEternalEngine,
  type ParallelEternalOptions,
  type ParallelIterationStage,
} from '../execution/parallel-eternal-engine.js';
export { DefaultProviderRunner } from '../execution/provider-runner-impl.js';
// ---- Execution ----
export { DefaultRetryPolicy } from '../execution/retry-policy.js';
export {
  SelectiveCompactor,
  type SelectiveCompactorOptions,
} from '../execution/selective-compactor.js';
export { DefaultSkillLoader, type SkillLoaderOptions } from '../execution/skill-loader.js';
export {
  type CompactorStrategy,
  createStrategyCompactor,
  type StrategyCompactorOptions,
} from '../execution/strategy-compactor.js';
export { ToolExecutor } from '../execution/tool-executor.js';
// ---- Context manager (tool) ----
export {
  type ContextManagerAction,
  type ContextManagerInput,
  type ContextManagerResult,
  type ContextManagerToolOptions,
  contextManagerTool,
  createContextManagerTool,
} from '../infrastructure/context-manager.js';
// ---- Infrastructure (was core/) ----
export {
  DefaultLogger,
  type DefaultLoggerOptions,
  type LogFormat,
} from '../infrastructure/logger.js';
// ---- MCP servers ----
export {
  allServers,
  awsServer,
  blockServer,
  braveSearchServer,
  context7Server,
  everArtServer,
  filesystemServer,
  githubServer,
  googleMapsServer,
  miniMaxVisionServer,
  playwrightServer,
  sentinelServer,
  slackServer,
  sshManagerServer,
  zaiVisionServer,
} from '../infrastructure/mcp-servers.js';
export { CODEX_MODELS, type CodexModelMeta, codexModelMeta } from '../models/codex-catalog.js';
export { LLMSelector, type LLMSelectorOptions } from '../models/llm-selector.js';
export {
  DefaultModeStore,
  loadProjectModes,
  loadUserModes,
  type ModeLoaderOptions,
} from '../models/mode-store.js';
// ---- Models ----
export {
  classifyFamily,
  DefaultModelsRegistry,
  type DefaultModelsRegistryOptions,
} from '../models/models-registry.js';
export {
  describeCatalogModel,
  type ProviderModelDescriptor,
  resolveProviderModelList,
} from '../models/provider-model-resolve.js';
// ---- Observability ----
export {
  buildOtlpMetricsRequest,
  buildOtlpTracesRequest,
  DefaultHealthRegistry,
  InMemoryMetricsSink,
  type MetricsServerHandle,
  type MetricsServerOptions,
  NoopMetricsSink,
  NoopTracer,
  OTelTracer,
  type OtlpMetricsExporterHandle,
  type OtlpMetricsExporterOptions,
  type OtlpTraceExporterHandle,
  type OtlpTraceExporterOptions,
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheus,
  startMetricsServer,
  startOtlpMetricsExporter,
  startOtlpTraceExporter,
  wireMetricsToEvents,
} from '../observability/index.js';
export {
  AutoExecutor,
  type AutoExecutorOptions,
  createAutoExecutor,
  type ExecutionSummary,
  type TaskExecutionContext,
  type TaskExecutionResult,
} from '../sdd/auto-executor.js';
// Live SDD board: model, persistence, projector, run registry.
export {
  buildBoardSnapshot,
  buildBoardTasks,
  type SddBoardColumn,
  type SddBoardFeedEntry,
  type SddBoardSnapshot,
  type SddBoardStatus,
  type SddBoardTask,
  type SddDeadlockChain,
  type SddTaskDisplayStatus,
  shortIdMap,
} from '../sdd/board-types.js';
export {
  type ConflictSide,
  hasConflictMarkers,
  type LlmConflictResolverOptions,
  makeLlmConflictResolver,
  makePreferSideConflictResolver,
  resolveConflictText,
} from '../sdd/conflict-resolver.js';
export {
  analyzeCriticalPath,
  type BottleneckTask,
  type CriticalPathAnalysis,
} from '../sdd/critical-path.js';
export { makeLlmSubtaskGenerator, type SubtaskGeneratorOptions } from '../sdd/decompose-task.js';
export { SddBoardProjector, type SddBoardProjectorOptions } from '../sdd/sdd-board-projector.js';
export {
  type SddBoardEvent,
  type SddBoardIndexEntry,
  SddBoardStore,
  type SddBoardStoreOptions,
} from '../sdd/sdd-board-store.js';
export {
  isExplanatoryText,
  type SddIngestResult,
  SddInterviewDriver,
  type SddInterviewDriverOptions,
  type SddInterviewSnapshot,
} from '../sdd/sdd-interview-driver.js';
export {
  cleanupSddWorktrees,
  type DestroySddProjectOptions,
  type DestroySddProjectResult,
  destroySddProject,
  type RollbackFromDiskOptions,
  rollbackSddRunFromDisk,
} from '../sdd/sdd-lifecycle.js';
export {
  type RunResult,
  SddParallelRun,
  type SddParallelRunOptions,
  type SddProgress,
  type SddSubtaskSpec,
  type SddSupervisorVerdict,
  type WaveResult,
} from '../sdd/sdd-parallel-run.js';
export { type SddRunControl, SddRunRegistry } from '../sdd/sdd-run-registry.js';
export { SddSupervisor, type SddSupervisorOptions } from '../sdd/sdd-supervisor.js';
export {
  SddTaskDecomposer,
  type SddTaskDecomposerOptions,
  type TaskBatch,
} from '../sdd/sdd-task-decomposer.js';
export {
  AISpecBuilder,
  type AISpecBuilderOptions,
  type AISpecPhase,
  type AISpecSession,
  type CollectedAnswer,
} from '../sdd/spec-builder.js';
// ---- SDD ----
export { SpecParser } from '../sdd/spec-parser.js';
export { type SpecIndexEntry, SpecStore, type SpecStoreOptions } from '../sdd/spec-store.js';
export {
  getTemplate,
  listTemplates,
  SPEC_TEMPLATES,
  templateToMarkdown,
} from '../sdd/spec-templates.js';
export { type SpecDiff, type SpecVersion, SpecVersioning } from '../sdd/spec-versioning.js';
export {
  type SddRunHandle,
  type StartSddRunOptions,
  startSddRun,
} from '../sdd/start-sdd-run.js';
export {
  SpecDrivenDev,
  type SpecDrivenDevOptions,
  TaskFlow,
  type TaskFlowEventMap,
  type TaskFlowEventName,
  type TaskFlowExecutionContext,
  type TaskFlowOptions,
  type TaskFlowPhase,
} from '../sdd/task-flow.js';
export {
  DefaultTaskStore,
  extractVerificationCommand,
  type GeneratedTask,
  TaskGenerator,
  type TaskGeneratorOptions,
} from '../sdd/task-generator.js';
export {
  type TaskGraphIndexEntry,
  TaskGraphStore,
  type TaskGraphStoreOptions,
} from '../sdd/task-graph-store.js';
export {
  type TaskStore,
  TaskTracker,
  type TaskTrackerOptions,
  type TaskTransition,
} from '../sdd/task-tracker.js';
export {
  renderProgress,
  renderSpecAnalysis,
  renderTaskGraph,
  renderTaskList,
} from '../sdd/task-visualizer.js';
export { type CommandVerifierOptions, makeCommandVerifier } from '../sdd/verify-task.js';
export {
  AutoApprovePermissionPolicy,
  DefaultPermissionPolicy,
  type PermissionPolicyOptions,
} from '../security/permission-policy.js';
// ---- Security ----
export { DefaultSecretScrubber } from '../security/secret-scrubber.js';
export {
  DefaultSecretVault,
  decryptConfigSecrets,
  encryptConfigSecrets,
  migratePlaintextSecrets,
  rewriteConfigEncrypted,
  type SecretVaultOptions,
} from '../security/secret-vault.js';
export {
  type AttachmentStoreOptions,
  DefaultAttachmentStore,
} from '../storage/attachment-store.js';
export {
  type ConfigLoaderOptions,
  type ConfigSource,
  DefaultConfigLoader,
} from '../storage/config-loader.js';
export {
  type ConfigMigration,
  ConfigMigrationError,
  DEFAULT_CONFIG_MIGRATIONS,
  type MigrationContext,
  type MigrationResult,
  runConfigMigrations,
} from '../storage/config-migration.js';
export { DefaultConfigStore } from '../storage/config-store.js';
export {
  DirectorStateCheckpoint,
  type DirectorStateSnapshot,
  type DirectorSubagentState,
  type DirectorTaskState,
  loadDirectorState,
} from '../storage/director-state.js';
export {
  DefaultMemoryStore,
  type MemoryStoreOptions,
} from '../storage/memory-store.js';
export {
  addPlanItem,
  attachPlanCheckpoint,
  clearPlan,
  deriveTodosFromPlanItem,
  emptyPlan,
  formatPlan,
  loadPlan,
  type PlanFile,
  type PlanItem,
  removePlanItem,
  savePlan,
  setPlanItemStatus,
} from '../storage/plan-store.js';
export {
  formatPlanTemplates,
  getPlanTemplate,
  listPlanTemplates,
  type PlanTemplate,
} from '../storage/plan-templates.js';
export {
  type PersistedQueueItem,
  QueueStore,
} from '../storage/queue-store.js';
export {
  type AbandonedSession,
  RecoveryLock,
  type RecoveryLockOptions,
} from '../storage/recovery-lock.js';
export { SessionAnalyzer } from '../storage/session-analyzer.js';
export {
  type AuditLevel,
  createSessionEventBridge,
  resolveAuditLevel,
  resolveSessionLoggingConfig,
  type SessionEventBridge,
  type SessionEventBridgeOptions,
  type SessionSamplingOptions,
  type ToolProgressSamplingOptions,
} from '../storage/session-event-bridge.js';
export { DefaultSessionReader } from '../storage/session-reader.js';
// ---- Storage ----
export {
  DefaultSessionStore,
  type SessionStoreOptions,
} from '../storage/session-store.js';
export {
  attachTodosCheckpoint,
  loadTodosCheckpoint,
  saveTodosCheckpoint,
  type TodosCheckpointFile,
} from '../storage/todos-checkpoint.js';
