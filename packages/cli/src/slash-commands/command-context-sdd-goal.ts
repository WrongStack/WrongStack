/** SDD run and goal-runner hooks. */
export interface SlashSddGoalCommandContext {
  /**
   * Start an SDD parallel fan-out run. Requires an active SDD session with
   * an approved spec and generated task graph.
   */
  onSddParallelRun?: (opts?: { parallelSlots?: number | undefined }) => Promise<string>;
  /** Stop the currently running SDD parallel fan-out. */
  onSddParallelStop?: (() => void) | undefined;
  /** Requeue every failed task in the active SDD run to pending. Returns the count requeued. */
  onSddRetryAllFailed?: (() => number) | undefined;
  /**
   * Split a task in the active SDD run into sub-tasks (refused while it runs).
   * Returns the new leaf ids, or null when there is no active run / unknown task.
   */
  onSddSplitTask?:
    | ((taskId: string, subtasks: Array<{ title: string; description: string }>) => string[] | null)
    | undefined;
  /**
   * Remove the git worktrees + branches an SDD run created. Uses the live run
   * when one is active (after a stop), else sweeps the project's leftovers from
   * disk. Returns the number of worktrees removed.
   */
  onSddCleanWorktrees?: (() => Promise<number>) | undefined;
  /**
   * Roll back an SDD run's merged commits by reverting each on the base branch
   * (history-preserving). Refuses while a run is still live. Returns the outcome.
   */
  onSddRollback?: (() => Promise<{ ok: boolean; reverted: number; reason?: string }>) | undefined;
  /**
   * Destroy the SDD project: stop any active run, clean worktrees, and delete the
   * on-disk artifacts (specs, task-graphs, session, boards). Pass
   * `{ revertMerged: true }` (`/sdd destroy --revert`) to also revert merged
   * commits before wiping; otherwise they are left on the base branch.
   */
  onSddDestroy?:
    | ((opts?: { revertMerged?: boolean }) => Promise<{
        worktreesRemoved: number;
        deleted: string[];
        reverted: number;
        revertOk?: boolean | undefined;
        revertReason?: string | undefined;
      }>)
    | undefined;
  /**
   * Start a real, LLM-driven Goal run from a free-text goal. The host
   * plans phases (each holding many todos), persists the phase-graph as
   * per-project JSON, and drives the orchestrator — one subagent per task —
   * in the background. Returns the built graph or an error.
   */
  onGoalStart?: (opts: {
    goal: string;
    projectContext?: string | undefined;
  }) => Promise<
    { ok: true; graph: import('@wrongstack/goal').PhaseGraph } | { ok: false; error: string }
  >;
  onGoalPause?: (() => void) | undefined;
  onGoalResume?: (() => void) | undefined;
  onGoalStop?: (() => void) | undefined;
  /**
   * Resume a persisted PhaseGraph. The host creates a new orchestrator for
   * the loaded graph and starts executing pending tasks.
   */
  onGoalResumeFromGraph?:
    | ((
        graph: import('@wrongstack/goal').PhaseGraph,
      ) => Promise<
        { ok: true; graph: import('@wrongstack/goal').PhaseGraph } | { ok: false; error: string }
      >)
    | undefined;
  /** Live, read-only view of the running Goal (null when idle). */
  getGoalRunner?: () => {
    graph: import('@wrongstack/goal').PhaseGraph;
    getProgress: () => import('@wrongstack/goal').PhaseProgress | null;
    isRunning: () => boolean;
  } | null;
  /** Interactive board: move a task to another phase (returns false when idle/invalid). */
  onGoalMoveTask?: ((taskId: string, toPhaseId: string) => boolean) | undefined;
  /** Interactive board: (re)assign a task to an agent (clear with both omitted). */
  onGoalAssignTask?:
    | ((taskId: string, agentId?: string, agentName?: string) => boolean)
    | undefined;
  /** Interactive board: add a new task to a phase, returning its id (or null when idle). */
  onGoalAddTask?:
    | ((
        phaseId: string,
        spec: {
          title: string;
          description?: string;
          type?: import('@wrongstack/contracts/types').TaskNode['type'];
          priority?: import('@wrongstack/contracts/types').TaskNode['priority'];
        },
      ) => string | null)
    | undefined;
  /** Interactive board: requeue a task to pending so it (re)runs. */
  onGoalRetryTask?: ((taskId: string) => boolean) | undefined;
}
