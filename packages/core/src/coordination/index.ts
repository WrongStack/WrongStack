// Coordination domain: multi-agent orchestration, director, fleet bus, agents

export {
  createMessage,
  InMemoryAgentBridge,
  InMemoryBridgeTransport,
} from './agent-bridge.js';
export { assignNickname } from './subagent-nicknames.js';
export {
  type AgentFactory,
  type AgentFactoryResult,
  type AgentRunnerOptions,
  makeAgentSubagentRunner,
  withDisabledToolFiltering,
} from './agent-subagent-runner.js';
export {
  AGENT_CATALOG,
  AGENTS_BY_PHASE,
  type AgentBudgetTier,
  type AgentCapability,
  type AgentDefinition,
  type AgentPhase,
  ALL_AGENT_DEFINITIONS,
  BUILD_AGENTS,
  DELIVERY_AGENTS,
  DISCOVERY_AGENTS,
  DOMAIN_AGENTS,
  getAgentDefinition,
  HEAVY_BUDGET,
  KNOWLEDGE_AGENTS,
  LIGHT_BUDGET,
  MEDIUM_BUDGET,
  META_AGENTS,
  PLANNING_AGENTS,
  REVIEW_AGENTS,
  VERIFY_AGENTS,
  applyProjectAgentConfig,
  buildProjectContextualizedPrompt,
  canCaptureNewLearned,
  CAPTURE_COOLDOWN_MS,
  CAPTURE_MAX_PER_SESSION,
  captureLearnedFromAgentOutput,
  captureLearnedFromAgentOutputDetailed,
  createProjectAgent,
  createProjectAgentRoster,
  detectLearnedConflicts,
  getProjectAgentLearnStats,
  hintLearnedNeedsSummarization,
  LEARNED_SOFT_LIMIT,
  LEARNED_HARD_LIMIT,
  loadProjectAgentConsolidated,
  loadConsolidationMetadata,
  isConsolidated,
  saveProjectAgentConsolidated,
  clearProjectAgentConsolidated,
  buildConsolidationInstruction,
  listProjectAgentRoles,
  listProjectAgentLearnedEntries,
  loadProjectAgentConfig,
  loadProjectAgentIdentity,
  loadProjectAgentLearned,
  loadProjectAgentLearningPolicy,
  loadProjectAgentProfile,
  loadRoleKnowledgeManifest,
  resetProjectAgentIdentity,
  refreshProjectAgentIdentity,
  updateProjectAgentLearned,
  updateProjectAgentIdentity,
  updateProjectAgentConfig,
  updateProjectAgentKnowledge,
  updateProjectAgentLearningPolicy,
  assertProjectAgentRole,
  slugifyProjectAgentRole,
  validateProjectAgentConfig,
  type LearnedCaptureResult,
  type ProjectAgentConfig,
  type ProjectAgentProfile,
  type CreateProjectAgentInput,
  type ProjectAgentLearningPolicy,
  type ConsolidationMetadata,
  type RoleKnowledgeManifest,
} from './agents/index.js';
export {
  type AutoExtendCeiling,
  type AutoExtendPolicy,
  attachAutoExtend,
} from './auto-extend.js';
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
} from './brain.js';
export {
  brainDecisionKey,
  BrainDecisionLedger,
  type BrainDecisionLedgerOptions,
  type BrainLedgerEntry,
  createLedgerGuardBrainArbiter,
  type LedgerGuardBrainArbiterOptions,
} from './brain-ledger.js';
export {
  type BrainInterventionInput,
  BrainMonitor,
  type BrainMonitorOptions,
} from './brain-monitor.js';
export {
  type BugFinding,
  type CollabBudgetConfig,
  type CollabBudgetOverrides,
  type CollabBudgetWarningPayload,
  type CollabDebugReport,
  CollabSession,
  type CollabSessionOptions,
  type CriticConcern,
  type CriticEvaluation,
  type DirectorAlert,
  DirectorAlertLevel,
  type DirectorCancelCollabPayload,
  type RefactorPhase,
  type RefactorPlan,
  type SharedFileEntry,
  type SharedFileSnapshot,
} from './collab-debug.js';
export {
  type CreateDelegateToolOptions,
  createDelegateTool,
  type DelegateHost,
} from './delegate-tool.js';
export {
  assessCommitSafety,
  type CommitSafetyOptions,
  type CommitSafetyReport,
} from './commit-safety.js';
// ── Dependency watcher — file-change → mailbox bridge ────────────────────
export {
  DEPENDENCY_FILE_PATTERNS,
  type DependencyWatcherConfig,
  type DepWatchEntry,
  makeDependencyWatcherConfig,
} from './dep-watcher.js';
// ── Dependency watcher bridge — file-watcher events → mailbox ────────────
export {
  attachDepWatcherBridge,
  type DepWatcherBridgeOptions,
} from './dep-watcher-bridge.js';
export {
  Director,
  FleetCostCapError,
  FleetSpawnBudgetError,
  FleetTokenCapError,
  type TaskResultNotification,
} from './director.js';
export {
  composeDirectorPrompt,
  composeSubagentPrompt,
  DEFAULT_DIRECTOR_PREAMBLE,
  DEFAULT_SUBAGENT_BASELINE,
  type DirectorPromptParts,
  rosterSummaryFromConfigs,
  type SubagentPromptParts,
} from './director-prompts.js';
export {
  type DirectorSessionFactory,
  type DirectorSessionFactoryOptions,
  makeDirectorSessionFactory,
} from './director-session.js';
// Backward-compatible re-exports: the old per-fleet-signal tools were
// consolidated into makeFleetTool. These aliases keep downstream imports
// (defaults/index.ts, src/index.ts) working until they migrate.
export {
  makeAskResultTool,
  makeAskTool,
  makeAssignTool,
  makeAwaitTasksTool,
  makeCollabDebugTool,
  makeFleetEmitTool,
  makeFleetTool,
  // NOTE: `makeFleetStatusTool` is no longer an alias of makeFleetTool — it
  // is the standalone read-only peer-snapshot tool from fleet-status-tool.ts
  // (exported below). The old leader-side fleet_status was consolidated into
  // `fleet` (action: status).
  makeKanbanQueueTool,
  makeQualityGateTool,
  makeRollUpTool,
  makeSpawnTool,
  makeTerminateAllTool,
  makeTerminateTool,
  makeWorkCompleteTool,
} from './director-tools.js';
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
} from './dispatcher.js';
export {
  ACP_AGENTS,
  ALL_FLEET_AGENTS,
  AUDIT_LOG_AGENT,
  applyRosterBudget,
  BUG_HUNTER_AGENT,
  FLEET_ROSTER,
  FLEET_ROSTER_BUDGETS,
  FLEET_ROSTER_WITHACP,
  type FleetRosterBudget,
  GENERIC_AGENT,
  REFACTOR_PLANNER_AGENT,
  SECURITY_SCANNER_AGENT,
} from './fleet.js';
export {
  FleetBus,
  type FleetEvent,
  type FleetHandler,
  type FleetUsage,
  FleetUsageAggregator,
  type SubagentUsageSnapshot,
} from './fleet-bus.js';
export {
  FleetManager,
  type FleetManagerOptions,
} from './fleet-manager.js';
export { type FleetStatusToolOptions, makeFleetStatusTool } from './fleet-status-tool.js';
export {
  FleetSupervisor,
  type FleetSupervisorActions,
  type FleetSupervisorConfig,
  type FleetSupervisorOptions,
  type FleetSupervisorSource,
  type SupervisedSubagent,
  type SupervisorLogEntry,
} from './fleet-supervisor.js';
export {
  DEFAULT_MAX_FLEET_SPAWNS,
  HARD_MAX_SPAWN_DEPTH,
  resolveMaxSpawnDepth,
} from './spawn-budget.js';
export { resolveProjectDir } from './global-mailbox-paths.js';
export type { MailboxCredentialVerifier } from './mailbox-credential-store.js';
export {
  createProjectMailbox,
  getSharedProjectMailbox,
  type ProjectMailboxOptions,
  RemoteMailbox,
} from './remote-mailbox.js';
export { RemoteMailboxCredentialStore } from './remote-mailbox-credential-store.js';
export {
  isMailboxProjectServerAvailable,
  MailboxProjectServerConnection,
  type MailboxProjectServerConnectionState,
} from './mailbox-project-server-client.js';
export type {
  MailboxProjectServerInfo,
  MailboxProjectServerStatus,
} from './mailbox-project-server-protocol.js';
export { MailboxEventEmitter } from './mailbox-events.js';
export { BrainTraceRecorder, type BrainTraceRecorderOptions } from './brain-trace.js';
export { type FileAuthorTrackerOptions, recordFileAction } from './file-author-tracker.js';
export {
  startTechStackConsumer,
  type TechStackConsumerOptions,
} from './techstack-mailbox-consumer.js';
export {
  authorizeMailboxBearerToken,
  authorizePersistedMailboxCredential,
  createMailboxHttpRouter,
  MAILBOX_HTTP_DEFAULT_MAX_AGE_MS,
  MAILBOX_HTTP_MAX_AGE_CEILING_MS,
  MAILBOX_HTTP_MAX_BODY_BYTES,
  MAILBOX_HTTP_RATE_LIMIT_PER_MINUTE,
  MAILBOX_HTTP_RATE_LIMIT_WINDOW_MS,
  MailboxHttpRateLimiter,
  type MailboxHttpAccessDecision,
  type MailboxHttpRouter,
  type MailboxHttpRouterOptions,
} from './mailbox-http-router.js';
export type { ICoordinator } from './icoordinator.js';
export type { IFleetManager } from './ifleet-manager.js';
export { LargeAnswerStore } from './large-answer-store.js';
export {
  formatSubagentStructuredReport,
  MAX_SUBAGENT_STRUCTURED_REPORT_CHARS,
  makeSubagentResultTool,
  normalizeSubagentStructuredReport,
  readSubagentStructuredReport,
  SUBAGENT_STRUCTURED_REPORT_META_KEY,
} from './subagent-result-tool.js';
export { type MailToolsOptions, makeMailInboxTool, makeMailSendTool } from './mail-tools.js';
// Mailbox - inter-agent messaging
export type {
  MailboxActionInput,
  MailboxActionResult,
  MailboxMessageAction,
} from './mailbox-actions.js';
export { actionToAckInput } from './mailbox-actions.js';
export {
  buildDownAlert,
  buildRecoveryAlert,
  type DownAlertInput,
  MAILBOX_HEALTH_DEFAULT_FAILURE_THRESHOLD,
  MAILBOX_HEALTH_DEFAULT_FROM,
  MAILBOX_HEALTH_DEFAULT_INTERVAL_MS,
  MAILBOX_HEALTH_DEFAULT_TIMEOUT_MS,
  type MailboxHealthEvent,
  MailboxHealthWatchdog,
  type MailboxHealthWatchdogOptions,
  type RecoveryAlertInput,
  validateWatchdogOptions,
  type WatchdogConfig,
} from './mailbox-health.js';
// ── Mailbox hooks — tool-execution integration ────────────────────────────
export {
  createMailboxHooks,
  type MailboxHooksOptions,
} from './mailbox-hooks.js';
export {
  applyMailboxSendPolicy,
  type MailboxResolver,
  type MailboxToolOptions,
  mailboxSessionTag,
  makeMailboxTool,
  resolveMailboxIdentity,
} from './mailbox-tool.js';
export type {
  AgentHeartbeatInput,
  AgentRegistrationInput,
  ClientHeartbeatInput,
  ClientRegistrationInput,
  ClientSource,
  ClientStatus,
  Mailbox,
  MailboxAckBatchInput,
  MailboxAckInput,
  MailboxAgentStatus,
  MailboxAudience,
  MailboxMessage,
  MailboxMessageProjection,
  MailboxMessageType,
  MailboxQuery,
  MailboxRecipientState,
  MailboxSendInput,
  MailboxTaskContext,
  PurgeOptions,
  PurgeResult,
  ReadReceipts,
  RegisteredAgent,
} from './mailbox-types.js';
export {
  isMailboxLeader,
  isMailboxMessageVisibleTo,
  MAILBOX_TYPE_PROPERTIES,
  mailboxIdentityBase,
  normalizeRecipient,
  SESSION_RECIPIENT_PREFIX,
  sessionRecipient,
} from './mailbox-types.js';
export {
  parseMailboxAckInput,
  parseMailboxQueryInput,
  parseMailboxSendInput,
} from './mailbox-codecs.js';
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
} from './model-matrix.js';
export {
  DefaultMultiAgentCoordinator,
  type MultiAgentCoordinatorOptions,
} from './multi-agent-coordinator.js';
export { NULL_FLEET_BUS } from './null-fleet-bus.js';
// ── Package author tracker — tracks which agent added which package ─────────
export {
  detectEcosystem,
  getFullPackageLog,
  getManifestPackages,
  getPackageAuthor,
  getPackagesByAgent,
  type PackageAuthorEntry,
  type PackageAuthorLog,
  type PackageAuthorTrackerOptions,
  recordPackageAction,
  updatePackageOutdatedStatus,
} from './package-author-tracker.js';
// ── Package outdated watcher — notifies original authors of outdated pkgs ──
export {
  type OutdatedNotifyMessage,
  type PackageOutdatedEntry,
  type PackageOutdatedResult,
  type PackageOutdatedWatcherOptions,
  startPackageOutdatedWatcher,
} from './package-outdated-watcher.js';
// ── Mailbox bridge lock — per-project single-instance contract ─────────
// The HTTP bridge (`wstack mailbox serve`) writes a per-project lock +
// token file at `<projectDir>/.mailbox-bridge.{lock,token}`. Core owns
// the on-disk contract (read, classify, atomic write, release); the
// cli's `mailbox serve` subcommand owns the spawn/listen side and
// produces the finalized lock via `acquireOrJoin` + `finalize`.
// Consumers that only need to discover or clean up a bridge
// (webui, eternal-autonomy, external agents reading the file)
// import from here.
export {
  type AcquireOptions,
  type AcquireResult,
  acquireOrJoin,
  finalize,
  type LiveLockResult,
  MAILBOX_BRIDGE_LOCK_FILENAME,
  MAILBOX_BRIDGE_TOKEN_FILENAME,
  type MailboxBridgeLock,
  readLiveLock,
  release,
} from './single-instance-mailbox.js';
export type {
  BudgetKind,
  BudgetLimits,
  BudgetNegotiationMode,
  BudgetThresholdDecision,
  BudgetThresholdHandler,
  BudgetUsage,
} from './subagent-budget.js';
export {
  BudgetExceededError,
  BudgetThresholdSignal,
  /** 60 000 ms — hard safety net for budget negotiation decisions. Both the
   * coordinator watchdog and SubagentBudget._negotiateExtension use this value
   * so they agree on the decision window. Re-exported here so consumers of
   * the coordination module can reference it without a sub-module import. */
  DECISION_TIMEOUT_MS,
  SubagentBudget,
  /** 0.85 — fraction of wall-clock `timeoutMs` at which the coordinator watchdog
   * fires a PROACTIVE pre-empt (before deadline). Canonical source:
   * `coordination/subagent-budget.ts`. Re-exported here so all budget symbols
   * are accessible from one import path. */
  TIMEOUT_PREEMPT_FRACTION,
} from './subagent-budget.js';
export {
  type FleetWorktreePolicy,
  resolveSubagentWorktreeDecision,
  subagentNeedsWorktree,
  WorktreeIntegrationError,
  type WorktreeIsolationDecision,
  type WorktreeTaskRunnerOptions,
  type WorktreeTaskStateUpdate,
  wrapSubagentRunnerWithWorktrees,
} from './worktree-task-runner.js';

