// Storage domain: sessions, memory, attachments, config, recovery, session analysis

export {
  type CatalogSessionRecord,
  type MaintenanceLease,
  type ResumeReservation,
  type SessionCatalogHealth,
  SessionCatalogProjectClient,
  type SessionCatalogProjectClientOptions,
  type SessionLeaseCredential,
  type SessionResumeClaim,
} from '../session-catalog/index.js';
export {
  getProjectSessionRegistry as getSessionRegistry,
  hasProjectSessionRegistry as hasSessionRegistry,
  ProjectSessionRegistry as SessionRegistry,
} from '../session-catalog/registry.js';
export {
  deriveSessionAgents,
  type SessionAgentRecord,
  type SessionAgentStatus,
} from '../session-catalog/session-agents.js';
export type {
  AgentEntry,
  AgentLiveStatus,
  SessionLiveStatus,
  SessionRegistryEntry,
  SessionWebUIEndpointHint,
} from '../session-catalog/session-registry.js';
/**
 * @deprecated Test/migration adapter; production ownership uses SessionRegistry
 * above. Remove once `packages/webui-server/tests/standalone-session-identity.test.ts`
 * migrates to the canonical subpath import (tracked for the 0.320 major).
 */
export { SessionRegistry as LegacySessionRegistry } from '../session-catalog/session-registry.js';
export type { SyncCategory, SyncConfig } from '../types/config.js';
export type { DefaultSessionReaderOptions, SessionReader } from '../types/session-reader.js';
export {
  type Annotation,
  AnnotationsStore,
  type AnnotationsStoreOptions,
} from './annotations-store.js';
export {
  type AttachmentStoreOptions,
  DefaultAttachmentStore,
} from './attachment-store.js';
export {
  type BoardStorePort,
  boardStore,
  setBoardStorePort,
} from './board-store-port.js';
export {
  applyNamespacePayload,
  buildNamespacePayloads,
  CLOUD_SYNC_CONTRACT,
  CLOUD_SYNC_NAMESPACES,
  CloudConfigSync,
  type CloudConfigSyncDeps,
  type CloudConfigSyncSettings,
  type CloudSyncPassSummary,
  LOCAL_ONLY_TOP_LEVEL,
  NAMESPACE_SCHEMA_VERSIONS,
  stripSecretMaterial,
} from './cloud-config-sync.js';
export {
  ALL_SYNC_CATEGORIES,
  CloudSync,
  type SyncResult,
} from './cloud-sync.js';
export {
  type CompletedWorkCheckpointFile,
  loadCompletedWorkCheckpoint,
  saveCompletedWorkCheckpoint,
} from './completed-work-checkpoint.js';
export {
  CONFIG_BEHAVIOR_DEFAULTS,
  type ConfigDefaultRepair,
  type ConfigDefaultRepairReport,
  type ConfigLoaderOptions,
  type ConfigSource,
  DefaultConfigLoader,
  repairConfigDefaults,
} from './config-loader.js';
export {
  type ConfigMigration,
  ConfigMigrationError,
  DEFAULT_CONFIG_MIGRATIONS,
  type MigrationContext,
  type MigrationResult,
  runConfigMigrations,
} from './config-migration.js';
export { DefaultConfigStore } from './config-store.js';
export {
  DirectorStateCheckpoint,
  type DirectorStateSnapshot,
  type DirectorSubagentState,
  type DirectorTaskState,
  loadDirectorState,
} from './director-state.js';
export {
  applyGoalDeliverableCompletions,
  type CompletedGoalDeliverable,
  type CoordinateGoalIterationOptions,
  coordinateGoalIteration,
  type GoalCoordinationResult,
  isGoalDeliverableComplete,
  parseCompletedGoalDeliverables,
  recomputeGoalProgress,
  stripGoalDeliverableMarker,
} from './goal-coordination.js';
export {
  createGoalKanbanBoard,
  deleteGoalKanbanBoard,
  findGoalBoardByTag,
  findGoalKanbanBoard,
  formatGoalAutonomyChoice,
  formatGoalEvent,
  formatGoalKanbanPreview,
  type GoalFileWithKanban,
  parseAutonomyChoice,
} from './goal-kanban.js';
export {
  appendJournal,
  emptyGoal,
  formatGoal,
  type GoalFile,
  goalFilePath,
  type JournalEntry,
  loadGoal,
  MAX_JOURNAL_ENTRIES,
  MAX_PROGRESS_HISTORY,
  type ProgressSnapshot,
  parseProgressFromText,
  recordProgress,
  saveGoal,
  setProgress,
  summarizeUsage,
} from './goal-store.js';
export {
  INPUT_HISTORY_DEFAULT_MAX,
  InputHistoryStore,
} from './input-history-store.js';
export {
  FileMemoryBackend,
  type FileMemoryBackendOptions,
  type MemoryBackend,
  parseEntries,
} from './memory-backend.js';
export {
  type ConsolidationOp,
  type ConsolidatorSage,
  type MemoryConsolidatorOptions,
  SessionMemoryConsolidator,
} from './memory-consolidator.js';
export {
  type CuratorOperation,
  type CuratorSage,
  type CuratorSageCandidate,
  type CuratorSageRecord,
  type SessionMemoryCuratorOptions,
  SessionMemoryCurator,
} from './memory-curator.js';
export {
  GraphMemoryBackend,
  type GraphMemoryBackendOptions,
} from './memory-graph-backend.js';
export {
  cleanOrphanLocks,
  type OrphanLockCleanResult,
} from './orphan-lock-cleaner.js';
export {
  addPlanItem,
  attachPlanCheckpoint,
  clearPlan,
  deriveTodosFromPlanItem,
  emptyPlan,
  formatPlan,
  loadPlan,
  mutatePlan,
  type PlanFile,
  type PlanItem,
  removePlanItem,
  savePlan,
  setPlanItemStatus,
} from './plan-store.js';
export {
  formatPlanTemplates,
  getPlanTemplate,
  listPlanTemplates,
  type PlanTemplate,
} from './plan-templates.js';
export {
  DefaultPromptStore,
  migratePromptEntry,
  type PromptEntry,
  type PromptStore,
  promptChecksum,
} from './prompt-store.js';
export { type PromptUsage, PromptUsageStore } from './prompt-usage-store.js';
export {
  type ProviderConfigSnapshot,
  readProviderSnapshot,
  type WatchProviderConfigOptions,
  watchProviderConfig,
} from './provider-config-watcher.js';
export {
  type PersistedQueueItem,
  QUEUE_MAX_BYTES,
  QUEUE_MAX_ITEM_BYTES,
  QUEUE_MAX_ITEMS,
  QueueStore,
  retainPersistedQueueItems,
} from './queue-store.js';
export {
  type AbandonedSession,
  RecoveryLock,
  type RecoveryLockOptions,
} from './recovery-lock.js';
export {
  type ReplayEntry,
  ReplayLogStore,
  type ReplayLogStoreOptions,
} from './replay-log-store.js';
export { stampAgentId, withAgentAttribution } from './session-agent-attribution.js';
export { SessionAnalyzer } from './session-analyzer.js';
export {
  type CheckpointGitResult,
  SessionCheckpointCas,
  type SessionCheckpointCasOptions,
} from './session-checkpoint-cas.js';
export {
  type AuditLevel,
  CORE_RECONSTRUCT_EVENTS,
  createSessionEventBridge,
  resolveAuditLevel,
  resolveSessionLoggingConfig,
  type SessionEventBridge,
  type SessionEventBridgeOptions,
  type SessionSamplingOptions,
  STANDARD_AUDIT_EVENTS,
  type ToolProgressSamplingOptions,
} from './session-event-bridge.js';
export { generateSessionId, sanitizeModel } from './session-id.js';
export {
  resolveSessionId,
  type SessionIdResolution,
  sessionIdResolutionError,
} from './session-id-resolver.js';
export {
  scrubPersistedSessionData,
  scrubPersistedSessionEvent,
  scrubPersistedSessionSummary,
} from './session-read-scrubber.js';
export { DefaultSessionReader } from './session-reader.js';
export {
  extractInterruptedTools,
  type InterruptedToolDetail,
  type RecoveryPlan,
  SessionRecovery,
  type StaleSession,
} from './session-recovery.js';
export {
  type ApplyRewindOptions,
  type ApplyRewindResult,
  applyRewindToConversation,
  type RewindableConversation,
} from './session-rewind-apply.js';
export {
  DefaultSessionRewinder,
  type SessionRewinderOptions,
} from './session-rewinder.js';
export {
  DefaultSessionStore,
  type SessionStoreOptions,
} from './session-store.js';
export {
  emptyTaskFile,
  loadTasks,
  mutateTasks,
  saveTasks,
  type TaskFile,
} from './task-store.js';
export {
  attachTodosCheckpoint,
  loadTodosCheckpoint,
  saveTodosCheckpoint,
  type TodosCheckpointFile,
} from './todos-checkpoint.js';
export {
  type AuditEntry,
  ToolAuditLog,
  type ToolAuditLogOptions,
  type VerifyResult,
} from './tool-audit-log.js';
