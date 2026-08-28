import type { BrainConfigWire } from './brain.js';
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
  SessionScopedPayload,
  WSCodeMapToolExecuted,
  WSCodeMapToolStarted,
  WSIterationCompleted,
  WSIterationLimitReached,
  WSIterationStarted,
  WSProviderActiveBlocked,
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
  | WSProviderError
  | WSProviderFallback
  | WSProviderFallbackPending
  | WSProviderStatusChanged
  | WSProviderStatusSnapshot
  | WSProviderActiveBlocked
  | WSProviderStreamError
  | WSRunResult
  | WSSessionRunState
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
  | {
      type: 'codebase.index.server.shutdown_result';
      payload: {
        requestId?: string | undefined;
        stopped: boolean;
        pid?: number | undefined;
        reason?: string | undefined;
      };
    }
  | WSProviderProbe
  | WSKeyOperationResult
  | WSModelSwitchResult
  | WSAuthOAuthStatus
  | WSFilesList
  | {
      type: 'files.tree';
      payload: {
        root: string;
        tree: unknown[];
        error?: string | undefined;
        sessionId?: string | undefined;
      };
    }
  | {
      type: 'files.read';
      payload: {
        filePath: string;
        content: string;
        /** Server refused content: NUL byte detected (see handleFilesRead). */
        binary?: boolean | undefined;
        /** Server refused content: file exceeds the 2 MB display cap. */
        tooLarge?: boolean | undefined;
        error?: string | undefined;
        sessionId?: string | undefined;
      };
    }
  | {
      type: 'files.skeleton_result';
      payload: {
        filePath: string;
        lang?: string | undefined;
        skeleton: string;
        stats?:
          | {
              originalLines: number;
              skeletonLines: number;
              tokenSavingsPercent: number;
              symbolCount: number;
            }
          | undefined;
        error?: string | undefined;
      };
    }
  | {
      type: 'files.written';
      payload: {
        filePath: string;
        success: boolean;
        error?: string | undefined;
        sessionId?: string | undefined;
      };
    }
  | {
      type: 'files.created';
      payload: {
        filePath: string;
        success: boolean;
        error?: string | undefined;
        sessionId?: string | undefined;
      };
    }
  | {
      type: 'files.deleted';
      payload: {
        filePath: string;
        success: boolean;
        error?: string | undefined;
        sessionId?: string | undefined;
      };
    }
  | {
      type: 'files.renamed';
      payload: {
        oldPath: string;
        newPath: string;
        success: boolean;
        error?: string | undefined;
        sessionId?: string | undefined;
      };
    }
  | {
      type: 'files.moved';
      payload: {
        srcPath: string;
        destPath: string;
        success: boolean;
        error?: string | undefined;
        sessionId?: string | undefined;
      };
    }
  | WSCompletionResult
  | WSTodosUpdated
  | WSTodosCleared
  | { type: 'tasks.updated'; payload: { tasks: unknown[]; error?: string | undefined } }
  | { type: 'plan.updated'; payload: { plan: unknown | null; error?: string | undefined } }
  | WSModesList
  | WSGoalState
  | WSGoalProgress
  | WSGoalLifecycle
  | WSGoalList
  | WSGoalAssessResult
  | { type: 'specs.list'; payload: { specs: unknown[] } }
  | { type: 'specs.detail'; payload: Record<string, unknown> }
  | { type: 'sdd.board.snapshot'; payload: Record<string, unknown> | null }
  | { type: 'sdd.board.list'; payload: { boards: unknown[] } }
  | {
      type: 'sdd.board.lifecycle_result';
      payload: {
        op: 'cleanup_worktrees' | 'rollback' | 'destroy';
        ok: boolean;
        removed?: number;
        reverted?: number;
        deleted?: string[];
        reason?: string;
      };
    }
  | { type: 'sdd.spec.snapshot'; payload: Record<string, unknown> }
  | { type: 'sdd.spec.agent_text'; payload: { text: string } }
  | { type: 'sdd.spec.error'; payload: { message: string } }
  | {
      type: 'sdd.run.started';
      payload: { runId: string; graphId?: string; specId?: string };
    }
  | WSEternalIteration
  | WSAgentTimelineMessage
  | WSAgentStatusChanged
  | WSKanbanResult
  | WSKanbanTaskActivity
  | {
      type: 'subagent.event';
      payload: SessionScopedPayload & Record<string, unknown> & { kind: string };
    }
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
  | {
      type: 'session.checkpoints';
      payload: {
        checkpoints: Array<{
          index: number;
          iteration: number;
          timestamp: string;
          label: string;
          messageCount: number;
          tokens: number;
        }>;
      };
    }
  | { type: 'goal-state.updated'; payload: Record<string, unknown> | null }
  | { type: 'prefs.updated'; payload: Record<string, unknown> }
  | { type: 'system_prompt.info'; payload: WSSystemPromptInfo }
  | { type: 'techstack.job.started'; payload: { jobId: string; kind: 'inventory' | 'analyze' } }
  | {
      type: 'techstack.job.progress';
      payload: { jobId: string; phase: string; completed: number; total: number };
    }
  | {
      type: 'techstack.workspace.completed';
      payload: { jobId: string; workspaceId: string; ecosystem: string; dependencyCount: number };
    }
  | {
      type: 'techstack.snapshot.updated';
      payload: {
        snapshot: import('@/stores/techstack-store').TechStackSnapshot;
        stale?: boolean | undefined;
      };
    }
  | { type: 'techstack.report.ready'; payload: { reportId: string; summary?: string | undefined } }
  | { type: 'techstack.report.delivered'; payload: { deliveryId: string; sessionId: string } }
  | { type: 'techstack.job.failed'; payload: { jobId: string; error: string } }
  | { type: 'techstack.job.cancelled'; payload: { jobId: string } }
  | { type: 'client.status_update'; payload: Record<string, unknown> }
  | { type: 'sessions.status_update'; payload: { sessions: unknown[] } }
  | {
      type: 'chimera.report_available';
      payload: {
        reportId: string;
        sessionId: string;
        message: string;
        fileCount: number;
        findingCount: number;
        hasActionableFindings: boolean;
        messageId?: string | undefined;
      };
    }
  | { type: 'mailbox.event'; payload: Record<string, unknown> & { event: string } }
  | { type: 'mailbox.received'; payload: Record<string, unknown> }
  | { type: 'mailbox.agent_registered'; payload: Record<string, unknown> }
  | { type: 'mailbox.agent_deregistered'; payload: Record<string, unknown> }
  // Server replies to the client's mailbox.messages / mailbox.agents
  // requests. Handled via the string-keyed dispatch map today, but they must
  // be in this union so typed `.on()` / useWsHandlers narrowing can express
  // them (a typed migration would otherwise silently drop mailbox data).
  | {
      type: 'mailbox.messages';
      payload: { messages: Array<Record<string, unknown>>; error?: string | undefined };
    }
  | {
      type: 'mailbox.agents';
      payload: { agents: Array<Record<string, unknown>>; error?: string | undefined };
    }
  | {
      type: 'mailbox.sent';
      payload: {
        requestId: string;
        success: boolean;
        messageId?: string | undefined;
        to?: string | undefined;
        audience?: 'all' | 'leaders' | undefined;
        error?: string | undefined;
      };
    }
  | {
      type: 'mailbox.action_result';
      payload: {
        requestId: string;
        success: boolean;
        action?: 'mark-read' | 'acknowledge' | 'reopen' | 'soft-delete' | undefined;
        mailId?: string | undefined;
        error?: string | undefined;
      };
    }
  // Reply to a client `ping` (liveness probe). The payload is absent on the
  // wire; typed as optional so union-wide `msg.payload` access keeps
  // compiling.
  | { type: 'pong'; payload?: Record<string, unknown> | undefined }
  | {
      type: 'process.list';
      payload: {
        sessionId?: string | undefined;
        processes: Array<{
          pid: number;
          command: string;
          tool: string;
          startedAt: number;
          status: 'running' | 'exited' | 'killed';
          protected?: boolean | undefined;
          background?: boolean | undefined;
          sessionId?: string | undefined;
        }>;
      };
    }
  | WSSideEffects
  | {
      type: 'git.info';
      payload: {
        branch: string;
        added: number;
        deleted: number;
        untracked: number;
        behind: number;
        ahead: number;
      };
    }
  | {
      type: 'git.action_result';
      payload: {
        action: 'stage' | 'unstage' | 'discard' | 'commit';
        ok: boolean;
        paths?: string[] | undefined;
        message?: string | undefined;
        error?: string | undefined;
      };
    }
  | {
      type: 'git.changes';
      payload: {
        files: Array<{
          path: string;
          status: string;
          added: number;
          deleted: number;
          staged: boolean;
        }>;
        /**
         * Aggregate status per directory (repo-relative keys): the
         * highest-ranked child status, computed server-side — replaces the
         * old client-side prefix-scan heuristic in FileExplorer.
         */
        dirs?: Record<string, string> | undefined;
        /** Repo→project path prefix ('' when equal) — see repoRelativePrefix. */
        repoPrefix?: string | undefined;
        error?: string | undefined;
      };
    }
  | {
      type: 'git.diff';
      payload: {
        path: string;
        oldText?: string | undefined;
        newText?: string | undefined;
        binary?: boolean | undefined;
        tooLarge?: boolean | undefined;
        error?: string | undefined;
      };
    }
  | {
      type: 'projects.list';
      payload: {
        projects: Array<{
          name: string;
          root: string;
          slug: string;
          lastSeen?: string | undefined;
        }>;
      };
    }
  | {
      type: 'projects.added';
      payload: { name: string; root: string; slug: string; message: string };
    }
  | { type: 'projects.selected'; payload: { root: string; name: string; message: string } }
  | { type: 'working_dir.changed'; payload: { cwd: string; projectRoot: string } }
  | {
      type: 'brain.status';
      payload: {
        maxAutoRisk: string;
        log: Array<{ at: number; kind: string; question: string; outcome: string }>;
        /** Enrichment fields — present when the server wires a BrainRuntime. */
        mode?: 'headless' | 'interactive' | undefined;
        poolLabels?: string[] | undefined;
        councilLabels?: string[] | undefined;
        /** EFFECTIVE council judge — undefined when no council is wired. */
        judgeLabel?: string | undefined;
        /** True when that judge is also a seated voter (correlated tie-break). */
        judgeIsVoter?: boolean | undefined;
        ledgerPath?: string | undefined;
      };
    }
  | {
      type: 'brain.config';
      payload: {
        config: BrainConfigWire;
        persisted: boolean;
        error?: string | undefined;
      };
    }
  | {
      type: 'brain.answer';
      payload: SessionScopedPayload & {
        question: string;
        decision: {
          type: string;
          optionId?: string | undefined;
          text?: string | undefined;
          rationale?: string | undefined;
          reason?: string | undefined;
          prompt?: string | undefined;
        };
      };
    }
  | {
      type: 'brain.event';
      payload: SessionScopedPayload & Record<string, unknown> & { event: string };
    }
  | {
      type: 'memory.event';
      payload: SessionScopedPayload & Record<string, unknown> & { event: string };
    }
  | { type: 'file.saved'; payload: SessionScopedPayload & { filePath: string } }
  | {
      type: 'codemap.file_event';
      payload: SessionScopedPayload & {
        filePath: string;
        operation: 'read' | 'write' | 'edit' | 'delete' | 'rename';
        phase: 'started' | 'completed' | 'changed';
        source: 'tool' | 'editor' | 'deterministic' | 'watcher' | 'external';
        at: number;
        traceId?: string | undefined;
        agentId?: string | undefined;
        agentName?: string | undefined;
        toolUseId?: string | undefined;
        toolName?: string | undefined;
        line?: number | undefined;
        endLine?: number | undefined;
      };
    }
  | {
      type: 'codemap.index_updated';
      payload: {
        at: number;
        ready: boolean;
        reason: 'index_complete';
      };
    }
  | { type: 'session.damaged'; payload: { sessionId: string; detail: string } }
  | {
      type: 'session.rewound';
      payload: SessionScopedPayload & {
        toPromptIndex: number;
        revertedFiles: string[];
        removedEvents: number;
      };
    }
  | {
      type: 'checkpoint.written';
      payload: SessionScopedPayload & {
        promptIndex: number;
        promptPreview: string;
        ts: string;
        fileCount: number;
      };
    }
  | { type: 'in_flight.started'; payload: SessionScopedPayload & { context: string; ts: string } }
  | {
      type: 'in_flight.ended';
      payload: SessionScopedPayload & { reason: 'clean' | 'aborted' | 'recovered'; ts: string };
    }
  | {
      type: 'model.refine_result';
      payload: {
        refined: string;
        english: string;
        error?: string | undefined;
        /** Machine-readable failure class driving client recovery (undefined on success). */
        errorKind?: 'timeout' | 'empty' | 'provider_error' | undefined;
        /** Suggested window (ms) for a retry after a timeout. */
        retryTimeoutMs?: number | undefined;
        /** One-key "retry with another model" offer (provider/model), if any. */
        fallbackRef?: string | undefined;
        /** The provider/model that produced this result (echoes an ephemeral retry). */
        refinedWith?: { provider: string; model: string } | undefined;
      };
    }
  // ── Coordinator / autonomous fleet events ──────────────────────────────
  | {
      type: 'coordinator.status';
      payload: {
        status: 'idle' | 'running' | 'draining' | 'stopped';
        mode?: string;
        subagentCount?: number;
        taskQueue?: { pending: number; running: number; completed: number; failed: number };
      };
    }
  | {
      type: 'coordinator.stats';
      payload: SessionScopedPayload & {
        total: number;
        running: number;
        idle: number;
        stopped: number;
        inFlight: number;
        pending: number;
        completed: number;
        subagentStatuses?: Array<{
          id: string;
          name: string;
          status: string;
          currentTask?: string;
        }>;
      };
    }
  | {
      type: 'fleet.concurrency_update';
      payload: SessionScopedPayload & {
        fleetConcurrency: number;
        fleetConcurrencyMax: number;
        maxSpawns?: number;
        usedSpawns?: number;
        remainingSpawns?: number;
        maxSpawnsSource?: string;
        maxConcurrentSource?: string;
        effectiveSource?: string;
        checkpointMaxSpawns?: number;
        ceilingMismatch?: boolean;
      };
    }
  | {
      type: 'budget.threshold_reached';
      payload: SessionScopedPayload & {
        subagentId: string;
        taskId?: string;
        ts: number;
        kind: string;
        used: number;
        limit: number;
        timeoutMs: number;
      };
    }
  | {
      type: 'budget.decision';
      payload: {
        subagentId: string;
        kind: string;
        decision: 'extend' | 'deny';
        extended?: { timeoutMs?: number; maxIterations?: number; maxToolCalls?: number };
      };
    }
  | {
      type: 'subagent.budget_extended';
      payload: { subagentId: string; kind: string; extendedMs?: number; extendedTo?: number };
    }
  | {
      type: 'consensus.vote_initiated';
      payload: {
        changeId: string;
        title: string;
        eligible: Array<{ agentId: string; agentName: string }>;
      };
    }
  | {
      type: 'consensus.vote_cast';
      payload: { changeId: string; voterId: string; value: 'approve' | 'reject' | 'abstain' };
    }
  | {
      type: 'consensus.vote_resolved';
      payload: {
        changeId: string;
        result: 'approved' | 'rejected' | 'vetoed' | 'quorum_not_met';
        approveCount: number;
        rejectCount: number;
      };
    }
  | { type: 'task.pending'; payload: { taskId: string; description: string; priority?: number } }
  | { type: 'task.started'; payload: { taskId: string; subagentId: string } }
  | {
      type: 'task.completed';
      payload: { taskId: string; subagentId: string; status: string; durationMs: number };
    }
  | { type: 'task.failed'; payload: { taskId: string; subagentId: string; error: string } }
  | { type: 'tool.disabled'; payload: { name: string; ok: boolean } }
  | { type: 'tool.enabled'; payload: { name: string; ok: boolean } }
  // ── MCP server events ───────────────────────────────────────────────────────
  | {
      type: 'config.doctor.result';
      payload: {
        success: boolean;
        applied: boolean;
        changed: boolean;
        changes: Array<{ path: string; action: 'added' | 'replaced' }>;
        configPath: string;
        backupPath?: string;
        error?: string;
      };
    }
  | {
      type: 'mcp.list';
      payload: {
        servers: Array<{
          name: string;
          transport: string;
          status: string;
          enabled: boolean;
          description?: string;
          tools?: string[];
          error?: string;
          pid?: number;
          lazy?: boolean;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
          health?: {
            healthState: 'disabled' | 'dormant' | 'connecting' | 'healthy' | 'degraded' | 'failed';
            consecutiveFailures: number;
            failures: { transport: number; protocol: number; tool: number };
            reconnectCount: number;
            wakeCount: number;
            sleepCount: number;
            restartCount: number;
            inFlightCalls: number;
            peakInFlightCalls: number;
            callLatency: { count: number; lastMs?: number; p50Ms?: number; p95Ms?: number };
          };
        }>;
      };
    }
  | {
      type: 'mcp.server.added';
      payload: {
        server: {
          name: string;
          transport: string;
          status: string;
          enabled: boolean;
          description?: string;
          tools?: string[];
          lazy?: boolean;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
        };
      };
    }
  | { type: 'mcp.server.removed'; payload: { name: string } }
  | {
      type: 'mcp.server.updated';
      payload: {
        server: {
          name: string;
          transport: string;
          status: string;
          enabled: boolean;
          description?: string;
          tools?: string[];
          lazy?: boolean;
          command?: string;
          args?: string[];
          env?: Record<string, string>;
          url?: string;
        };
      };
    }
  | { type: 'mcp.server.discovered'; payload: { name: string; tools: string[] } }
  | { type: 'mcp.server.sleeping'; payload: { name: string } }
  | { type: 'mcp.server.waking'; payload: { name: string } }
  | { type: 'mcp.server.connected'; payload: { name: string; pid?: number; toolCount?: number } }
  | { type: 'mcp.server.reconnected'; payload: { name: string; toolCount: number } }
  | { type: 'mcp.server.disconnected'; payload: { name: string; reason: string } }
  | { type: 'mcp.server.error'; payload: { name: string; error: string } }
  | { type: 'mcp.operation_result'; payload: { success: boolean; message: string } }
  | {
      type: 'mcp.resources';
      payload: {
        name: string;
        resources: Array<{
          uri: string;
          name: string;
          description?: string;
          mimeType?: string;
          size?: number;
        }>;
        resourceTemplates: Array<{
          uriTemplate: string;
          name: string;
          description?: string;
          mimeType?: string;
        }>;
      };
    }
  | {
      type: 'mcp.prompts';
      payload: {
        name: string;
        prompts: Array<{
          name: string;
          description?: string;
          arguments?: Array<{ name: string; description?: string; required?: boolean }>;
        }>;
      };
    }
  | {
      type: 'mcp.content.selected';
      payload: {
        kind: 'resource' | 'prompt';
        untrusted: true;
        byteSize: number;
        provenance: {
          origin: 'mcp';
          serverName: string;
          capability: 'resource' | 'prompt';
          resourceUri?: string;
          promptName?: string;
          promptArgumentNames?: string[];
        };
        contents?: unknown[];
        messages?: unknown[];
        description?: string;
      };
    }
  | {
      type: 'mcp.content.error';
      payload: { action: string; name: string; error: string };
    }
  | { type: 'mailbox.cleared'; payload: { error?: string | undefined } }
  | { type: 'mailbox.purged'; payload: Record<string, unknown> & { error?: string | undefined } }
  // ── Chimera review reports — session-scoped, mailbox-independent list ─────
  | {
      type: 'chimera.reports';
      payload: {
        sessionId: string;
        reports: Array<{
          reportId: string;
          reviewedAt: string;
          lifecycleStatus: string;
          totalFindings: number;
          hasActionableFindings?: boolean | undefined;
        }>;
      };
    }
  // ── Cron plugin events — state snapshots and job lifecycle ──────────────────
  | {
      type: 'cron.snapshot';
      payload: {
        count: number;
        maxConcurrent: number;
        jobs: Array<{
          name: string;
          intervalMs: number;
          action: string;
          enabled: boolean;
          lastRun: string | null;
          nextRun: string;
          runCount: number;
          overdue: boolean;
        }>;
      };
    }
  | {
      type: 'cron.job_fired';
      payload: { name: string; action: string; runCount: number; ts: string };
    }
  // ── Integrated terminal (node-pty) server events ──────────────────────────────
  | { type: 'terminal.output'; payload: { id: string; data: string } }
  | {
      type: 'terminal.exit';
      payload: { id: string; exitCode: number; signal?: number | undefined };
    }
  | { type: 'prompts.journal'; payload: WSPromptsJournalPayload };

