// Coordination domain: multi-agent orchestration, director, fleet bus, agents
export {
  BrainDecisionQueue,
  DefaultBrainArbiter,
  HumanEscalatingBrainArbiter,
  ObservableBrainArbiter,
  formatHumanPrompt,
  type BrainArbiter,
  type BrainDecision,
  type BrainDecisionOption,
  type BrainDecisionRequest,
  type BrainDecisionSource,
  type BrainFallback,
  type BrainRisk,
  type DefaultBrainArbiterOptions,
} from './brain.js';
export {
  Director,
  FleetSpawnBudgetError,
  FleetCostCapError,
} from './director.js';
export {
  makeSpawnTool,
  makeAssignTool,
  makeAwaitTasksTool,
  makeAskTool,
  makeAskResultTool,
  makeRollUpTool,
  makeTerminateTool,
  makeFleetStatusTool,
  makeFleetUsageTool,
  makeFleetSessionTool,
  makeFleetHealthTool,
  makeCollabDebugTool,
  makeFleetEmitTool,
  makeWorkCompleteTool,
} from './director-tools.js';
export { LargeAnswerStore } from './large-answer-store.js';
export {
  createDelegateTool,
  type DelegateHost,
  type CreateDelegateToolOptions,
} from './delegate-tool.js';
export {
  DefaultMultiAgentCoordinator,
  type MultiAgentCoordinatorOptions,
} from './multi-agent-coordinator.js';
export {
  SubagentBudget,
  BudgetExceededError,
  BudgetThresholdSignal,
  /** 0.85 — fraction of wall-clock `timeoutMs` at which the coordinator watchdog
   * fires a PROACTIVE pre-empt (before deadline). Canonical source:
   * `coordination/subagent-budget.ts`. Re-exported here so all budget symbols
   * are accessible from one import path. */
  TIMEOUT_PREEMPT_FRACTION,
  /** 60 000 ms — hard safety net for budget negotiation decisions. Both the
   * coordinator watchdog and SubagentBudget._negotiateExtension use this value
   * so they agree on the decision window. Re-exported here so consumers of
   * the coordination module can reference it without a sub-module import. */
  DECISION_TIMEOUT_MS,
} from './subagent-budget.js';
export type {
  BudgetNegotiationMode,
  BudgetThresholdDecision,
  BudgetThresholdHandler,
  BudgetKind,
  BudgetLimits,
  BudgetUsage,
} from './subagent-budget.js';
export {
  makeAgentSubagentRunner,
  withDisabledToolFiltering,
  type AgentFactory,
  type AgentFactoryResult,
  type AgentRunnerOptions,
} from './agent-subagent-runner.js';
export {
  FleetBus,
  FleetUsageAggregator,
  type FleetEvent,
  type FleetHandler,
  type FleetUsage,
  type SubagentUsageSnapshot,
} from './fleet-bus.js';
export {
  makeDirectorSessionFactory,
  type DirectorSessionFactory,
  type DirectorSessionFactoryOptions,
} from './director-session.js';
export {
  composeDirectorPrompt,
  composeSubagentPrompt,
  rosterSummaryFromConfigs,
  DEFAULT_DIRECTOR_PREAMBLE,
  DEFAULT_SUBAGENT_BASELINE,
  type DirectorPromptParts,
  type SubagentPromptParts,
} from './director-prompts.js';
export {
  InMemoryAgentBridge,
  InMemoryBridgeTransport,
  createMessage,
} from './agent-bridge.js';
export {
  AUDIT_LOG_AGENT,
  BUG_HUNTER_AGENT,
  REFACTOR_PLANNER_AGENT,
  SECURITY_SCANNER_AGENT,
  FLEET_ROSTER,
  ALL_FLEET_AGENTS,
  FLEET_ROSTER_BUDGETS,
  ACP_AGENTS,
  FLEET_ROSTER_WITHACP,
  applyRosterBudget,
  type FleetRosterBudget,
} from './fleet.js';
export {
  ALL_AGENT_DEFINITIONS,
  AGENT_CATALOG,
  AGENTS_BY_PHASE,
  getAgentDefinition,
  DISCOVERY_AGENTS,
  PLANNING_AGENTS,
  BUILD_AGENTS,
  VERIFY_AGENTS,
  REVIEW_AGENTS,
  DOMAIN_AGENTS,
  KNOWLEDGE_AGENTS,
  DELIVERY_AGENTS,
  META_AGENTS,
  TOOLS as AGENT_TOOL_PRESETS,
  LIGHT_BUDGET,
  MEDIUM_BUDGET,
  HEAVY_BUDGET,
  type AgentDefinition,
  type AgentCapability,
  type AgentBudgetTier,
  type AgentPhase,
} from './agents/index.js';
export {
  dispatchAgent,
  scoreAgents,
  makeLLMClassifier,
  DEFAULT_DISPATCH_ROLE,
  type DispatchResult,
  type DispatchCandidate,
  type DispatchClassifier,
  type DispatchOptions,
  type DispatchMethod,
} from './dispatcher.js';
export {
  attachAutoExtend,
  type AutoExtendPolicy,
  type AutoExtendCeiling,
} from './auto-extend.js';
export type { ICoordinator } from './icoordinator.js';
export type { IFleetManager } from './ifleet-manager.js';
export { NULL_FLEET_BUS } from './null-fleet-bus.js';
export {
  FleetManager,
  type FleetManagerOptions,
} from './fleet-manager.js';
export {
  CollabSession,
  DirectorAlertLevel,
  type CollabDebugReport,
  type CollabSessionOptions,
  type CollabBudgetConfig,
  type CollabBudgetOverrides,
  type DirectorAlert,
  type DirectorCancelCollabPayload,
  type CollabBudgetWarningPayload,
  type SharedFileSnapshot,
  type SharedFileEntry,
  type BugFinding,
  type RefactorPlan,
  type RefactorPhase,
  type CriticEvaluation,
  type CriticConcern,
} from './collab-debug.js';
// ── Mailbox — inter-agent messaging ──────────────────────────────────────
export { DefaultMailbox } from './mailbox.js';
export { normalizeRecipient } from './mailbox-types.js';
export { BrainMonitor, type BrainMonitorOptions, type BrainInterventionInput } from './brain-monitor.js';
export { GlobalMailbox, resolveProjectDir } from './global-mailbox.js';
export {
  MailboxHealthWatchdog,
  MAILBOX_HEALTH_DEFAULT_INTERVAL_MS,
  MAILBOX_HEALTH_DEFAULT_TIMEOUT_MS,
  MAILBOX_HEALTH_DEFAULT_FAILURE_THRESHOLD,
  MAILBOX_HEALTH_DEFAULT_FROM,
  type MailboxHealthWatchdogOptions,
  type MailboxHealthEvent,
} from './mailbox-health.js';
export { makeMailboxTool, resolveMailboxIdentity, mailboxSessionTag, type MailboxToolOptions, type MailboxResolver } from './mailbox-tool.js';
export { makeMailSendTool, makeMailInboxTool, type MailToolsOptions } from './mail-tools.js';
export type {
  Mailbox,
  MailboxMessage,
  MailboxMessageType,
  MailboxQuery,
  MailboxSendInput,
  MailboxAckInput,
  MailboxAckBatchInput,
  MailboxAgentStatus,
  MailboxTaskContext,
  ReadReceipts,
  RegisteredAgent,
  AgentRegistrationInput,
  AgentHeartbeatInput,
  ClientSource,
  ClientStatus,
  ClientRegistrationInput,
  ClientHeartbeatInput,
  PurgeOptions,
  PurgeResult,
} from './mailbox-types.js';
// ── Dependency watcher — file-change → mailbox bridge ────────────────────
export {
  DEPENDENCY_FILE_PATTERNS,
  makeDependencyWatcherConfig,
  type DependencyWatcherConfig,
  type DepWatchEntry,
} from './dep-watcher.js';
// ── Dependency watcher bridge — file-watcher events → mailbox ────────────
export {
  attachDepWatcherBridge,
  type DepWatcherBridgeOptions,
} from './dep-watcher-bridge.js';
// ── Mailbox hooks — tool-execution integration ────────────────────────────
export {
  createMailboxHooks,
  type MailboxHooksOptions,
} from './mailbox-hooks.js';
// ── Package author tracker — tracks which agent added which package ─────────
export {
  recordPackageAction,
  getPackageAuthor,
  getManifestPackages,
  getPackagesByAgent,
  updatePackageOutdatedStatus,
  getFullPackageLog,
  detectEcosystem,
  type PackageAuthorEntry,
  type PackageAuthorLog,
  type PackageAuthorTrackerOptions,
} from './package-author-tracker.js';
// ── Package outdated watcher — notifies original authors of outdated pkgs ──
export {
  startPackageOutdatedWatcher,
  type PackageOutdatedEntry,
  type PackageOutdatedResult,
  type PackageOutdatedWatcherOptions,
  type OutdatedNotifyMessage,
} from './package-outdated-watcher.js';

