// startSddRun — the shared run-setup core for a multi-agent SDD parallel run.
//
// Extracted from the CLI `/sdd execute` handler so every surface (CLI slash
// command + both WebUI servers) starts a run identically: orphan reset →
// SddParallelRun → live board projector → run registry → cross-process control
// drain → run, with deterministic cleanup. The only thing that differs per
// surface is the `subagentFactory` (CLI's director-backed factory vs the
// runtime light factory) and whether git worktrees are available — both are
// passed in, keeping this helper free of CLI/host coupling.

import type { Agent } from '../core/agent.js';
import type { AgentFactory } from '../coordination/agent-subagent-runner.js';
import type { EventBus } from '../kernel/events.js';
import type { TaskGraph } from '../types/task-graph.js';
import type { TaskTracker } from './task-tracker.js';
import type { WorktreeManager } from '../worktree/worktree-manager.js';
import { SddBoardProjector } from './sdd-board-projector.js';
import type { SddBoardStore } from './sdd-board-store.js';
import type { SddRunRegistry } from './sdd-run-registry.js';
import {
  SddParallelRun,
  type RunResult,
  type SddProgress,
  type SddParallelRunOptions,
} from './sdd-parallel-run.js';

export interface StartSddRunOptions {
  tracker: TaskTracker;
  graph: TaskGraph;
  /** Leader agent — seeds the default factory and the run's project context. */
  agent: Agent;
  projectRoot: string;
  events: EventBus;
  /** Parent session id for all SDD EventBus emissions. */
  sessionId?: string | (() => string | undefined) | undefined;
  /** Per-task agent factory. Omit to run every task on the leader agent. */
  subagentFactory?: AgentFactory | undefined;
  /** Board snapshot/event persistence (also drained for cross-process control). */
  boardStore: SddBoardStore;
  /** Registry the run is registered with for in-process control. */
  registry?: SddRunRegistry | undefined;
  parallelSlots?: number | undefined;
  /** Opt-in hard wall-clock cap per task (ms). Omit → no cap (idle reaper guards). */
  taskTimeoutMs?: number | undefined;
  /** Idle reaper per task (ms); resets on activity. Default 600_000 (10 min). */
  taskIdleTimeoutMs?: number | undefined;
  /** End-of-run failed-task auto-retry sweeps (bounded). Default 2. */
  maxFailedRetrySweeps?: number | undefined;
  /** Post-task verification gate (forwarded to SddParallelRun). Omit → no gate. */
  verifyTask?: SddParallelRunOptions['verifyTask'];
  /** Merge-conflict resolver (forwarded to SddParallelRun). Omit → retry-on-fresh-base then fail. */
  conflictResolver?: SddParallelRunOptions['conflictResolver'];
  /** Failure supervisor (forwarded to SddParallelRun). Omit → no rescue, plain terminal-fail. */
  superviseFailure?: SddParallelRunOptions['superviseFailure'];
  /** Run-level default worker model / provider / fallback chain (task overrides win). */
  defaultModel?: string | undefined;
  defaultProvider?: string | undefined;
  fallbackModels?: string[] | undefined;
  /** Per-task git worktree isolation. Omit → tasks share the working tree. */
  worktrees?: WorktreeManager | undefined;
  /** Bounded deadlock recovery rounds (default 1). */
  maxRecoveryRounds?: number | undefined;
  /** Progress callback (e.g. CLI renderer line). */
  onProgress?: ((p: SddProgress) => void) | undefined;
  /** Control-file drain interval in ms (default 500). */
  controlDrainMs?: number | undefined;
}

export interface SddRunHandle {
  run: SddParallelRun;
  runId: string;
  projector: SddBoardProjector;
  /** Resolves when the run finishes AND all teardown (drain/dispose/clear) is done. */
  completion: Promise<RunResult>;
  /** Request a clean stop (idempotent). */
  stop(): void;
}

/**
 * Wire up and start an SDD parallel run. Returns immediately with a handle whose
 * `completion` promise resolves once the run finishes and teardown is complete.
 * Orphaned in_progress tasks are reset up-front so a crashed prior run re-executes.
 */
