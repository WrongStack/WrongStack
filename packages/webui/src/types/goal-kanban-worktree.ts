import type {
  KanbanBoard,
  KanbanBoardPresence,
  KanbanBoardSummary,
  KanbanEvent,
  KanbanTask,
} from '@wrongstack/kanban';
import type { SessionScopedPayload } from './protocol-core.js';

export interface WSModesList {
  type: 'modes.list';
  payload: {
    modes: Array<{
      id: string;
      name: string;
      description: string;
      isActive: boolean;
    }>;
    activeId: string;
  };
}

/** Goal live state broadcast (see server/goal-ws-handler.ts). */
export interface WSGoalState {
  type: 'goal.state';
  payload: Record<string, unknown>;
}

export interface WSGoalProgress {
  type: 'goal.progress';
  payload: Record<string, unknown>;
}

export interface WSGoalLifecycle {
  type:
    | 'goal.paused'
    | 'goal.resumed'
    | 'goal.stopped'
    | 'goal.saved'
    | 'goal.completed'
    | 'goal.failed'
    | 'goal.error'
    | 'goal.cleared'
    | 'goal.reverted';
  payload: Record<string, unknown>;
}

export interface WSGoalList {
  type: 'goal.list';
  payload: { graphs: unknown[] };
}

/** Goal realism assessment result (see server/goal-ws-handler.ts). */
export interface WSGoalAssessResult {
  type: 'goal.assess.result';
  payload: {
    realistic: boolean;
    durationClaimed: string | null;
    explanation: string;
    recommendedDuration: string | null;
    concerns: string[];
    parseFailed: boolean;
    parseError?: string | undefined;
    /** Raw LLM output (server-internal; not consumed by UI). */
    raw?: string | undefined;
    /** Echo of the client's request seq for stale-response detection. */
    reqSeq?: number | undefined;
  };
}

export interface WSEternalIteration {
  type: 'eternal.iteration';
  payload: { entry: Record<string, unknown> };
}

export interface WSAgentTimelineMessage {
  type: 'agent.timeline.message';
  payload: SessionScopedPayload & {
    subagentId: string;
    agentName: string;
    content: string;
    kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'status' | 'system';
    iteration: number;
    ts: string;
    toolName?: string | undefined;
    toolOk?: boolean | undefined;
    costUsd?: number | undefined;
  };
}

export interface WSAgentStatusChanged {
  type: 'agent.status_changed';
  payload: SessionScopedPayload & {
    subagentId: string;
    agentName: string;
    status:
      | 'spawned'
      | 'running'
      | 'completed'
      | 'failed'
      | 'timeout'
      | 'stopped'
      | 'budget_exhausted';
    ts: string;
    summary?: string | undefined;
    task?: string | undefined;
  };
}

export interface WSKanbanResult {
  type: `kanban.${string}`;
  payload: {
    success: boolean;
    data?:
      | KanbanBoard
      | KanbanBoardSummary[]
      | KanbanTask
      | KanbanTask[]
      | KanbanEvent[]
      | Record<string, unknown>
      | null;
    error?: string | undefined;
  };
}

export interface WSKanbanTaskActivity {
  type: 'kanban.task.activity';
  payload: {
    success: boolean;
    data?:
      | {
          boardId: string;
          taskId: string;
          events: KanbanEvent[];
          presence?: KanbanBoardPresence[] | undefined;
        }
      | undefined;
    error?: string | undefined;
  };
}

/** One worktree lane in the swim-lane / DAG view. */
export interface WorktreeHandleView {
  handleId: string;
  ownerId: string;
  ownerLabel: string;
  /** Absolute checkout path (for open-in-terminal / remove). */
  dir?: string | undefined;
  branch: string;
  baseBranch: string;
  status: 'allocating' | 'active' | 'committing' | 'merging' | 'merged' | 'needs-review' | 'failed';
  insertions: number;
  deletions: number;
  files: number;
  conflictFiles?: string[] | undefined;
  allocatedAt: number;
  lastEventAt: number;
  recentActivity: Array<{ kind: string; text: string; at: number }>;
}

/** Full worktree snapshot (broadcast on a timer, see worktree-ws-handler.ts). */
export interface WSWorktreeState {
  type: 'worktree.state';
  payload: { worktrees: WorktreeHandleView[]; baseBranch: string };
}

/** Incremental worktree lifecycle event — drives the flowing activity strip. */
export interface WSWorktreeEvent {
  type: 'worktree.event';
  payload: { kind: string; handleId: string; text: string; at: number };
}

/** One orphaned git artifact left by a previous/crashed run. */
export interface WorktreeOrphanView {
  /** Absolute checkout path (omitted for a branch-only orphan). */
  dir?: string | undefined;
  /** Branch name (`wstack/ap/*`), when known. */
  branch?: string | undefined;
  kind: 'worktree' | 'branch';
}

/** Disk-scanned orphan inventory + whether it is safe to clean right now. */
export interface WSWorktreeOrphans {
  type: 'worktree.orphans';
  payload: {
    orphans: WorktreeOrphanView[];
    /** False while a run is live (in this session or another process). */
    canClean: boolean;
    /** Why cleaning is blocked, when canClean is false. */
    reason?: string | undefined;
  };
}

/** Outcome of a worktree-panel orphan cleanup (bulk or single remove). */
export interface WSWorktreeCleanupResult {
  type: 'worktree.cleanup_result';
  payload: { ok: boolean; removed: number; reason?: string | undefined };
}

/** Compact per-worktree change summary. */
export interface WorktreeDiffSummary {
  files: Array<{ path: string; insertions: number; deletions: number }>;
  insertions: number;
  deletions: number;
  commits: number;
}

/** Outcome of a per-worktree squash-merge into base. */
export interface WSWorktreeMergeResult {
  type: 'worktree.merge_result';
  payload: {
    ok: boolean;
    branch: string;
    conflict?: boolean | undefined;
    conflictFiles?: string[] | undefined;
    reason?: string | undefined;
  };
}

/** Result of a per-worktree "View changes" request. */
export interface WSWorktreeDiffResult {
  type: 'worktree.diff_result';
  payload: { dir: string; summary: WorktreeDiffSummary | null };
}

/** One Brain pool/judge model entry on the wire ("provider/model" grammar when a string). */