// ── Autonomous coordination layer ──────────────────────────────────────────

/** Shared knowledge graph — facts, goals, decisions, changes */
export { KnowledgeGraph } from './knowledge-graph.js';
export type {
  NodeType,
  FactCategory,
  FactNode,
  GoalNode,
  DecisionNode,
  ChangeNode,
  VoteNode,
  VoteRecord,
  QualityGateResult,
  QualityCheck,
  GraphSubscription,
  NodeFilter,
  GoalStatus,
  GoalPriority,
  ChangeStatus,
  VoteValue,
} from './knowledge-graph.js';

/** Task DAG — dependency graph with fork/join semantics */
export { TaskDAG } from './task-dag.js';
export type {
  DAGNode,
  DAGNodeStatus,
  DAGEdgeEvent,
  DAGEdgeHandler,
  RunnablesHandler,
} from './task-dag.js';

/** Consensus protocol — agent voting on proposed changes */
export { ConsensusProtocol } from './consensus-protocol.js';
export type {
  VoterConfig,
  QuorumRule,
  ConsensusResult,
  ConsensusOptions,
} from './consensus-protocol.js';

/** Change manager — autonomous code change lifecycle */
export {
  ChangeManager,
  DEFAULT_QUALITY_CHECKS,
  type ChangeManagerOptions,
  type ChangeFile,
  type ChangeProposal,
  type ApplyResult,
  type RollbackResult,
  type QualityGateChecks,
} from './change-manager.js';

