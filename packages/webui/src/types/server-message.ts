import type {
  ChronicleFacet,
  ChronicleFacetValue,
  ChronicleGraphResult,
  ChronicleMetricsResultPayload,
  ChronicleQueryResult,
  ChronicleStatus,
} from './chronicle.js';
import type {
  WSCollabAnnotationAdded,
  WSCollabAnnotationResolved,
  WSCollabEvent,
  WSCollabInjectionGranted,
  WSCollabParticipantJoined,
  WSCollabParticipantLeft,
  WSCollabPauseGranted,
  WSCollabPauseReleased,
  WSCollabState,
} from './collab.js';
import type {
  AutoHealStatusEvent,
  ConnectionsHealthReport,
  ServiceActionResult,
} from './connections.js';
import type {
  WSAgentStatusChanged,
  WSAgentTimelineMessage,
  WSEternalIteration,
  WSGoalAssessResult,
  WSGoalLifecycle,
  WSGoalList,
  WSGoalProgress,
  WSGoalState,
  WSKanbanResult,
  WSKanbanTaskActivity,
  WSModesList,
  WSWorktreeCleanupResult,
  WSWorktreeDiffResult,
  WSWorktreeEvent,
  WSWorktreeMergeResult,
  WSWorktreeOrphans,
  WSWorktreeState,
} from './goal-kanban-worktree.js';
import type {
  WSCodeMapToolExecuted,
  WSCodeMapToolStarted,
  WSIterationCompleted,
  WSIterationLimitReached,
  WSIterationStarted,
  WSProviderActiveBlocked,
  WSProviderAuditHistory,
  WSProviderError,
  WSProviderFallback,
  WSProviderFallbackPending,
  WSProviderResponse,
  WSProviderRetry,
  WSProviderStatusChanged,
  WSProviderStatusSnapshot,
  WSProviderStreamError,
  WSRunResult,
  WSSessionEnd,
  WSSessionResumeProgress,
  WSSessionRunState,
  WSSessionStart,
  WSTextDelta,
  WSThinkingDelta,
  WSToolExecuted,
  WSToolProgress,
  WSToolUseStart,
} from './protocol-core.js';
import type {
  WSCompactionFailed,
  WSContextCompacted,
  WSContextDebug,
  WSContextEditorApplied,
  WSContextEditorSnapshot,
  WSContextEditorValidation,
  WSContextMaxContext,
  WSContextModeChanged,
  WSContextModesList,
  WSContextPct,
  WSContextRepaired,
  WSDelegateCompleted,
  WSDelegateStarted,
  WSError,
  WSMemoryList,
  WSSessionStats,
  WSTokenCostEstimateUnavailable,
  WSTokenThreshold,
  WSToolConfirmNeeded,
  WSToolLoopDetected,
  WSToolsList,
  WSTopicAdviceResult,
  WSTrustPersisted,
} from './runtime.js';
import type {
  WSMemorySageBackfillRecoverable,
  WSMemorySageCandidateResolve,
  WSMemorySageDelete,
  WSMemorySageForFile,
  WSMemorySageGet,
  WSMemorySageGraph,
  WSMemorySageList,
  WSMemorySageListCandidates,
  WSMemorySageListPage,
  WSMemorySageRecover,
  WSMemorySageRemember,
  WSMemorySageSearchBreakdown,
  WSMemorySageUpdate,
} from './sage.js';
import type { WSChimeraServerMessage } from './server-message-chimera.js';
import type { WSFilesGitServerMessage } from './server-message-files.js';
import type { WSFleetServerMessage } from './server-message-fleet.js';
import type { WSMcpServerMessage } from './server-message-mcp.js';
import type { WSSystemMiscServerMessage } from './server-message-system.js';
import type {
  WSDesignList,
  WSDesignMaterialize,
  WSDesignSet,
  WSDesignState,
  WSDesignSwap,
  WSDesignTune,
  WSDesignUse,
  WSDesignVerify,
  WSSkillContent,
  WSSkillsCreated,
  WSSkillsEdited,
  WSSkillsExported,
  WSSkillsInstalled,
  WSSkillsList,
  WSSkillsUninstalled,
  WSSkillsUpdated,
} from './skills-design.js';
import type {
  WSAuthOAuthStatus,
  WSCatalogModelSearchResult,
  WSCompletionResult,
  WSDiagGet,
  WSFilesList,
  WSKeyOperationResult,
  WSModelSwitchResult,
  WSProviderCatalog,
  WSProviderModels,
  WSProviderProbe,
  WSSavedProviders,
  WSSessionInspect,
  WSSessionsList,
  WSSideEffects,
  WSStatsGet,
  WSTodosCleared,
  WSTodosUpdated,
} from './system.js';

