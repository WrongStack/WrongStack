// Coordination domain: multi-agent orchestration, director, fleet bus, agents

export {
  createMessage,
  InMemoryAgentBridge,
  InMemoryBridgeTransport,
} from './agent-bridge.js';
export * from './agent-catalog-exports.js';
export {
  type AgentFactory,
  type AgentFactoryResult,
  type AgentRunnerOptions,
  makeAgentSubagentRunner,
  withDisabledToolFiltering,
} from './agent-subagent-runner.js';

export {
  type AutoExtendCeiling,
  type AutoExtendPolicy,
  attachAutoExtend,
} from './auto-extend.js';
export * from './autonomy-exports.js';
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
  DefaultBrainArbiter,
  type DefaultBrainArbiterOptions,
  EscalationRoutingBrainArbiter,
  formatHumanPrompt,
  HumanEscalatingBrainArbiter,
  ObservableBrainArbiter,
  terminalPolicyDecision,
} from './brain.js';
export {
  BrainDecisionLedger,
  type BrainDecisionLedgerOptions,
  type BrainLedgerEntry,
  brainDecisionKey,
  createLedgerGuardBrainArbiter,
  type LedgerGuardBrainArbiterOptions,
} from './brain-ledger.js';
export {
  type BrainInterventionInput,
  BrainMonitor,
  type BrainMonitorOptions,
} from './brain-monitor.js';
export {
  type BrainDecisionTier,
  BrainTierCounter,
  type BrainTierStats,
  DETERMINISTIC_BRAIN_TIERS,
  emitBrainTierTransition,
  isDeterministicTier,
  markDecisionTier,
  readDecisionTier,
} from './brain-telemetry.js';
export { BrainTraceRecorder, type BrainTraceRecorderOptions } from './brain-trace.js';
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
  assessCommitSafety,
  type CommitSafetyOptions,
  type CommitSafetyReport,
} from './commit-safety.js';
export {
  type CreateDefineSubagentToolOptions,
  createDefineSubagentTool,
  type DefineSubagentInput,
  type DefineSubagentOutput,
} from './define-subagent-tool.js';
export {
  type CreateDelegateToolOptions,
  createDelegateTool,
  type DelegateHost,
} from './delegate-tool.js';
export {
  findDelegationForTask,
  markDelegationDelivered,
  noteLeaderConsumedTask,
  type TrackedDelegationInfo,
} from './delegation/delegation-lookup.js';
export {
  type DelegationCancelCause,
  type DelegationEntry,
  type DelegationState,
  DelegationTracker,
  type DelegationTrackerOptions,
} from './delegation/delegation-tracker.js';
export {
  AUTO_WAKE_MARKER,
  buildAutoWakePrompt,
  DEFAULT_AUTO_WAKE_DEBOUNCE_MS,
  DEFAULT_MAX_CHAINED_WAKES,
  DEFAULT_MIN_WAKE_INTERVAL_MS,
  type LeaderAutoWakeConfig,
  LeaderAutoWakeController,
  type LeaderAutoWakeControllerOptions,
  type LeaderAutoWakeStartedEvent,
  type LeaderAutoWakeSuppressedEvent,
  type LeaderAutoWakeSuppressedReason,
  type LeaderWakeDecision,
  type LeaderWakePort,
} from './delegation/leader-auto-wake.js';
export {
  DELEGATION_RESULT_MARKER,
  type DelegationDeliveryPayload,
  delegationDeliveryId,
  type LeaderDelivery,
  LeaderDeliveryHub,
  type LeaderDeliveryPendingEvent,
  leaderDeliveryHub,
  renderLeaderDeliveryBlock,
} from './delegation/leader-delivery-hub.js';
export {
  buildDelegationResultExcerpt,
  type DelegateInput,
  type DelegateMode,
  type DelegateResult,
  makeDelegateCompletedEmitter,
} from './delegation/run-delegation.js';
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
// The canonical orchestration toolset. `Director.tools()` returns exactly this;
// exporting the builder lets a host assert the surface it is about to register
// without standing up a live Director.
export { buildDirectorToolset } from './director/director-toolset.js';
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
// from the top-level barrel working until they migrate.
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
  makeMutationTestTool,
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
// ── Explore Companion — state-triggered background codebase explorer ──────
export {
  buildProbeTaskText,
  DEFAULT_EXPLORE_COMPANION_AGENT_ID,
  DEFAULT_EXPLORE_EDIT_TOOLS,
  DEFAULT_EXPLORE_SEARCH_TOOLS,
  DEFAULT_MAILBOX_POLL_INTERVAL_MS,
  DEFAULT_MAX_PENDING_PROBES,
  DEFAULT_PROBE_COOLDOWN_MS,
  ExploreCompanion,
  type ExploreCompanionOptions,
  type ExploreCompanionSignalToggles,
  type ExploreCompanionTunables,
  type ExploreProbe,
  type ExploreProbeSource,
} from './explore-companion.js';
export { type FileAuthorTrackerOptions, recordFileAction } from './file-author-tracker.js';
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