// Helper to broadcast to all clients
export type BroadcastFn = (msg: WSServerMessage) => void;

/** One entry from the hierarchical prompt journal (mirrors core `PromptJournalEntry`). */
export interface WSPromptJournalEntry {
  id: string;
  timestamp: string;
  sessionId: string;
  projectRoot: string;
  role: 'user' | 'system' | 'assistant' | 'tool';
  category: string;
  content: string;
  rawContent?: string | undefined;
  metadata: {
    model?: string | undefined;
    provider?: string | undefined;
    iterationIndex?: number | undefined;
    tokenEstimate: number;
    characterCount: number;
    lineCount: number;
    activeTools?: string[] | undefined;
    contextFiles?: string[] | undefined;
    durationMs?: number | undefined;
    decisionReason?: string | undefined;
    tags?: string[] | undefined;
  };
}

export interface WSPromptsJournalPayload {
  enabled: boolean;
  entries: WSPromptJournalEntry[];
  error?: string | undefined;
}

/** One selectable identity-prompt size, with its upper-bound token estimate. */
export interface WSSystemPromptVariantInfo {
  variant: 'lite' | 'default' | 'pro';
  label: string;
  hint: string;
  tokens: number;
}

/**
 * Payload of `system_prompt.info`.
 *
 * `chosen` is false until the user has explicitly picked a variant at least
 * once — the config loader materializes a default variant for every config, so
 * this flag is the only way the browser can tell a fresh install from a
 * deliberate "Standard" and decide whether to open the picker unprompted.
 */
export interface WSSystemPromptInfo {
  current: 'lite' | 'default' | 'pro';
  chosen: boolean;
  variants: WSSystemPromptVariantInfo[];
  error?: string | undefined;
}
