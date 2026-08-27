/**
 * @wrongstack/webui/server — public API barrel.
 *
 * Phase 1d of the god-module split: `startWebUI` and all server-internal
 * logic moved to `./start-webui.ts`. This file is now a pure re-export
 * surface so the CLI's embedded `--webui` mode and external consumers
 * import shared handlers, types, and utilities from one place.
 *
 * The package's `exports["./server"]` field points here.
 */

export {
  type AutonomyRouteHandlers,
  createAutonomyRouteHandlers,
  handleAutonomyRoute,
} from './autonomy-routes.js';
export { bootConfig, patchConfig } from './boot.js';
export {
  type BrainHandlerContext,
  type BrainLogEntry,
  type BrainTransportContext,
  handleBrainAsk,
  handleBrainConfigGet,
  handleBrainConfigSet,
  handleBrainRisk,
  handleBrainStatus,
} from './brain-handlers.js';
export type { BrainRouteHandlers } from './brain-routes.js';
export { handleBrainRoute } from './brain-routes.js';
export {
  type ChronicleRouteContext,
  handleChronicleRoute,
} from './chronicle-routes.js';
export {
  createWebuiClientPresence,
  type WebuiClientPresence,
  type WebuiClientPresenceDeps,
  type WebuiHqConnection,
  type WebuiHqConnectionOptions,
} from './client-presence.js';
export {
  type ClientTransportRouteHandlers,
  handleClientTransportRoute,
} from './client-transport-routes.js';
export { setupWebUICodebaseIndexing } from './codebase-indexing.js';
export {
  type CodeMapFileTarget,
  type CodeMapOperation,
  extractCodeMapFileTargets,
  normalizeCodeMapFileTarget,
} from './codemap-telemetry.js';
export {
  type CollaborationHandlerOptions,
  CollaborationWebSocketHandler,
} from './collaboration-ws-handler.js';
export {
  type CompletionHandlerOptions,
  type CompletionItemKind,
  type CompletionSuggestion,
  createToolLspCompletionSource,
  handleCompletionRequest,
  type LspCompletionSource,
  type LspCompletionSourceRequest,
} from './completion-handlers.js';
export { type CompletionRouteHandlers, handleCompletionRoute } from './completion-routes.js';
export {
  type ConfigDoctorDeps,
  handleConfigDoctor,
} from './config-doctor.js';
export {
  type ConnectionLifecycleOptions,
  createConnectionLifecycle,
} from './connection-lifecycle.js';
export {
  type ConnectionHealthService,
  type ConnectionsHealthContext,
  type ConnectionsHealthReport,
  collectConnectionsHealth,
  handleConnectionsHealthRoute,
} from './connections-health-route.js';
export { type ContentRouteContext, handleContentRoute } from './content-routes.js';
export {
  applyContextEditorProposal,
  buildContextEditorSnapshot,
  type ContextEditorAppliedResult,
  type ContextEditorBlock,
  type ContextEditorConflict,
  type ContextEditorDiagnostics,
  type ContextEditorMessage,
  type ContextEditorMetrics,
  type ContextEditorRepairPreview,
  type ContextEditorSnapshot,
  type ContextEditorValidationError,
  type ContextEditorValidationResult,
  type ContextEditorWarning,
  contextEditorRevision,
  validateContextEditorMessages,
  validateContextEditorProposal,
} from './context-editor.js';
export { seedContextMeta } from './context-meta.js';
export {
  type ConversationOperationsContext,
  type ConversationRunControl,
  createConversationOperations,
} from './conversation-operations.js';
export {
  type ConversationRouteHandlers,
  handleConversationRoute,
} from './conversation-routes.js';
export {
  type CustomContextMode,
  type CustomModeStore,
  createCustomModeStore,
} from './custom-context-modes.js';
export {
  type DesignContext,
  handleDesignList,
  handleDesignMaterialize,
  handleDesignSet,
  handleDesignState,
  handleDesignSwap,
  handleDesignTune,
  handleDesignUse,
  handleDesignVerify,
} from './design-handlers.js';
export {
  applyEmbeddedModelSwitch,
  broadcastEmbeddedGoalSnapshot,
  createEmbeddedConversationRoutes,
  createEmbeddedProjectRoutes,
  createEmbeddedProviderOperations,
  createEmbeddedSessionRoutes,
  type EmbeddedAgentConfigContext,
  type EmbeddedConversationContext,
  type EmbeddedHostTransport,
  type EmbeddedProjectContext,
  type EmbeddedProviderContext,
  type EmbeddedProviderStore,
  type EmbeddedSessionContext,
  type EmbeddedSessionOptions,
} from './embedded-host-adapters.js';
export {
  type AnnounceWebuiReadyParams,
  announceWebuiReady,
  createWebuiShutdown,
  type RegisterWebuiInstanceDeps,
  type RegisterWebuiInstanceParams,
  registerWebuiInstance,
  registerWebuiSignalHandlers,
  type WebuiShutdownResources,
} from './embedded-lifecycle.js';
export {
  createEmbeddedMessageRouter,
  type EmbeddedMessageRouter,
  type EmbeddedMessageRouterDeps,
  type EmbeddedMessageRouterOptions,
} from './embedded-message-router.js';
export {
  createEternalSubscription,
  type EternalBroadcast,
  type EternalSubscribe,
  type EternalSubscription,
} from './eternal-iteration-broadcast.js';
export {
  handleFilesCreate,
  handleFilesDelete,
  handleFilesList,
  handleFilesMove,
  handleFilesRead,
  handleFilesRename,
  handleFilesSkeleton,
  handleFilesTree,
  handleFilesWrite,
} from './file-handlers.js';
export { isHiddenEntry, rankFiles, SKIP_DIRS } from './file-picker.js';
export {
  type EnsureDistDeps,
  ensureDistDir,
  findInstalledPackageJson,
  type ResolveDistOptions,
  resolveDistDir,
  type StaticServeDeps,
  type StaticServeHandle,
  type StaticServeOptions,
  startStaticServe,
} from './frontend-static-serve.js';
export {
  handleGitChanges,
  handleGitCommit,
  handleGitDiff,
  handleGitDiscard,
  handleGitInfo,
  handleGitStage,
  handleGitUnstage,
  repoRelativePrefix,
} from './git-handlers.js';
export { handleGoalGet } from './goal-handlers.js';
export type { GoalRouteHandlers } from './goal-routes.js';
// ── Additional re-exports for consumers/tests ──────────────────────────────
// Extracted server modules whose route handlers, validators, stores, and
// helpers are consumed directly (WebUI test suites migrated from the old
// packages/webui/src/server/* paths). Grouped by source module.
export { handleGoalRoute } from './goal-routes.js';
export {
  type GoalSnapshotRouteHandlers,
  handleGoalSnapshotRoute,
} from './goal-snapshot-routes.js';
export { GoalWebSocketHandler } from './goal-ws-handler.js';
export type { WorklistContext } from './handlers/worklist-handlers.js';
export { handleWorklistMessage } from './handlers/worklist-handlers.js';
export { type HostRouteHandlers, handleHostRoute } from './host-routes.js';
export {
  clearAnalyticsBuffer,
  getAnalyticsBuffer,
  handleApiAnalyticsGet,
  handleApiAnalyticsPost,
  handleApiAnalyticsSummary,
} from './http-server/analytics-handler.js';
export type { CreateHttpServerOptions } from './http-server.js';
export {
  buildCspHeader,
  createHttpServer,
  decodeSessionId,
  injectWsConfig,
  isInsideDist,
} from './http-server.js';
export {
  defaultBaseDir,
  formatInstances,
  isPidAlive,
  joinSessionRegistryWithWebUIInstances,
  listInstances,
  registerInstance,
  registryPath,
  unregisterInstance,
  type WebUIInstanceAuthInfo,
  type WebUIInstanceRecord,
  type WebUIInstanceRole,
  type WebUISessionAttachCandidate,
  type WebUISessionAttachDegradedReason,
  type WebUISessionAttachEndpoint,
} from './instance-registry.js';
export {
  handleIntrospectionRoute,
  type IntrospectionRouteContext,
} from './introspection-routes.js';
export { watchKanbanBoards } from './kanban-board-watcher.js';
export {
  handleKanbanTaskDispatch,
  type KanbanDispatchContext,
  type KanbanDispatchResult,
  type KanbanTaskDispatcher,
  parseResolvedDispatchRoute,
  type ResolvedDispatchRoute,
} from './kanban-dispatch.js';
export { handleKanbanHostRoute, type KanbanHostRouteHandlers } from './kanban-host-routes.js';
export type { KanbanBoardPage, KanbanRouteContext } from './kanban-routes.js';
export {
  handleKanbanRoute,
  KANBAN_CLIENT_MESSAGE_TYPES,
  paginateKanbanBoards,
} from './kanban-routes.js';
export {
  buildTaskGraphFromGoalPhase,
  buildTaskGraphFromSddSnapshot,
  createKanbanRunMirror,
  type KanbanRunMirror,
  type KanbanRunMirrorDeps,
} from './kanban-run-mirror.js';
export {
  createKanbanSupervisor,
  type KanbanSupervisor,
  type KanbanSupervisorDeps,
  type KanbanSupervisorDispatchOptions,
} from './kanban-supervisor.js';
export { createShutdown, registerShutdownHandlers } from './lifecycle.js';
export {
  getMailboxForDeps,
  handleMailboxAgents,
  handleMailboxClear,
  handleMailboxCompact,
  handleMailboxMessages,
  handleMailboxPurge,
  type MailboxHandlerDeps,
} from './mailbox-handlers.js';
export {
  createMailboxRouteHandlers,
  handleMailboxRoute,
  type MailboxRouteContext,
  type MailboxRouteHandlers,
} from './mailbox-routes.js';
export {
  handleMcpAdd,
  handleMcpDisable,
  handleMcpDiscover,
  handleMcpEnable,
  handleMcpList,
  handleMcpPromptGet,
  handleMcpPrompts,
  handleMcpRemove,
  handleMcpResourceRead,
  handleMcpResources,
  handleMcpRestart,
  handleMcpSleep,
  handleMcpUpdate,
  handleMcpWake,
} from './mcp-handlers.js';
export type { McpRouteHandlers } from './mcp-routes.js';
export { handleMcpRoute } from './mcp-routes.js';
export {
  handleMemoryList,
  handleSageBackfillRecoverable,
  handleSageCandidateResolve,
  handleSageDelete,
  handleSageForFile,
  handleSageGet,
  handleSageGraph,
  handleSageList,
  handleSageListPage,
  handleSageRecover,
  handleSageRemember,
  handleSageUpdate,
} from './memory-handlers.js';
export { handleMemoryRoute, type MemoryRouteContext } from './memory-routes.js';
export { createModeOperations, type ModeOperationsContext } from './mode-operations.js';
export type { ModeRouteHandlers } from './mode-routes.js';
export { createModeRouteHandlers, handleModeRoute } from './mode-routes.js';
export { resolveProviderCatalogForModels, resolveProviderModelMetadata } from './model-catalog.js';
export {
  createModelOperations,
  type ModelOperationsContext,
  type ModelRefinePayload,
} from './model-operations.js';
export {
  formatExternalAccessUrls,
  getExternalAddresses,
  type NetworkAddress,
} from './network-info.js';
export { browserOpenCommand, openBrowser } from './open-browser.js';
export { isPathInside, resolveWorkingDirInsideProject } from './path-containment.js';
export type { ConfirmDecision, PendingConfirm } from './pending-confirms.js';
export {
  isDestructivePendingConfirm,
  resolveAllPendingConfirms,
  resolveYoloEligiblePendingConfirms,
} from './pending-confirms.js';
export {
  findFreePort,
  getSurfaceDefaultPorts,
  isPortFree,
  isStrictPort,
  listenWithRetry,
  SURFACE_DEFAULT_PORTS,
  type SurfaceKind,
  surfaceLabel,
} from './port-utils.js';
export {
  type ConfigWriteLockHolder,
  PREF_KEYS,
  type PrefHelperDeps,
  persistPrefsToConfig,
  prefSnapshot,
} from './pref-helpers.js';
export {
  handleAutonomySwitch,
  handlePrefsGet,
  handlePrefsUpdate,
  handleSystemPromptGet,
  type PrefsHandlerContext,
} from './prefs-handlers.js';
export {
  createPrefsRouteHandlers,
  handlePrefsRoute,
  type PrefsRouteHandlers,
} from './prefs-routes.js';
export {
  handleProcessKill,
  handleProcessKillAll,
  handleProcessList,
} from './process-handlers.js';
export { handleProcessRoute, type ProcessRouteHandlers } from './process-routes.js';
export { createProjectHandlers, type ProjectHandlersContext } from './project-handlers.js';
export type { ProjectRouteHandlers } from './project-routes.js';
export { handleProjectRoute } from './project-routes.js';
export { startProjectWatcher } from './project-watcher.js';
export {
  ensureProjectDataDir,
  loadManifest,
  projectsJsonPath,
  saveManifest,
  touchProjectInManifest,
} from './projects-manifest.js';
export {
  handlePromptsContent,
  handlePromptsCreate,
  handlePromptsFavorite,
  handlePromptsJournal,
  handlePromptsList,
  handlePromptsRecent,
  handlePromptsSearch,
  handlePromptsUsed,
  type PromptsContext,
} from './prompts-handlers.js';
export { loadSavedProviders, saveProviders } from './provider-config-io.js';
export { createProviderConfigIO } from './provider-config-standalone.js';
export {
  createProviderHandlers,
  createProviderOperations,
  type ProviderOperationsDeps,
  type ProviderPersistence,
  probeModelDescriptors,
  projectSavedProviders,
  type SavedProviderView,
} from './provider-handlers.js';
export {
  addProvider,
  deleteKey,
  type KeyOpResult,
  maskedKey,
  normalizeKeys,
  type ProvidersRecord,
  removeProvider,
  setActiveKey,
  upsertKey,
  writeKeysBack,
} from './provider-keys.js';
export type { ProviderMutationHandlers, ProviderRouteHandlers } from './provider-routes.js';
export { handleProviderRoute } from './provider-routes.js';
export type { ProviderStore } from './provider-store.js';
export { createConfigWriteLock, createProviderStore } from './provider-store.js';
export {
  createRouteFamilyDispatcher,
  type RouteFamilyDispatcher,
  type RouteFamilyDispatcherOptions,
  type RouteFamilyTable,
} from './route-family-dispatcher.js';
export { handleSddBoardRoute, type SddBoardRouteHandlers } from './sdd-board-routes.js';
export { SddBoardWebSocketHandler } from './sdd-board-ws-handler.js';
export { handleSddWizardRoute, type SddWizardRouteHandlers } from './sdd-wizard-routes.js';
export {
  buildSddWizardDeps,
  type SddWizardWiringOptions,
  type StartSddRunFromGraphConfig,
  type StartSddRunFromGraphDeps,
  startSddRunFromGraph,
} from './sdd-wizard-wiring.js';
export { type SddWizardDeps, SddWizardWebSocketHandler } from './sdd-wizard-ws-handler.js';
export {
  createSessionAgentRegistry,
  type SessionAgentRegistry,
  type SessionAgentRegistryOptions,
} from './session-agent-registry.js';
export {
  cleanupOwnerlessEmptySessions,
  DEFAULT_EMPTY_SESSION_CLEANUP_INTERVAL_MS,
  EMPTY_SESSION_CLEANUP_INTERVAL_ENV,
  resolveEmptySessionCleanupInterval,
  scheduleOwnerlessEmptySessionCleanup,
} from './session-cleanup-scheduler.js';
export { deleteWebUISession } from './session-deletion.js';
export {
  createSessionHandlers,
  createSessionTransitionGate,
  type SessionHandlersContext,
} from './session-handlers.js';
export {
  type SessionHistoryWireEntry,
  toSessionHistoryEntries,
  toSessionHistoryEntry,
} from './session-history.js';
export type { SessionRouteHandlers } from './session-routes.js';
export { handleSessionRoute } from './session-routes.js';
export { setupEvents, statusProjectHashFromWatchFilename } from './setup-events.js';
export type { ShellGitRouteHandlers } from './shell-git-routes.js';
export { handleShellGitRoute } from './shell-git-routes.js';
export {
  handleShellOpen,
  type ShellOpenOptions,
  type ShellOpenRequest,
  type ShellOpenResult,
  type ShellOpenTarget,
} from './shell-open.js';
export {
  handleSkillsContent,
  handleSkillsCreate,
  handleSkillsEdit,
  handleSkillsExport,
  handleSkillsInstall,
  handleSkillsList,
  handleSkillsUninstall,
  handleSkillsUpdate,
  type SkillsContext,
} from './skills-handlers.js';
export { handleSpecsRoute, type SpecsRouteHandlers } from './specs-routes.js';
export { SpecsWebSocketHandler } from './specs-ws-handler.js';
export { startWebUI } from './start-webui.js';
export {
  createStreamCoalescer,
  type StreamCoalescer,
  type StreamCoalescerDeps,
  type ToolProgressPayload,
} from './stream-coalescer.js';
export {
  buildSystemPromptInfo,
  type SystemPromptInfoPayload,
  type SystemPromptSurface,
  type SystemPromptVariantInfo,
  unavailableSystemPromptInfo,
} from './system-prompt-handlers.js';
export {
  rebuildSystemPrompt,
  type SystemPromptRebuildDeps,
} from './system-prompt-rebuild.js';
export { TerminalWebSocketHandler } from './terminal-ws-handler.js';
export {
  type ContextBreakdown,
  estimateContextBreakdown,
  estimateTokens,
  type MessageTokenEntry,
  messagePreview,
  messageTokens,
  stringifyContent,
  type ToolTokenEntry,
} from './token-estimator.js';
export type {
  BackendServices,
  ConnectedClient,
  WebUIOptions,
  WSClientMessage,
  WSServerMessage,
} from './types.js';
export {
  type CostRates,
  computeUsageCost,
  getCostRates,
  type TokenUsage,
} from './usage-cost.js';
export {
  createWorklistRouteHandlers,
  handleWorklistRoute,
  type WorklistRouteContext,
  type WorklistRouteHandlers,
} from './worklist-routes.js';
export { handleWorktreeRoute, type WorktreeRouteHandlers } from './worktree-routes.js';
export { WorktreeWebSocketHandler } from './worktree-ws-handler.js';
export {
  extractToken,
  extractTokenFromCookie,
  hostHeaderOk,
  isLoopbackBind,
  isLoopbackHostname,
  isWildcardBind,
  tokenMatches,
  type VerifyClientInput,
  verifyClient,
} from './ws-auth.js';
export {
  validateAutonomySwitchPayload,
  validateBrainAskPayload,
  validateBrainRiskPayload,
  validateContextModeCreatePayload,
  validateContextModeDeletePayload,
  validateContextModeSwitchPayload,
  validateContextModeUpdatePayload,
  validateGitDiffPayload,
  validateMailboxAgentsPayload,
  validateMailboxMessagesPayload,
  validateMailboxPurgePayload,
  validateModelSwitchPayload,
  validateModeSwitchPayload,
  validatePlanTemplateUsePayload,
  validatePrefsUpdatePayload,
  validateProcessKillPayload,
  validateProjectsAddPayload,
  validateProjectsSelectPayload,
  validateShellOpenPayload,
  validateSkillsCreatePayload,
  validateSkillsEditPayload,
  validateWorkingDirSetPayload,
} from './ws-payload-validation.js';
export {
  broadcast,
  buildWebUIAccessUrl,
  clientWantsSession,
  envFlag,
  errMessage,
  generateAuthToken,
  hostForBrowserUrl,
  resolveAuthToken,
  send,
  sendResult,
  sendSerialized,
  WEBUI_WS_MAX_BUFFERED_BYTES,
} from './ws-utils.js';
export { createZipBuffer, readZipEntries, type ZipEntryInput } from './zip.js';
