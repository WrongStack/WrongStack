import type { EventEmitter } from 'node:events';
import type { AwaitAnyResult, TaskResult, TaskSpec } from '@wrongstack/contracts/types/multi-agent';

export interface AwaitTasksParams {
  emitter: EventEmitter;
  taskIds: string[];
  completedResultsById: Map<string, TaskResult>;
  defaultTimeoutMs?: number | undefined;
  opts?: { timeoutMs?: number | undefined } | undefined;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

function armCappedTimeout(delayMs: number, onExpire: () => void): () => void {
  if (delayMs === Number.POSITIVE_INFINITY) return () => {};
  const safeDelay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
  const deadline = Date.now() + safeDelay;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const arm = (remaining: number): void => {
    if (cancelled) return;
    if (timer) clearTimeout(timer);
    const chunk = Math.min(Math.max(0, remaining), MAX_TIMEOUT_MS);
    timer = setTimeout(() => {
      if (cancelled) return;
      const left = deadline - Date.now();
      if (left > 0) {
        arm(left);
        return;
      }
      onExpire();
    }, chunk);
  };
  arm(safeDelay);
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}

export async function awaitCoordinatorTasks(params: AwaitTasksParams): Promise<TaskResult[]> {
  const { emitter, taskIds, completedResultsById, defaultTimeoutMs, opts } = params;
  const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs ?? 300_000;
  return Promise.all(
    taskIds.map((id) => {
      const cached = completedResultsById.get(id);
      if (cached) return cached;
      return new Promise<TaskResult>((resolve, reject) => {
        const cancelTimeout = armCappedTimeout(timeoutMs, () => {
          emitter.off('task.completed', handler);
          reject(new Error(`awaitTasks timed out waiting for task "${id}"`));
        });
        const handler = ({ result }: { task: TaskSpec; result: TaskResult }) => {
          if (result.taskId === id) {
            cancelTimeout();
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
    let cancelTimeout: (() => void) | undefined;
    const handler = ({ result }: { task: TaskSpec; result: TaskResult }) => {
      if (!ids.has(result.taskId)) return;
      cancelTimeout?.();
      emitter.off('task.completed', handler);
      resolve({
        completed: [result],
        pending: taskIds.filter((id) => id !== result.taskId),
      });
    };
    if (opts?.timeoutMs !== undefined) {
      cancelTimeout = armCappedTimeout(opts.timeoutMs, () => {
        emitter.off('task.completed', handler);
        resolve({ completed: [], pending: [...taskIds], timedOut: true });
      });
    }
    emitter.on('task.completed', handler);
  });
}
