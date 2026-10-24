// ---- Coordination (fleet/multi-agent tools) ----
export {
  type BrainArbiter,
  type BrainDecision,
  type BrainDecisionOption,
  BrainDecisionQueue,
  type BrainDecisionRequest,
  type BrainDecisionSource,
  type BrainEscalationMode,
  type BrainFallback,
  type BrainRisk,
  type BrainTerminalPolicy,
  DefaultBrainArbiter,
  type DefaultBrainArbiterOptions,
  EscalationRoutingBrainArbiter,
  formatHumanPrompt,
  HumanEscalatingBrainArbiter,
  ObservableBrainArbiter,
  terminalPolicyDecision,
} from './brain/brain.js';
export {
  type BrainCacheStats,
  BrainDecisionCache,
  type BrainDecisionCacheOptions,
  brainCacheKey,
  type CachingBrainArbiterOptions,
  createCachingBrainArbiter,
} from './brain/brain-cache.js';
export {
  type BrainDecisionExplanation,
  type BrainDecisionStepExplanation,
  type BrainDecisionTierName,
  type BrainExplainContext,
  type BrainExplainLedgerHost,
  explainBrainDecision,
} from './brain/brain-explain.js';
export {
  BLOCKED_RESOLVED_MARKERS,
  type BrainHeuristicsConfig,
  compileResolutionMarkers,
  DEFAULT_BRAIN_HEURISTICS,
  isBlockedResolved,
  type ResolvedBrainHeuristics,
  resolveBrainHeuristics,
} from './brain/brain-heuristics.js';
export {
  BrainDecisionLedger,
  type BrainDecisionLedgerOptions,
  type BrainLedgerEntry,
  brainDecisionKey,
  createLedgerGuardBrainArbiter,
  type LedgerGuardBrainArbiterOptions,
} from './brain/brain-ledger.js';
export {
  type BrainInterventionInput,
  BrainMonitor,
  type BrainMonitorOptions,
  type BrainMonitorPolicy,
  type BrainMonitorSignalToggles,
  DEFAULT_FILE_EDIT_TOOLS,
} from './brain/brain-monitor.js';
export {
  applyRule,
  BRAIN_RULE_PATTERN_MAX,
  BRAIN_RULE_SUBJECT_MAX,
  type BrainRule,
  type BrainRuleAction,
  type BrainRuleCompileResult,
  type BrainRuleMatch,
  type CompiledBrainRule,
  compileBrainRules,
  createRuleBrainArbiter,
  evaluateBrainRules,
  type RuleBrainArbiterOptions,
  ruleMatches,
} from './brain/brain-rules.js';
export {
  type BrainDecisionTier,
  BrainTierCounter,
  type BrainTierStats,
  DETERMINISTIC_BRAIN_TIERS,
  emitBrainTierTransition,
  isDeterministicTier,
  markDecisionTier,
  readDecisionTier,
} from './brain/brain-telemetry.js';
export {
  applyContentMode,
  BRAIN_TRACE_REDACTED_MAX,
  BRAIN_TRACE_VERSION,
  type BrainTraceContentMode,
  type BrainTraceCouncilResolution,
  type BrainTraceCouncilVote,
  type BrainTraceLlmCall,
  type BrainTraceRecord,
  BrainTraceRecorder,
  type BrainTraceRecorderOptions,
  type BrainTraceTierStep,
  readBrainTrace,
  sanitizeDecision,
  sanitizeRequest,
} from './brain/brain-trace.js';
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
export {
  type CollabBusState,
  CollaborationBus,
  type ConsumedInjectionInfo,
} from './coordination/collab-bus.js';
export {
  type CollabPauseMiddlewareOptions,
  collabInjectMiddleware,
  collabPauseMiddleware,
  type InjectedToolResult as CollabInjectedToolResult,
} from './coordination/collab-pause.js';
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
  makeMutationTestTool,
  makeQualityGateTool,
  makeRollUpTool,
  makeSpawnTool,
  makeTerminateTool,
} from './coordination/director-tools.js';
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
export { resolveProjectDir } from './coordination/global-mailbox-paths.js';
export * from './coordination/index.js';
export {
  type MailToolsOptions,
  makeMailInboxTool,
  makeMailSendTool,
} from './coordination/mail-tools.js';
// Mailbox - inter-agent messaging
export type {
  MailboxEvent,
  MailboxEventListener,
  MailboxEventType,
} from './coordination/mailbox-events.js';
export { MailboxEventEmitter } from './coordination/mailbox-events.js';
export {
  applyMailboxSendPolicy,
  type MailboxResolver,
  type MailboxToolOptions,
  mailboxSessionTag,
  makeMailboxTool,
  resolveMailboxIdentity,
} from './coordination/mailbox-tool.js';
export type {
  AgentHeartbeatInput,
  AgentRegistrationInput,
  AutoCompactOptions,
  AutoCompactResult,
  Mailbox,
  MailboxAckInput,
  MailboxAgentStatus,
  MailboxAudience,
  MailboxMessage,
  MailboxMessageType,
  MailboxQuery,
  MailboxSendInput,
  MailboxTaskContext,
  ReadReceipts,
  RegisteredAgent,
} from './coordination/mailbox-types.js';
export {
  isMailboxLeader,
  isMailboxMessageVisibleTo,
  mailboxIdentityBase,
  normalizeRecipient,
} from './coordination/mailbox-types.js';
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
// ---- Provider/Model Status Tracker ----
export {
  type ErrorHistoryEntry,
  type ProviderModelState,
  type ProviderModelStatus,
  ProviderModelStatusTracker,
  type ProviderStatusSnapshot,
  type ProviderStatusTrackerConfig,
} from './coordination/provider-status-tracker.js';
export {
  DEFAULT_MAX_FLEET_SPAWNS,
  HARD_MAX_SPAWN_DEPTH,
  resolveMaxSpawnDepth,
} from './coordination/spawn-budget.js';
export {
  assignNickname,
  type NicknameAssignment,
  nicknameKeyFromDisplay,
} from './coordination/subagent-nicknames.js';
export {
  formatSubagentStructuredReport,
  makeSubagentResultTool,
  normalizeSubagentStructuredReport,
  readSubagentStructuredReport,
  SUBAGENT_STRUCTURED_REPORT_META_KEY,
} from './coordination/subagent-result-tool.js';
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
