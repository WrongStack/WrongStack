// Storage domain: sessions, memory, attachments, config, recovery, session analysis
export {
  DefaultSessionStore,
  type SessionStoreOptions,
} from './session-store.js';
export {
  SessionCheckpointCas,
  type CheckpointGitResult,
  type SessionCheckpointCasOptions,
} from './session-checkpoint-cas.js';
export { generateSessionId, sanitizeModel } from './session-id.js';
export {
  resolveSessionId,
  sessionIdResolutionError,
  type SessionIdResolution,
} from './session-id-resolver.js';
export {
  QUEUE_MAX_BYTES,
  QUEUE_MAX_ITEM_BYTES,
  QUEUE_MAX_ITEMS,
  QueueStore,
  retainPersistedQueueItems,
  type PersistedQueueItem,
} from './queue-store.js';
export {
  DefaultAttachmentStore,
  type AttachmentStoreOptions,
} from './attachment-store.js';
export {
  FileMemoryBackend,
  type FileMemoryBackendOptions,
  type MemoryBackend,
  parseEntries,
} from './memory-backend.js';
export {
  GraphMemoryBackend,
  type GraphMemoryBackendOptions,
} from './memory-graph-backend.js';
export {
  SessionMemoryConsolidator,
  type MemoryConsolidatorOptions,
  type ConsolidationOp,
  type ConsolidatorSage,
} from './memory-consolidator.js';
export { DefaultConfigStore } from './config-store.js';
export {
  readProviderSnapshot,
  watchProviderConfig,
  type ProviderConfigSnapshot,
  type WatchProviderConfigOptions,
} from './provider-config-watcher.js';
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
  runConfigMigrations,
  ConfigMigrationError,
  DEFAULT_CONFIG_MIGRATIONS,
  type ConfigMigration,
  type MigrationContext,
  type MigrationResult,
} from './config-migration.js';
export {
  RecoveryLock,
  type RecoveryLockOptions,
  type AbandonedSession,
} from './recovery-lock.js';
export { DefaultSessionReader } from './session-reader.js';
export type { SessionReader, DefaultSessionReaderOptions } from '../types/session-reader.js';
export {
  scrubPersistedSessionData,
  scrubPersistedSessionEvent,
  scrubPersistedSessionSummary,
} from './session-read-scrubber.js';
export {
  AnnotationsStore,
  type Annotation,
  type AnnotationsStoreOptions,
} from './annotations-store.js';
export {
  ReplayLogStore,
  type ReplayEntry,
  type ReplayLogStoreOptions,
} from './replay-log-store.js';
export {
  SessionRecovery,
  type StaleSession,
  type RecoveryPlan,
} from './session-recovery.js';
export {
  ToolAuditLog,
  type AuditEntry,
  type ToolAuditLogOptions,
  type VerifyResult,
} from './tool-audit-log.js';
export { SessionAnalyzer } from './session-analyzer.js';
export {
  SessionRegistry,
  getSessionRegistry,
  hasSessionRegistry,
  type SessionRegistryEntry,
  type AgentEntry,
  type AgentLiveStatus,
  type SessionLiveStatus,
} from '../session-registry.js';
export {
  AgentStatusTracker,
  type AgentStatusTrackerOptions,
} from '../agent-status-tracker.js';
export {
  FleetNotifier,
  type FleetNotifierOptions,
} from '../fleet-notifier.js';
export {
  DefaultSessionRewinder,
  type SessionRewinderOptions,
} from './session-rewinder.js';
export {
  applyRewindToConversation,
  type ApplyRewindOptions,
  type ApplyRewindResult,
  type RewindableConversation,
} from './session-rewind-apply.js';
export {
  attachTodosCheckpoint,
  loadTodosCheckpoint,
  saveTodosCheckpoint,
  type TodosCheckpointFile,
} from './todos-checkpoint.js';
export {
  loadCompletedWorkCheckpoint,
  saveCompletedWorkCheckpoint,
  type CompletedWorkCheckpointFile,
} from './completed-work-checkpoint.js';
export {
  attachPlanCheckpoint,
  loadPlan,
  savePlan,
  emptyPlan,
  addPlanItem,
  removePlanItem,
  setPlanItemStatus,
  clearPlan,
  formatPlan,
  deriveTodosFromPlanItem,
  mutatePlan,
  type PlanItem,
  type PlanFile,
} from './plan-store.js';
export {
  listPlanTemplates,
  getPlanTemplate,
  formatPlanTemplates,
  type PlanTemplate,
} from './plan-templates.js';
export {
  loadTasks,
  saveTasks,
  emptyTaskFile,
  mutateTasks,
  type TaskFile,
} from './task-store.js';
export {
  DirectorStateCheckpoint,
  loadDirectorState,
  type DirectorStateSnapshot,
  type DirectorTaskState,
  type DirectorSubagentState,
} from './director-state.js';
export {
  loadGoal,
  saveGoal,
  emptyGoal,
  appendJournal,
  formatGoal,
  setProgress,
  recordProgress,
  parseProgressFromText,
  goalFilePath,
  summarizeUsage,
  MAX_JOURNAL_ENTRIES,
  MAX_PROGRESS_HISTORY,
  type GoalFile,
  type JournalEntry,
  type ProgressSnapshot,
} from './goal-store.js';
export {
  createGoalKanbanBoard,
  findGoalKanbanBoard,
  deleteGoalKanbanBoard,
  findGoalBoardByTag,
  formatGoalKanbanPreview,
  formatGoalEvent,
  formatGoalAutonomyChoice,
  parseAutonomyChoice,
  type GoalFileWithKanban,
} from './goal-kanban.js';
export {
  applyGoalDeliverableCompletions,
  coordinateGoalIteration,
  isGoalDeliverableComplete,
  parseCompletedGoalDeliverables,
  recomputeGoalProgress,
  stripGoalDeliverableMarker,
  type CompletedGoalDeliverable,
  type CoordinateGoalIterationOptions,
  type GoalCoordinationResult,
} from './goal-coordination.js';
export {
  DefaultPromptStore,
  migratePromptEntry,
  promptChecksum,
  type PromptStore,
  type PromptEntry,
} from './prompt-store.js';
export { PromptUsageStore, type PromptUsage } from './prompt-usage-store.js';
export {
  InputHistoryStore,
  INPUT_HISTORY_DEFAULT_MAX,
} from './input-history-store.js';
export {
  CloudSync,
  type SyncResult,
  ALL_SYNC_CATEGORIES,
} from './cloud-sync.js';

export {
  createSessionEventBridge,
  resolveAuditLevel,
  resolveSessionLoggingConfig,
  type SessionEventBridge,
  type AuditLevel,
  type SessionEventBridgeOptions,
  type SessionSamplingOptions,
  type ToolProgressSamplingOptions,
  CORE_RECONSTRUCT_EVENTS,
  STANDARD_AUDIT_EVENTS,
} from './session-event-bridge.js';
export type { SyncConfig, SyncCategory } from '../types/config.js';
