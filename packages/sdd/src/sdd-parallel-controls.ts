import type { DefaultMultiAgentCoordinator } from '@wrongstack/core/coordination';
import type { WorktreeHandle } from '@wrongstack/core/worktree';
import { splitGraphNode } from './graph-split.js';
import type { SddParallelRunOptions, SddSubtaskSpec } from './sdd-parallel-run-types.js';
export interface SddParallelControlsHost {
  isRunning(): boolean;
  opts: SddParallelRunOptions;
  taskWorktrees: Map<string, WorktreeHandle>;
  forgetWorktree(taskId: string, opts?: { keepBranchLabel?: boolean }): void;
  baseBranch: string | undefined;
  mergedCommits: Array<{ taskId: string; sha: string; title: string }>;
  retryMap: Map<string, number>;
  persistRetries(taskId: string, retries: number): void;
  cancelledTasks: Set<string>;
  emit<K extends keyof import('@wrongstack/contracts/kernel').EventMap>(
    event: K,
    payload: import('@wrongstack/contracts/kernel').EventMap[K],
  ): void;
  runId: string;
  taskSubagents: Map<string, string>;
  coordinator: DefaultMultiAgentCoordinator | null;
}

export async function cleanupWorktrees(host: SddParallelControlsHost): Promise<number> {
  if (host.isRunning()) return 0;
  const wt = host.opts.worktrees;
  if (!wt) return 0;
  // Release any handles this run still holds (kept on stop / needs-review).
  for (const [taskId, handle] of [...host.taskWorktrees]) {
    await wt.release(handle, { keep: false }).catch(() => {});
    host.forgetWorktree(taskId);
  }
  const { removed } = await wt.cleanupAllManaged();
  return removed;
}

export async function rollback(
  host: SddParallelControlsHost,
): Promise<{ ok: boolean; reverted: number; reason?: string }> {
  if (host.isRunning())
    return { ok: false, reverted: 0, reason: 'run still active — stop it first' };
  const wt = host.opts.worktrees;
  if (!wt || !host.baseBranch) {
    return { ok: false, reverted: 0, reason: 'no worktree run to roll back' };
  }
  return wt.revertCommits(
    host.baseBranch,
    host.mergedCommits.map((c) => c.sha),
  );
}

export function retryTask(host: SddParallelControlsHost, taskId: string): boolean {
  const node = host.opts.tracker.getNode(taskId);
  if (
    !node ||
    node.status === 'in_progress' ||
    node.status === 'completed' ||
    host.taskSubagents.has(taskId)
  ) {
    return false;
  }
  host.retryMap.delete(taskId);
  host.persistRetries(taskId, 0);
  // Clear any cancel marker so a previously-cancelled task can run again.
  host.cancelledTasks.delete(taskId);
  host.opts.tracker.patchMetadata(taskId, { cancelled: undefined });
  host.opts.tracker.updateNodeStatus(taskId, 'pending', 'manual retry');
  return true;
}

export function reassignTask(
  host: SddParallelControlsHost,
  taskId: string,
  agentName: string,
): boolean {
  if (!host.opts.tracker.getNode(taskId)) return false;
  host.opts.tracker.updateNode(taskId, { assignee: agentName });
  return true;
}

export function setTaskModel(
  host: SddParallelControlsHost,
  taskId: string,
  model: string | undefined,
  provider?: string | undefined,
): boolean {
  if (!host.opts.tracker.getNode(taskId)) return false;
  host.opts.tracker.patchMetadata(taskId, {
    model,
    ...(provider !== undefined ? { provider } : {}),
  });
  return true;
}

export function setTaskFallbacks(
  host: SddParallelControlsHost,
  taskId: string,
  fallbackModels: string[] | undefined,
): boolean {
  if (!host.opts.tracker.getNode(taskId)) return false;
  host.opts.tracker.patchMetadata(taskId, { fallbackModels });
  return true;
}

export function setTaskVerification(
  host: SddParallelControlsHost,
  taskId: string,
  verificationCommand: string | undefined,
): boolean {
  if (!host.opts.tracker.getNode(taskId)) return false;
  const cmd = verificationCommand?.trim();
  host.opts.tracker.patchMetadata(taskId, { verificationCommand: cmd ? cmd : undefined });
  return true;
}

export async function cancelTask(host: SddParallelControlsHost, taskId: string): Promise<boolean> {
  const node = host.opts.tracker.getNode(taskId);
  if (!node) return false;
  // Completed is terminal: the work shipped and its dependents were already
  // unblocked. `updateNodeStatus` applies transitions blindly, so without
  // this guard a cancel racing the task's completion — the user clicks
  // cancel just as it finishes — rewrote `completed` to `failed`, showed
  // finished work as "Cancelled" on the board, and undercounted the run's
  // completed total. Cancelling a *failed* task stays allowed: its cancelled
  // marker is what blocks the end-of-run retry sweep from requeueing it.
  if (node.status === 'completed') return false;
  host.cancelledTasks.add(taskId);
  // Terminal failed + cancel marker: failed keeps dependents un-deadlocked,
  // the marker drives the "Cancelled" board look and blocks retry/auto-redispatch.
  host.opts.tracker.patchMetadata(taskId, { cancelled: true });
  host.opts.tracker.updateNodeStatus(taskId, 'failed', 'cancelled by user');
  host.emit('sdd.task.failed', {
    runId: host.runId,
    taskId,
    subagentId: '',
    error: 'cancelled by user',
  });
  const subagentId = host.taskSubagents.get(taskId);
  if (subagentId && host.coordinator) {
    await host.coordinator.stop(subagentId).catch(() => {});
  }
  return true;
}

export function deleteTask(host: SddParallelControlsHost, taskId: string): boolean {
  const node = host.opts.tracker.getNode(taskId);
  if (!node) return false;
  if (node.status === 'in_progress' || host.taskSubagents.has(taskId)) return false;
  host.cancelledTasks.delete(taskId);
  host.retryMap.delete(taskId);
  return host.opts.tracker.removeNode(taskId);
}

export function splitTask(
  host: SddParallelControlsHost,
  taskId: string,
  subtasks: SddSubtaskSpec[],
): string[] {
  const leafIds = splitGraphNode(host.opts.tracker, taskId, subtasks, {
    isRunning: (id) => host.taskSubagents.has(id),
  });
  if (!leafIds.length) return [];
  host.retryMap.delete(taskId);
  host.persistRetries(taskId, 0);
  host.emit('sdd.task.split', { runId: host.runId, taskId, subtaskIds: leafIds });
  return leafIds;
}
