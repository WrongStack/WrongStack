import type { EventMap } from '@wrongstack/core/kernel';
import type { TaskNode, TaskResult } from '@wrongstack/core/types';
import type { WorktreeHandle } from '@wrongstack/core/worktree';
import type { SddParallelRunOptions } from './sdd-parallel-run-types.js';

interface SddWorktreeState {
  taskCwds: Map<string, string>;
  taskBranches: Map<string, string>;
  taskWorktrees: Map<string, WorktreeHandle>;
  mergedCommits: Array<{ taskId: string; sha: string; title: string }>;
}

export function forgetTaskWorktree(
  state: SddWorktreeState,
  taskId: string,
  opts: { keepBranchLabel?: boolean } = {},
): void {
  state.taskWorktrees.delete(taskId);
  state.taskCwds.delete(taskId);
  if (!opts.keepBranchLabel) state.taskBranches.delete(taskId);
}

export async function allocateTaskWorktrees(
  opts: SddParallelRunOptions,
  state: SddWorktreeState,
  tasks: TaskNode[],
): Promise<void> {
  const wt = opts.worktrees;
  if (!wt) return;
  for (const task of tasks) {
    if (state.taskWorktrees.has(task.id)) continue;
    try {
      const handle = await wt.allocate(`sdd-${task.id}`, {
        slugHint: task.title,
        ownerLabel: task.title,
      });
      if (handle.status === 'active') {
        state.taskWorktrees.set(task.id, handle);
        state.taskCwds.set(task.id, handle.dir);
        state.taskBranches.set(task.id, handle.branch);
        const node = opts.tracker.getNode(task.id);
        if (node) node.metadata = { ...node.metadata, worktreeBranch: handle.branch };
      }
    } catch {
      // Allocation failed → this task runs on the shared working tree.
    }
  }
}

export async function resolveTaskWorktrees(
  opts: SddParallelRunOptions,
  state: SddWorktreeState,
  tasks: TaskNode[],
): Promise<void> {
  const wt = opts.worktrees;
  if (!wt) return;
  for (const task of tasks) {
    const handle = state.taskWorktrees.get(task.id);
    if (!handle) continue;
    const node = opts.tracker.getNode(task.id);
    const status = node?.status;
    const cancelled = Boolean(node?.metadata?.cancelled);
    try {
      if (cancelled) {
        await wt.release(handle, { keep: false });
        forgetTaskWorktree(state, task.id, { keepBranchLabel: false });
      } else if (status === 'completed') {
        await wt.commitAll(handle, `sdd(${task.title}): ${task.id}`);
        await wt.merge(handle, { squash: true });
        await wt.release(handle, { keep: false });
        forgetTaskWorktree(state, task.id);
      } else if (status === 'failed') {
        await wt.release(handle, { keep: false });
        forgetTaskWorktree(state, task.id, { keepBranchLabel: false });
      } else {
        await wt.release(handle, { keep: false });
        forgetTaskWorktree(state, task.id, { keepBranchLabel: false });
      }
    } catch {
      forgetTaskWorktree(state, task.id);
    }
  }
}

export async function integrateTaskWorktree(params: {
  opts: SddParallelRunOptions;
  state: SddWorktreeState;
  task: TaskNode;
  result?: TaskResult | undefined;
  runId: string;
  emit: <K extends keyof EventMap>(event: K, payload: EventMap[K]) => void;
  abortRun: (reason: string) => void;
}): Promise<{ ok: boolean; conflictFiles?: string[]; reason?: string; fatal?: boolean }> {
  const { opts, state, task, result, runId, emit, abortRun } = params;
  const wt = opts.worktrees;
  if (!wt) return { ok: true };
  const handle = state.taskWorktrees.get(task.id);
  if (!handle) return { ok: true };
  try {
    await wt.commitAll(handle, `sdd(${task.title}): ${task.id}`);
    const baseShaBefore = await wt.baseHead(handle);
    const baseSha = opts.conflictResolver ? baseShaBefore : null;
    const res = await wt.merge(handle, {
      squash: true,
      ...(opts.conflictResolver
        ? {
            resolve: (info: { conflictFiles: string[]; cwd: string }) =>
              opts.conflictResolver!({
                task,
                conflictFiles: info.conflictFiles,
                cwd: info.cwd,
              }),
          }
        : {}),
    });
    if (res.ok) {
      if (res.resolved && opts.verifyTask && baseSha) {
        let regressed: string | undefined;
        try {
          const verdict = await opts.verifyTask({
            task,
            result: result ?? ({} as TaskResult),
            cwd: opts.projectRoot,
          });
          if (!verdict.ok)
            regressed = verdict.reason ?? 'verification failed after conflict resolution';
        } catch (err) {
          regressed = `verification error after conflict resolution: ${String(err)}`;
        }
        if (regressed) {
          const rolledBack = await wt.revertBaseTo(handle, baseSha).catch(() => false);
          if (!rolledBack) {
            abortRun(
              `cannot roll back invalid merge of "${task.title}" (${task.id}): ${regressed}`,
            );
            await wt.release(handle, { keep: true }).catch(() => {});
            forgetTaskWorktree(state, task.id, { keepBranchLabel: true });
            return { ok: false, conflictFiles: [], reason: regressed, fatal: true };
          }
          await wt.release(handle, { keep: false }).catch(() => {});
          forgetTaskWorktree(state, task.id, { keepBranchLabel: true });
          return { ok: false, conflictFiles: [], reason: regressed };
        }
      }
      const baseShaAfter = await wt.baseHead(handle);
      if (baseShaAfter && baseShaAfter !== baseShaBefore) {
        state.mergedCommits.push({ taskId: task.id, sha: baseShaAfter, title: task.title });
        emit('sdd.task.merged', { runId, taskId: task.id, sha: baseShaAfter });
      }
      await wt.release(handle, { keep: false });
      forgetTaskWorktree(state, task.id);
      return { ok: true };
    }
    await wt.release(handle, { keep: false }).catch(() => {});
    forgetTaskWorktree(state, task.id, { keepBranchLabel: true });
    return { ok: false, conflictFiles: res.conflictFiles ?? [] };
  } catch {
    forgetTaskWorktree(state, task.id);
    return { ok: false, conflictFiles: [] };
  }
}
