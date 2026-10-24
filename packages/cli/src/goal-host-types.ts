import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, TaskNode } from '@wrongstack/contracts/types';
import type { BrainArbiter } from '@wrongstack/core/coordination';
import type { PhaseGraph, PhaseOrchestrator, PhaseProgress } from '@wrongstack/goal';
import type { MultiAgentHost } from './multi-agent.js';

export interface GoalHostDeps {
  multiAgentHost: MultiAgentHost;
  /** Read the *current* Config lazily (it may be patched, e.g. YOLO toggles). */
  getConfig: () => Config;
  /** Shared app EventBus — orchestrator events feed the TUI PhaseMonitor. */
  events: EventBus;
  /** Current parent session id for worktree lifecycle events. */
  getSessionId?: (() => string | undefined) | undefined;
  /** Directory for per-project phase-graph engine checkpoints. */
  storeDir: string;
  /** Project root — base for git-worktree isolation. */
  projectRoot: string;
  /** SDD board snapshot dir — `/worktree clean` skips while an SDD run is live. */
  sddBoardsDir?: string | undefined;
  /**
   * Enable per-phase git-worktree isolation (default true). When on and the
   * project is a git repo, parallelizable phases run in isolated worktrees and
   * merge back sequentially. Disable with WRONGSTACK_GOAL_WORKTREES=0.
   */
  worktrees?: boolean | undefined;
  /** Max parallel phases when worktrees are active (default 4). */
  maxConcurrentPhases?: number | undefined;
  /** Optional global Brain arbiter for Goal policy decisions. */
  brain?: BrainArbiter | undefined;
  /** Optional progress logger (rendered to the user during start). */
  log?: ((line: string) => void) | undefined;
}

/** A live, read-only view of the running Goal, exposed to slash commands. */
interface GoalRunnerView {
  graph: PhaseGraph;
  getProgress: () => PhaseProgress | null;
  isRunning: () => boolean;
}

export type GoalStartResult = { ok: true; graph: PhaseGraph } | { ok: false; error: string };

export interface GoalHostHooks {
  onGoalStart: (opts: {
    goal: string;
    projectContext?: string | undefined;
  }) => Promise<GoalStartResult>;
  onGoalPause: () => void;
  onGoalResume: () => void;
  /**
   * Resume a persisted PhaseGraph. The graph must already have been loaded
   * from the PhaseStore. Creates a fresh orchestrator and starts executing
   * pending tasks.
   */
  onGoalResumeFromGraph: (graph: PhaseGraph) => Promise<GoalStartResult>;
  onGoalStop: () => void;
  getGoalRunner: () => GoalRunnerView | null;
  /** Interactive board: move a task to another phase. */
  onGoalMoveTask: (taskId: string, toPhaseId: string) => boolean;
  /** Interactive board: (re)assign a task to a specific agent (clear with both omitted). */
  onGoalAssignTask: (taskId: string, agentId?: string, agentName?: string) => boolean;
  /** Interactive board: add a new task to a phase. Returns the new task id. */
  onGoalAddTask: (
    phaseId: string,
    spec: {
      title: string;
      description?: string;
      type?: TaskNode['type'];
      priority?: TaskNode['priority'];
    },
  ) => string | null;
  /** Interactive board: requeue a task to pending so it (re)runs. */
  onGoalRetryTask: (taskId: string) => boolean;
  /** Backs the /worktree slash command (list / merge / prune / clean). */
  onWorktree: (action: 'list' | 'merge' | 'prune' | 'clean', target?: string) => Promise<string>;
}

export interface ActiveRun {
  graph: PhaseGraph;
  orchestrator: PhaseOrchestrator;
  abort: AbortController;
  unsubscribe: () => void;
  releaseRunLease: () => Promise<void>;
  runPromise?: Promise<void> | undefined;
}

/** Minimal shape of an agent.run result we depend on. */
export interface RunResult {
  status: string;
  finalText?: string | undefined;
  error?: { message?: string | undefined };
}