export function startSddRun(opts: StartSddRunOptions): SddRunHandle {
  // Resume safety: orphaned in_progress tasks (from a prior crash, no agent
  // running them) are reset to pending so the run re-executes them.
  SddParallelRun.resetOrphans(opts.tracker);

  const run = new SddParallelRun({
    tracker: opts.tracker,
    graph: opts.graph,
    agent: opts.agent,
    projectRoot: opts.projectRoot,
    sessionId: opts.sessionId,
    parallelSlots: opts.parallelSlots,
    taskTimeoutMs: opts.taskTimeoutMs,
    taskIdleTimeoutMs: opts.taskIdleTimeoutMs,
    maxFailedRetrySweeps: opts.maxFailedRetrySweeps,
    verifyTask: opts.verifyTask,
    conflictResolver: opts.conflictResolver,
    superviseFailure: opts.superviseFailure,
    subagentFactory: opts.subagentFactory,
    events: opts.events,
    worktrees: opts.worktrees,
    maxRecoveryRounds: opts.maxRecoveryRounds ?? 1,
    onProgress: opts.onProgress,
    defaultModel: opts.defaultModel,
    defaultProvider: opts.defaultProvider,
    fallbackModels: opts.fallbackModels,
  });

  // Live board projector: streams sdd.board.snapshot + persists JSON/JSONL.
  const projector = new SddBoardProjector({
    runId: run.runId,
    graph: opts.graph,
    tracker: opts.tracker,
    events: opts.events,
    store: opts.boardStore,
    sessionId: opts.sessionId,
    specId: opts.graph.specId,
    defaultModel: opts.defaultModel,
    defaultProvider: opts.defaultProvider,
    fallbackModels: opts.fallbackModels,
  });

  opts.registry?.register({
    runId: run.runId,
    specId: opts.graph.specId,
    pause: () => run.pause(),
    resume: () => run.resume(),
    stop: () => run.stop(),
    retryTask: (id) => run.retryTask(id),
    retryAllFailed: () => run.retryAllFailed(),
    reassignTask: (id, name) => run.reassignTask(id, name),
    setTaskModel: (id, model, provider) => run.setTaskModel(id, model, provider),
    setTaskFallbacks: (id, fb) => run.setTaskFallbacks(id, fb),
    setTaskVerification: (id, cmd) => run.setTaskVerification(id, cmd),
    cancelTask: (id) => run.cancelTask(id),
    deleteTask: (id) => run.deleteTask(id),
    splitTask: (id, subtasks) => run.splitTask(id, subtasks),
    cleanupWorktrees: () => run.cleanupWorktrees(),
    rollback: () => run.rollback(),
    getBaseBranch: () => run.getBaseBranch(),
    getMergedCommits: () => run.getMergedCommits(),
    snapshot: () => projector.snapshot(),
    isRunning: () => run.isRunning(),
  });

  // Cross-process control channel: any board surface (e.g. the standalone WebUI
  // in another process) appends a command to <runId>.control.jsonl; we drain +
  // apply it here so this run stays the single driver.
  const drainMs = opts.controlDrainMs ?? 500;
  const controlTimer = setInterval(() => {
    void opts.boardStore.drainControl(run.runId).then((cmds) => {
      for (const c of cmds) {
        const p = (c.payload ?? {}) as {
          taskId?: string;
          agentName?: string;
          model?: string;
          provider?: string;
          fallbackModels?: string[];
          verificationCommand?: string;
          subtasks?: import('./sdd-parallel-run.js').SddSubtaskSpec[];
        };
        if (c.type === 'pause') run.pause();
        else if (c.type === 'resume') run.resume();
        else if (c.type === 'stop') run.stop();
        else if (c.type === 'retry' && p.taskId) run.retryTask(p.taskId);
        else if (c.type === 'retry_all_failed') run.retryAllFailed();
        else if (c.type === 'reassign' && p.taskId) run.reassignTask(p.taskId, p.agentName ?? '');
        else if (c.type === 'set_task_model' && p.taskId) run.setTaskModel(p.taskId, p.model, p.provider);
        else if (c.type === 'set_task_fallbacks' && p.taskId) run.setTaskFallbacks(p.taskId, p.fallbackModels);
        else if (c.type === 'set_task_verification' && p.taskId)
          run.setTaskVerification(p.taskId, p.verificationCommand);
        else if (c.type === 'cancel_task' && p.taskId) void run.cancelTask(p.taskId).catch(() => {});
        else if (c.type === 'delete_task' && p.taskId) run.deleteTask(p.taskId);
        else if (c.type === 'split_task' && p.taskId && p.subtasks?.length) run.splitTask(p.taskId, p.subtasks);
        // Lifecycle: stop the run first, then sweep worktrees / revert commits.
        // (Both are no-ops while the run is still live — the user pairs them with
        // a prior `stop`.)
        else if (c.type === 'cleanup_worktrees') void run.cleanupWorktrees().catch(() => {});
        else if (c.type === 'rollback') void run.rollback().catch(() => {});
      }
    }).catch(() => {});
  }, drainMs);
  // Best-effort: don't keep the event loop alive solely for the drain timer.
  (controlTimer as { unref?: () => void }).unref?.();

  const completion = (async (): Promise<RunResult> => {
    try {
      return await run.run();
    } finally {
      clearInterval(controlTimer);
      await projector.drain().catch(() => {});
      projector.dispose();
      opts.registry?.clear(run.runId);
    }
  })();

  return {
    run,
    runId: run.runId,
    projector,
    completion,
    stop: () => run.stop(),
  };
}
