import type { EventEmitter } from 'node:events';
import type { AwaitAnyResult, TaskResult, TaskSpec } from '../types/multi-agent.js';

export interface AwaitTasksParams {
  emitter: EventEmitter;
  taskIds: string[];
  completedResultsById: Map<string, TaskResult>;
  defaultTimeoutMs?: number | undefined;
  opts?: { timeoutMs?: number | undefined } | undefined;
}

export async function awaitCoordinatorTasks(params: AwaitTasksParams): Promise<TaskResult[]> {
  const { emitter, taskIds, completedResultsById, defaultTimeoutMs, opts } = params;
  const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs ?? 300_000;
  return Promise.all(
    taskIds.map((id) => {
      const cached = completedResultsById.get(id);
      if (cached) return cached;
      return new Promise<TaskResult>((resolve, reject) => {
        const timeout = setTimeout(() => {
          emitter.off('task.completed', handler);
          reject(new Error(`awaitTasks timed out waiting for task "${id}"`));
        }, timeoutMs);
        const handler = ({ result }: { task: TaskSpec; result: TaskResult }) => {
          if (result.taskId === id) {
            clearTimeout(timeout);
            emitter.off('task.completed', handler);
            resolve(result);
          }
        };
        emitter.on('task.completed', handler);
      });
    }),
  );
}

export interface AwaitTasksAnyParams {
  emitter: EventEmitter;
  taskIds: string[];
  completedResultsById: Map<string, TaskResult>;
  opts?: { timeoutMs?: number | undefined } | undefined;
}

export async function awaitCoordinatorTasksAny(
  params: AwaitTasksAnyParams,
): Promise<AwaitAnyResult> {
  const { emitter, taskIds, completedResultsById, opts } = params;
  const completed: TaskResult[] = [];
  for (const id of taskIds) {
    const cached = completedResultsById.get(id);
    if (cached) completed.push(cached);
  }
  if (completed.length > 0 || taskIds.length === 0) {
    const done = new Set(completed.map((r) => r.taskId));
    return { completed, pending: taskIds.filter((id) => !done.has(id)) };
  }
  const ids = new Set(taskIds);
  return new Promise<AwaitAnyResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handler = ({ result }: { task: TaskSpec; result: TaskResult }) => {
      if (!ids.has(result.taskId)) return;
      if (timer) clearTimeout(timer);
      emitter.off('task.completed', handler);
      resolve({
        completed: [result],
        pending: taskIds.filter((id) => id !== result.taskId),
      });
    };
    if (opts?.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        emitter.off('task.completed', handler);
        resolve({ completed: [], pending: [...taskIds], timedOut: true });
      }, opts.timeoutMs);
    }
    emitter.on('task.completed', handler);
  });
}
