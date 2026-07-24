export interface SddEventMap {
  // ── SDD live board ──────────────────────────────────────────────────────
  // Emitted by SddParallelRun so the board projector + every surface stream a
  // live, dependency-aware multi-agent run. `runId` correlates all events of
  // one run; the projector composes them into `sdd.board.snapshot`.
  /** A parallel SDD run started. */
  'sdd.run.started': {
    sessionId?: string | undefined;
    runId: string;
    graphId: string;
    specId?: string | undefined;
    total: number;
    /** Base branch the run's squash commits will land on (worktree runs only). */
    baseBranch?: string | undefined;
  };
  /** A parallel SDD run reached a terminal state. */
  'sdd.run.finished': {
    sessionId?: string | undefined;
    runId: string;
    deadlocked: boolean;
    completed: number;
    failed: number;
    stopped: boolean;
  };
  /** A task began executing on a worker (carries who + which worktree). */
  'sdd.task.started': {
    sessionId?: string | undefined;
    runId: string;
    taskId: string;
    subagentId: string;
    agentName: string;
    worktreeBranch?: string | undefined;
  };
  /** A task finished successfully. */
  'sdd.task.completed': {
    sessionId?: string | undefined;
    runId: string;
    taskId: string;
    subagentId: string;
    durationMs: number;
  };
  /** A task failed terminally (retries exhausted). */
  'sdd.task.failed': {
    sessionId?: string | undefined;
    runId: string;
    taskId: string;
    subagentId: string;
    error: string;
  };
  /** A failed task was requeued for another attempt. */
  'sdd.task.retrying': {
    sessionId?: string | undefined;
    runId: string;
    taskId: string;
    attempt: number;
    maxRetries: number;
  };
  /** A task's worker reported success but the post-task verification gate rejected it. */
  'sdd.task.verification_failed': {
    sessionId?: string | undefined;
    runId: string;
    taskId: string;
    reason: string;
  };
  /** A completed task's worktree could not be merged back into the base branch. */
  'sdd.task.conflict': {
    sessionId?: string | undefined;
    runId: string;
    taskId: string;
    conflictFiles: string[];
  };
  /** A completed task's worktree was squash-merged onto the base branch (sha = the run commit). */
  'sdd.task.merged': { sessionId?: string | undefined; runId: string; taskId: string; sha: string };
  /** A task was split into sub-tasks (the parent becomes a completed container). */
  'sdd.task.split': {
    sessionId?: string | undefined;
    runId: string;
    taskId: string;
    subtaskIds: string[];
  };
  /** The supervisor made a decision about a failing/stuck task. */
  'sdd.supervisor.decision': {
    sessionId?: string | undefined;
    runId: string;
    taskId: string;
    action: 'retry' | 'reassign' | 'split' | 'fail';
    rationale?: string | undefined;
  };
  /** A new wave of dependency-ready tasks began. */
  'sdd.wave': { sessionId?: string | undefined; runId: string; wave: number; batchSize: number };
  /** No runnable tasks remain but some are still blocked — with the blocking chains. */
  'sdd.deadlock': {
    sessionId?: string | undefined;
    runId: string;
    chains: Array<{ blocked: string; blockedBy: string[] }>;
  };
  /**
   * Throttled full board snapshot composed by SddBoardProjector. `snapshot` is
   * an `SddBoardSnapshot` (sdd/board-types) — typed `unknown` here so the kernel
   * layer never imports from the higher `sdd/` layer (it sits below it in the
   * DAG); consumers cast it back. The producer (SddBoardProjector) is typed.
   */
  'sdd.board.snapshot': { sessionId?: string | undefined; runId: string; snapshot: unknown };
  /** A task was scored by the deterministic atomicity rule set. */
  'sdd.task.atomicity_assessed': {
    sessionId?: string | undefined;
    runId?: string | undefined;
    graphId: string;
    taskId: string;
    verdict: 'atomic' | 'borderline' | 'needs_decomposition' | 'composite';
    score: number;
    reasons: string[];
  };
  /** A task was proactively decomposed (planning pass) or an approved proposal applied. */
  'sdd.task.decomposed': {
    sessionId?: string | undefined;
    runId?: string | undefined;
    graphId: string;
    taskId: string;
    subtaskIds: string[];
    mode: 'auto' | 'approved';
    phase: 'planning' | 'reactive';
  };
  /** The planning decomposer produced sub-tasks awaiting approval (propose mode). */
  'sdd.decomposition.proposed': {
    sessionId?: string | undefined;
    graphId: string;
    taskId: string;
    subtasks: Array<{ title: string; description: string; successCriterion?: string | undefined }>;
    reasons: string[];
  };
}