export type { ICoordinator } from './icoordinator.js';
export type { IFleetManager } from './ifleet-manager.js';
export { LargeAnswerStore } from './large-answer-store.js';
export * from './mailbox-exports.js';
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
  activeTierConfig,
  applyTierToSubagentConfig,
  classifyTier,
  DEFAULT_TIER_ID,
  isConfiguredTier,
  listTierIds,
  type ModelTierBudget,
  type ModelTierDecision,
  type ModelTierSource,
  type ResolvedTierTarget,
  resolveTier,
  tierBudget,
  tierLevel,
  tierModelTarget,
} from './model-tier.js';
export {
  evaluateLeaderTierSwitch,
  evaluateSwitchEconomics,
  type LeaderTierRefusalCode,
  type LeaderTierSwitchRequest,
  type LeaderTierVerdict,
  leaderTierPolicy,
  type ResolvedLeaderTierPolicy,
  type TierModelEconomics,
  tierRank,
} from './model-tier-leader.js';
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
// ── Provider/Model Status Tracker ───────────────────────────────────────────
export {
  type ErrorHistoryEntry,
  type ProviderModelState,
  type ProviderModelStatus,
  ProviderModelStatusTracker,
  type ProviderStatusSnapshot,
  type ProviderStatusTrackerConfig,
} from './provider-status-tracker.js';
export {
  createProjectMailbox,
  getSharedProjectMailbox,
  type ProjectMailboxOptions,
  RemoteMailbox,
} from './remote-mailbox.js';
export {
  postSessionNote,
  SessionNoteHub,
  type SessionNoteInbox,
  type SessionNotePost,
  type SessionNotePostResult,
  sessionNoteHub,
} from './session-note-hub.js';
export { makeSessionNoteTool } from './session-note-tool.js';
export {
  claimSubagentSlot,
  DEFAULT_SUBAGENT_SLOT_COUNT,
  emptySubagentModelPlan,
  formatSubagentSlot,
  getSessionSubagentModelPlan,
  isSlotConfigured,
  MAX_SUBAGENT_SLOTS,
  normalizeSubagentModelPlan,
  planHasAssignments,
  releaseSubagentSlot,
  resetSessionSubagentModelPlan,
  restoreSessionSubagentModelPlan,
  type SessionSubagentModelPlan,
  SUBAGENT_MODEL_PLAN_META_KEY,
  type SubagentSlot,
  type SubagentSlotClaim,
  setSessionSubagentModelPlan,
  setSessionSubagentModelPlanForSession,
  subagentSlotOccupancy,
} from './session-subagent-models.js';
export {
  areSubagentCompanionsAllowed,
  areSubagentCompanionsAllowedForSession,
  areSubagentsAllowed,
  areSubagentsAllowedForSession,
  isSubagentPolicyLocked,
  lockSessionSubagentPolicy,
  lockSessionSubagentPolicyForSession,
  resetSessionSubagentPolicy,
  restoreSessionSubagentPolicy,
  unlockSessionSubagentPolicyForSession,
  SUBAGENT_COMPANIONS_ALLOWED_META_KEY,
  SUBAGENTS_ALLOWED_META_KEY,
  SUBAGENTS_POLICY_LOCKED_META_KEY,
  type SubagentPolicyMode,
  seedSessionSubagentPolicy,
  setSessionSubagentPolicy,
  setSessionSubagentsAllowed,
  subagentPolicyMode,
  subagentPolicyModeFrom,
} from './session-subagent-policy.js';
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
export {
  DEFAULT_MAX_FLEET_SPAWNS,
  HARD_MAX_SPAWN_DEPTH,
  resolveMaxSpawnDepth,
} from './spawn-budget.js';
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
export { assignNickname } from './subagent-nicknames.js';
export {
  formatSubagentStructuredReport,
  makeSubagentResultTool,
  normalizeSubagentStructuredReport,
  readSubagentStructuredReport,
  SUBAGENT_STRUCTURED_REPORT_META_KEY,
} from './subagent-result-tool.js';
export {
  createSystemOneTierSuggester,
  type SystemOneTierSuggester,
  type SystemOneTierSuggesterOptions,
} from './system-one-tier.js';
// Hard boundary contract enforced by `delegate` and `assign_task`: every
// assignment must carry an explicit scope plus concrete out-of-scope
// non-goals, composed into the canonical task brief.
export {
  composeBoundedTaskDescription,
  parseTaskBoundary,
  renderTaskBoundaryBlock,
  type TaskBoundary,
  taskBoundarySchemaProperties,
} from './task-boundary.js';
export {
  makeTypeSafeDispatchClassifier,
  type TypeSafeDispatchClassifierOptions,
} from './typesafe-dispatch-classifier.js';
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