export type WSServerMessage =
  | WSSessionStart
  | WSSessionEnd
  | WSTextDelta
  | WSThinkingDelta
  | WSToolUseStart
  | WSToolProgress
  | WSToolExecuted
  | WSCodeMapToolStarted
  | WSCodeMapToolExecuted
  | WSIterationStarted
  | WSIterationCompleted
  | WSIterationLimitReached
  | WSProviderResponse
  | WSProviderRetry
  | WSProviderAuditHistory
  | WSProviderError
  | WSProviderFallback
  | WSProviderFallbackPending
  | WSProviderStatusChanged
  | WSProviderStatusSnapshot
  | WSProviderActiveBlocked
  | WSProviderStreamError
  | WSRunResult
  | WSSessionRunState
  | WSSessionResumeProgress
  | WSSessionStats
  | WSError
  | WSToolConfirmNeeded
  | WSTrustPersisted
  | WSToolLoopDetected
  | WSDelegateStarted
  | WSDelegateCompleted
  | WSContextDebug
  | WSContextCompacted
  | WSCompactionFailed
  | WSContextRepaired
  | WSContextEditorSnapshot
  | WSContextEditorValidation
  | WSContextEditorApplied
  | WSContextPct
  | WSTopicAdviceResult
  | WSContextMaxContext
  | WSTokenThreshold
  | WSTokenCostEstimateUnavailable
  | WSContextModesList
  | WSContextModeChanged
  | WSToolsList
  | WSMemoryList
  | WSMemorySageList
  | WSMemorySageListPage
  | WSMemorySageListCandidates
  | WSMemorySageGet
  | WSMemorySageGraph
  | WSMemorySageSearchBreakdown
  | WSMemorySageUpdate
  | WSMemorySageRemember
  | WSMemorySageDelete
  | WSMemorySageRecover
  | WSMemorySageCandidateResolve
  | WSMemorySageBackfillRecoverable
  | WSMemorySageForFile
  | WSSkillsList
  | WSSkillContent
  | WSDesignList
  | WSDesignUse
  | WSDesignState
  | WSDesignSet
  | WSDesignTune
  | WSDesignSwap
  | WSDesignMaterialize
  | WSDesignVerify
  | WSSkillsInstalled
  | WSSkillsUninstalled
  | WSSkillsUpdated
  | WSSkillsCreated
  | WSSkillsEdited
  | WSSkillsExported
  | WSDiagGet
  | WSStatsGet
  | { type: 'connections.health_result'; payload: ConnectionsHealthReport }
  | { type: 'connections.health_error'; payload: { message: string } }
  | { type: 'connections.service_action_result'; payload: ServiceActionResult }
  | { type: 'connections.auto_heal_status'; payload: AutoHealStatusEvent }
  | { type: 'chronicle.status_result'; payload: ChronicleStatus }
  | { type: 'chronicle.query_result'; payload: ChronicleQueryResult }
  | {
      type: 'chronicle.facet_result';
      payload: {
        field: ChronicleFacet;
        values: ChronicleFacetValue[];
        diagnostics: { sourceFiles: number; invalidLines: number };
      };
    }
  | {
      type: 'chronicle.facets_result';
      payload: {
        values: Partial<Record<ChronicleFacet, ChronicleFacetValue[]>>;
        diagnostics: { sourceFiles: number; invalidLines: number };
      };
    }
  | { type: 'chronicle.graph_result'; payload: ChronicleGraphResult }
  | { type: 'chronicle.metrics_result'; payload: ChronicleMetricsResultPayload }
  | { type: 'chronicle.error'; payload: { message: string } }
  | WSSessionsList
  | WSSessionInspect
  | WSProviderCatalog
  | WSCatalogModelSearchResult
  | WSProviderModels
  | WSSavedProviders
  | WSProviderProbe
  | WSKeyOperationResult
  | WSModelSwitchResult
  | WSAuthOAuthStatus
  | WSFilesList
  | WSFilesGitServerMessage
  | WSCompletionResult
  | WSTodosUpdated
  | WSTodosCleared
  | WSModesList
  | WSGoalState
  | WSGoalProgress
  | WSGoalLifecycle
  | WSGoalList
  | WSGoalAssessResult
  | WSEternalIteration
  | WSAgentTimelineMessage
  | WSAgentStatusChanged
  | WSKanbanResult
  | WSKanbanTaskActivity
  | WSWorktreeState
  | WSWorktreeEvent
  | WSWorktreeOrphans
  | WSWorktreeCleanupResult
  | WSWorktreeMergeResult
  | WSWorktreeDiffResult
  | WSCollabState
  | WSCollabParticipantJoined
  | WSCollabParticipantLeft
  | WSCollabEvent
  | WSCollabAnnotationAdded
  | WSCollabAnnotationResolved
  | WSCollabPauseGranted
  | WSCollabPauseReleased
  | WSCollabInjectionGranted
  | WSSideEffects
  | WSMcpServerMessage
  | WSChimeraServerMessage
  | WSFleetServerMessage
  | WSSystemMiscServerMessage;

export type { WSChimeraServerMessage } from './server-message-chimera.js';
export type { WSFilesGitServerMessage } from './server-message-files.js';
export type { WSFleetServerMessage } from './server-message-fleet.js';
export type { WSMcpServerMessage } from './server-message-mcp.js';
export type {
  WSPromptJournalEntry,
  WSPromptsJournalPayload,
  WSSystemMiscServerMessage,
  WSSystemPromptInfo,
  WSSystemPromptVariantInfo,
} from './server-message-system.js';
