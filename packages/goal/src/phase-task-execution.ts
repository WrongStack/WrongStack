import type { TaskNode } from '@wrongstack/contracts/types/task-graph';
import type { TaskTracker } from '@wrongstack/core/tasking';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { WorktreeHandle } from '@wrongstack/core/worktree';
import type { NormalizedGoalOptions } from './phase-orchestrator-types.js';
import type { PhaseEventMap, PhaseEventName, PhaseExecutionContext, PhaseNode } from './types.js';
export interface PhaseTaskExecutionHost {
  getExecutableTasks(phase: PhaseNode): TaskNode[];
  stopped: boolean;
  waitWhilePaused(): Promise<void>;
  opts: NormalizedGoalOptions;
  executeSingleTask(task: TaskNode, phase: PhaseNode): Promise<unknown>;
  markTaskCompleted(phase: PhaseNode, task: TaskNode): void;
  markTaskFailed(phase: PhaseNode, task: TaskNode, error: unknown): void;
  getTrackerForPhase(phase: PhaseNode): TaskTracker;
  ctx: PhaseExecutionContext;
  emit<K extends PhaseEventName>(event: K, payload: PhaseEventMap[K]): void;
  phaseWorktrees: Map<string, WorktreeHandle>;
  stopController: AbortController;
  taskRetryCounts: Map<string, number>;
}

export async function executePhaseTasks(
  host: PhaseTaskExecutionHost,
  phase: PhaseNode,
): Promise<void> {
  const pendingTasks = host.getExecutableTasks(phase);

  while (pendingTasks.length > 0 && !host.stopped) {
    await host.waitWhilePaused();
    if (host.stopped) break;
    const batch = pendingTasks.splice(0, host.opts.maxConcurrentTasks);

    const results = await Promise.allSettled(
      batch.map((task) => host.executeSingleTask(task, phase)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const task = batch[i];
      if (!result || !task) continue;

      if (result.status === 'fulfilled') {
        // Record real completions even when a stop landed mid-batch:
        // demoting a finished task back to pending (via markTaskFailed's
        // stopped branch) would re-execute it on the next run — duplicate
        // side effects on a task whose work already happened.
        host.markTaskCompleted(phase, task);
      } else {
        host.markTaskFailed(phase, task, result.reason);
      }
    }

    const newReady = host.getExecutableTasks(phase);
    pendingTasks.length = 0;
    pendingTasks.push(...newReady);
  }
}

export async function executeSingleTask(
  host: PhaseTaskExecutionHost,
  task: TaskNode,
  phase: PhaseNode,
): Promise<unknown> {
  const tracker = host.getTrackerForPhase(phase);
  tracker.updateNodeStatus(task.id, 'in_progress');
  host.ctx.onTaskUpdate?.(phase, task);
  // Signal the start so boards can move the card to "in progress" and show the
  // worker. `executeTask` may assign/refine the agent right after (taskAssigned).
  host.emit('phase.taskStarted', {
    phaseId: phase.id,
    taskId: task.id,
    taskTitle: task.title,
    agentName: task.assignee,
  });
  const handle = host.phaseWorktrees.get(phase.id);
  // Per-task abort source, fired by this task's own timeout below. Composed
  // with the run-wide stopController so either stop() or the timeout
  // actually cancels the execution — previously a timed-out task kept
  // running (and kept writing to the phase worktree) after its retry had
  // already been queued.
  const timeoutController = host.opts.taskTimeoutMs > 0 ? new AbortController() : undefined;
  const signal = timeoutController
    ? AbortSignal.any([host.stopController.signal, timeoutController.signal])
    : host.stopController.signal;
  const taskPromise = host.ctx.executeTask(
    task,
    phase.id,
    { cwd: handle?.dir, branch: handle?.branch },
    signal,
  );
  if (!timeoutController) return taskPromise;

  const timeoutMs = host.opts.taskTimeoutMs;
  const timedOut = Symbol('timed_out');
  const result = await Promise.race([
    taskPromise,
    new Promise<typeof timedOut>((resolve) => {
      const timer = setTimeout(() => {
        timeoutController.abort();
        resolve(timedOut);
      }, timeoutMs);
      // Let the timer be freed if the task finishes first.
      taskPromise.then(() => clearTimeout(timer)).catch(() => clearTimeout(timer));
    }),
  ]);
  if (result !== timedOut) return result;

  host.emit('phase.taskTimedOut', {
    phaseId: phase.id,
    taskId: task.id,
    taskTitle: task.title,
    timeoutMs,
  });
  // Wait (bounded) for the aborted execution to settle before throwing:
  // the throw requeues this task via markTaskFailed, and starting the retry
  // while the timed-out instance is still writing to the same worktree is
  // exactly the duplicate-concurrent-instance race. Signal-honoring
  // implementors settle in milliseconds; the bound keeps an implementor
  // that ignores the signal from hanging the phase forever.
  const settled = taskPromise.then(
    () => undefined,
    () => undefined,
  );
  // Clear the grace timer when the task settles first, and unref it so a
  // pending timer cannot hold the event loop open during shutdown.
  const grace = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    timer.unref?.();
    void settled.then(() => clearTimeout(timer));
  });
  await Promise.race([settled, grace]);
  throw new Error(`Task "${task.title}" (${task.id}) exceeded timeout of ${timeoutMs} ms`);
}

export function markTaskCompleted(
  host: PhaseTaskExecutionHost,
  phase: PhaseNode,
  task: TaskNode,
): void {
  const tracker = host.getTrackerForPhase(phase);
  tracker.updateNodeStatus(task.id, 'completed');
  host.ctx.onTaskUpdate?.(phase, task);
  host.emit('phase.taskCompleted', {
    phaseId: phase.id,
    taskId: task.id,
    taskTitle: task.title,
  });
}

export function markTaskFailed(
  host: PhaseTaskExecutionHost,
  phase: PhaseNode,
  task: TaskNode,
  error: unknown,
): void {
  const tracker = host.getTrackerForPhase(phase);
  const taskKey = `${phase.id}:${task.id}`;
  const currentRetries = host.taskRetryCounts.get(taskKey) ?? 0;

  if (host.stopped) {
    // A stop()-initiated abort is a user action, not a task failure: leave
    // the node resumable-pending without burning a retry attempt.
    tracker.updateNodeStatus(task.id, 'pending', 'Stopped before completion');
    host.ctx.onTaskUpdate?.(phase, task);
    return;
  }

  if (currentRetries < host.opts.maxRetries) {
    host.taskRetryCounts.set(taskKey, currentRetries + 1);
    tracker.updateNodeStatus(
      task.id,
      'pending',
      `Retry ${currentRetries + 1}/${host.opts.maxRetries}`,
    );
    host.ctx.onTaskUpdate?.(phase, task);
    host.emit('phase.taskRetrying', {
      phaseId: phase.id,
      taskId: task.id,
      taskTitle: task.title,
      attempt: currentRetries + 1,
      maxRetries: host.opts.maxRetries,
    });
  } else {
    tracker.updateNodeStatus(task.id, 'failed', toErrorMessage(error));
    host.ctx.onTaskUpdate?.(phase, task);
    host.emit('phase.taskFailed', {
      phaseId: phase.id,
      taskId: task.id,
      taskTitle: task.title,
      error: toErrorMessage(error),
    });
  }
}