// ── Provider/Model Status Tracker ───────────────────────────────────────────
export {
  ProviderModelStatusTracker,
  type ErrorHistoryEntry,
  type ProviderModelState,
  type ProviderModelStatus,
  type ProviderStatusSnapshot,
  type ProviderStatusTrackerConfig,
} from './provider-status-tracker.js';

// ── Autonomous coordination layer ──────────────────────────────────────────

// ── Adaptive Concurrency Controller ──────────────────────────────────────────
export {
  AdaptiveConcurrencyController,
  type AdaptiveConcurrencyState,
} from './adaptive-concurrency.js';
/** Agent Monitor — virtual chat history, timeline streaming, HQ bridge */
export {
  type AgentMonitorOptions,
  AgentMonitorService,
  type AgentTimelineEntry,
  type AgentVirtualSession,
  createAgentMonitorService,
} from './agent-monitor.js';
export type {
  ApprovalDecision,
  AutonomousBrainOptions,
  AutonomousDecisionRequest,
  AutonomousDecisionType,
  DecisionPrompt,
  EscalationDecision,
  LLMProvider,
  PrioritizationDecision,
  SpawnDecision,
} from './autonomous-brain.js';
/** Autonomous brain — LLM-backed decision-making engine */
export { AutonomousBrain } from './autonomous-brain.js';
export type {
  AutonomousCoordinatorOptions,
  CoordinatorEvent,
  CoordinatorStats,
  RunOptions,
} from './autonomous-coordinator.js';
/** Autonomous coordinator — wires all coordination components */
export { AutonomousCoordinator } from './autonomous-coordinator.js';

