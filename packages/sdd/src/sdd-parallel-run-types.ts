import type { Agent } from '@wrongstack/core/agent';
import type { AgentFactory } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { TaskTracker } from '@wrongstack/core/tasking';
import type { TaskGraph, TaskNode, TaskProgress, TaskResult } from '@wrongstack/core/types';
import type { WorktreeManager } from '@wrongstack/core/worktree';
import type { TaskBatch } from './sdd-task-decomposer.js';
/** A sub-task produced by splitting a parent task (see `splitTask`). */
export interface SddSubtaskSpec {
  title: string;
  description: string;
  type?: TaskNode['type'] | undefined;
  priority?: TaskNode['priority'] | undefined;
  /**
   * One verifiable success criterion for this sub-task (planning decomposer).
   * A runnable-command marker (`$ cmd`, `run:`/`verify:`/`cmd:`) becomes the
   * leaf's `metadata.verificationCommand`; free text is appended to the
   * description as an explicit acceptance criterion.
   */
  successCriterion?: string | undefined;
}

/**
 * Verdict returned by the optional failure supervisor when a task is about to go
 * terminal. `retry` re-queues with a fresh attempt budget; `reassign` swaps the
 * worker model (+ optional provider) then re-queues; `split` breaks the task
 * into sub-tasks; `fail` (or `undefined`) lets it terminal-fail.
 */
export type SddSupervisorVerdict =
  | { action: 'retry' }
  | { action: 'reassign'; model?: string | undefined; provider?: string | undefined }
  | { action: 'split'; subtasks: SddSubtaskSpec[] }
  | { action: 'fail' };