/** Autonomous brain — LLM-backed decision-making engine */
export { AutonomousBrain } from './autonomous-brain.js';
export type {
  AutonomousBrainOptions,
  LLMProvider,
  DecisionPrompt,
  AutonomousDecisionType,
  AutonomousDecisionRequest,
  SpawnDecision,
  ApprovalDecision,
  PrioritizationDecision,
  EscalationDecision,
} from './autonomous-brain.js';

/** Task auctioneer — project-wide task marketplace */
export { TaskAuctioneer } from './task-auctioneer.js';
export type {
  TaskBid,
  TaskAuctionOptions,
} from './task-auctioneer.js';

/** Autonomous coordinator — wires all coordination components */
export { AutonomousCoordinator } from './autonomous-coordinator.js';
export type {
  AutonomousCoordinatorOptions,
  CoordinatorEvent,
  RunOptions,
  CoordinatorStats,
} from './autonomous-coordinator.js';

/** Agent Monitor — virtual chat history, timeline streaming, HQ bridge */
export {
  AgentMonitorService,
  createAgentMonitorService,
  type AgentTimelineEntry,
  type AgentVirtualSession,
  type AgentMonitorOptions,
} from './agent-monitor.js';

// ── Adaptive Concurrency Controller ──────────────────────────────────────────
export {
  AdaptiveConcurrencyController,
  type AdaptiveConcurrencyState,
} from './adaptive-concurrency.js';