/** Change manager — autonomous code change lifecycle */
export {
  type ApplyResult,
  type ChangeFile,
  ChangeManager,
  type ChangeManagerOptions,
  type ChangeProposal,
  DEFAULT_QUALITY_CHECKS,
  type QualityGateChecks,
  type RollbackResult,
} from './change-manager.js';
export type {
  ConsensusOptions,
  ConsensusResult,
  QuorumRule,
  VoterConfig,
} from './consensus-protocol.js';
/** Consensus protocol — agent voting on proposed changes */
export { ConsensusProtocol } from './consensus-protocol.js';
export type {
  ChangeNode,
  ChangeStatus,
  DecisionNode,
  FactCategory,
  FactNode,
  GoalNode,
  GoalPriority,
  GoalStatus,
  GraphSubscription,
  NodeFilter,
  NodeType,
  QualityCheck,
  QualityGateResult,
  VoteNode,
  VoteRecord,
  VoteValue,
} from './knowledge-graph.js';
/** Shared knowledge graph — facts, goals, decisions, changes */
export { KnowledgeGraph } from './knowledge-graph.js';
export type {
  TaskAuctionOptions,
  TaskBid,
} from './task-auctioneer.js';
/** Task auctioneer — project-wide task marketplace */
export { TaskAuctioneer } from './task-auctioneer.js';
export type {
  DAGEdgeEvent,
  DAGEdgeHandler,
  DAGNode,
  DAGNodeStatus,
  RunnablesHandler,
} from './task-dag.js';
/** Task DAG — dependency graph with fork/join semantics */
export { TaskDAG } from './task-dag.js';
export {
  CollaborationBus,
  type CollabBusState,
  type ConsumedInjectionInfo,
} from './collab-bus.js';
export {
  collabInjectMiddleware,
  collabPauseMiddleware,
} from '../middleware/collab-pause.js';