export interface SddParallelRunOptions {
  /** Pre-constructed TaskTracker (must already hold the graph's initial state). */
  tracker: TaskTracker;
  /** The TaskGraph produced by TaskGenerator from an approved spec. */
  graph: TaskGraph;
  /** The main agent — used as the subagent factory. */
  agent: Agent;
  /** Project root (used for coordinator id). */
  projectRoot: string;
  /**
   * Override default parallel slots (1–16). Default: 2 — deliberately low so a
   * run never juggles more git worktrees than a human can review. Independent
   * tasks still run concurrently up to this cap; dependency chains run in order.
   */
  parallelSlots?: number | undefined;
  /**
   * Hard wall-clock cap per task in ms. OPT-IN — `undefined` by default so a
   * long-but-productive task is never killed merely for running long (the old
   * 5-min default hard-killed real coding tasks with `budget_timeout`). When
   * set, the coordinator watchdog enforces it. Prefer `taskIdleTimeoutMs`.
   */
  taskTimeoutMs?: number | undefined;
  /**
   * Idle reaper per task in ms: reap a task only after this long with NO
   * activity (iteration / tool call / streamed token / tool progress). Resets
   * on every sign of forward motion, so an actively-working agent runs until
   * its task naturally ends. Default: 600_000 (10 min of silence = genuinely
   * stuck). This is the default guard — wall-clock (`taskTimeoutMs`) is opt-in.
   */
  taskIdleTimeoutMs?: number | undefined;
  /** Maximum in-run retry attempts for a failed task before it goes terminal. Default: 3. */
  maxRetries?: number | undefined;
  /**
   * After the graph settles with terminal-failed tasks, requeue ALL failed
   * (non-cancelled) tasks to `pending` and run them again — up to this many
   * sweeps. Each sweep gives every failed task a fresh `maxRetries` budget. The
   * loop stops early once a sweep produces no new completions (no progress).
   * 0 = off. Default: 2.
   */
  maxFailedRetrySweeps?: number | undefined;
  /** Override the default agent factory. */
  subagentFactory?: AgentFactory | undefined;
  /**
   * Run-level default model for worker subagents. A task's own
   * `metadata.model` (set per-task in the WebUI) takes precedence; this is the
   * fallback for every task that has no explicit assignment. Undefined → the
   * factory's own default (the leader's model).
   */
  defaultModel?: string | undefined;
  /** Run-level default provider id (same precedence rules as defaultModel). */
  defaultProvider?: string | undefined;
  /**
   * Run-level fallback model chain (entries: `model` / `provider/model`). A
   * task's `metadata.fallbackModels` overrides this. The subagent factory wires
   * these into a fallback extension so a 429/stream-hang rotates to the next.
   */
  fallbackModels?: string[] | undefined;
  /**
   * Post-task verification gate. When set, a task whose worker reported success
   * is NOT marked `completed` (and NOT merged) until this resolves `{ok:true}`.
   * Runs in the task's worktree cwd (or the project root when no worktree). Core
   * stays shell-agnostic — the caller injects a verifier that, e.g., runs the
   * task's `metadata.verificationCommand` (tests / typecheck). A task with no
   * command should return `{ok:true}`. An `{ok:false}` routes the task into the
   * normal failure path (retry while attempts remain, else terminal-fail).
   */
  verifyTask?:
    | ((info: {
        task: TaskNode;
        result: TaskResult;
        cwd: string;
      }) => Promise<{ ok: boolean; reason?: string }>)
    | undefined;
  /**
   * Optional merge-conflict resolver, forwarded to `WorktreeManager.merge`. Given
   * the conflicted files + the base checkout cwd, return `true` once resolved (no
   * markers left). When omitted or it returns `false`, the task is requeued (a
   * re-run forks a fresh worktree off the advanced base) and, if retries are
   * exhausted, terminally failed with its worktree kept for review.
   */
  conflictResolver?:
    | ((info: { task: TaskNode; conflictFiles: string[]; cwd: string }) => Promise<boolean>)
    | undefined;
  /**
   * Failure supervisor: consulted ONLY when a task has exhausted its retries and
   * is about to go terminal-failed. Returning a verdict lets a decision agent
   * keep the run moving — `retry` / `reassign` (swap model) / `split` — instead
   * of dead-ending. Returning `{action:'fail'}` / `undefined` lets it fail. Each
   * task can be rescued at most `maxSupervisorEscalations` times (loop guard).
   */
  superviseFailure?:
    | ((info: {
        task: TaskNode;
        error: string;
        attempts: number;
      }) => Promise<SddSupervisorVerdict | undefined>)
    | undefined;
  /** Max times the supervisor may rescue a single task before it must fail. Default 2. */
  maxSupervisorEscalations?: number | undefined;
  /** Called after each wave completes. */
  onWave?: ((wave: WaveResult) => void) | undefined;
  /** Called with progress stats every ~2s during execution. */
  onProgress?: ((progress: SddProgress) => void) | undefined;
  /** Shared EventBus — when set, the run emits `sdd.*` live-board events. */
  events?: EventBus | undefined;
  /** Parent session id for every emitted `sdd.*` event. */
  sessionId?: string | (() => string | undefined) | undefined;
  /** Stable id correlating all events of this run (default: random). */
  runId?: string | undefined;
  /**
   * Optional git-worktree manager. When set (and the project is a git repo),
   * each task runs in its own isolated worktree and merges back into the base
   * branch after success — so parallel agents never collide on the same files.
   */
  worktrees?: WorktreeManager | undefined;
  /** Run-level backstops (prevent an autonomous run from looping forever). */
  maxTotalWaves?: number | undefined;
  maxWallClockMs?: number | undefined;
  /**
   * Deadlock auto-recovery rounds: when the graph deadlocks on failed blockers,
   * requeue those failed blockers `pending` and try again, up to N times. 0 = off.
   */
  maxRecoveryRounds?: number | undefined;
}

export interface SddProgress {
  wave: number;
  total: number;
  completed: number;
  inProgress: number;
  failed: number;
  blocked: number;
  pending: number;
  percent: number;
  deadlocked: boolean;
}

export interface WaveResult {
  wave: number;
  batch: TaskBatch;
  results: TaskResult[];
  successCount: number;
  failCount: number;
  durationMs: number;
  stopRequested: boolean;
}

/** Result of a single task's execution in the continuous scheduler. */
export interface TaskOutcome {
  taskId: string;
  success: boolean;
  result?: TaskResult | undefined;
}

export interface RunResult {
  totalWaves: number;
  totalCompleted: number;
  totalFailed: number;
  totalDurationMs: number;
  deadlocked: boolean;
  stopRequested: boolean;
  finalProgress: TaskProgress;
}
