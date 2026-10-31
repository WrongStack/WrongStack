import { randomUUID } from 'node:crypto';
import {
  cancelTask,
  followTask,
  terminalTaskRecord,
  WfAborted,
  type WfCall,
  type WfEvent,
  type WfTaskRecord,
} from '@wrongstack/fleet';
import { deferShutdownForRemoteWork } from '../shutdown-cleanup.js';

const DEFAULT_WRONGFORGE_QUEUE_TIMEOUT_MS = 120_000;

export class WfQueueTimeout extends Error {
  constructor(readonly timeoutMs: number) {
    super(`queue wait exceeded ${timeoutMs}ms`);
  }
}

/** Own an asynchronous task until it finishes or its caller gives it up. */
export async function runWrongForgeTask(
  call: WfCall,
  body: Record<string, unknown>,
  signal: AbortSignal,
  opts: {
    queueTimeoutMs?: number | undefined;
    onCreated?: (() => void) | undefined;
    onEvent?: ((event: WfEvent) => void) | undefined;
  } = {},
): Promise<WfTaskRecord> {
  if (signal.aborted) throw new WfAborted();
  const timeoutMs = opts.queueTimeoutMs ?? DEFAULT_WRONGFORGE_QUEUE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error('providers.wrongforge.queueTimeoutMs must be a positive integer <= 2147483647');

  const releaseShutdown = deferShutdownForRemoteWork();
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal.addEventListener('abort', abort, { once: true });
  // Known before POST, so even an aborted submission can be cancelled.
  let taskId = `ws-${randomUUID()}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let queued = false;
  const clearQueue = () => {
    clearTimeout(timer);
    timer = undefined;
    queued = false;
  };
  const observe = (status: string) => {
    if (status !== 'queued') {
      clearQueue();
    } else if (!queued) {
      queued = true;
      process.stderr.write(`[queued] WrongForge: waiting for capacity (timeout ${timeoutMs}ms)\n`);
      timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, timeoutMs);
    }
  };
  try {
    const { task } = await call<{ task: WfTaskRecord }>(
      'POST',
      '/v1/tasks',
      { ...body, task_id: taskId, wait: false },
      ctrl.signal,
    );
    taskId = task.id;
    opts.onCreated?.();
    if (ctrl.signal.aborted) throw new WfAborted();
    observe(task.status);
    if (task.status !== 'queued' && task.status !== 'running') return task;
    for await (const event of followTask(call, taskId, ctrl.signal, { onPoll: observe })) {
      if (event.type === 'task.started') clearQueue();
      if (event.type === 'task.queued') {
        observe('queued');
        const position = event.data['position'];
        const waiting = event.data['waiting_for'];
        if (typeof position === 'number')
          process.stderr.write(
            `[queued] WrongForge: position ${position}${typeof waiting === 'string' ? ` (waiting for ${waiting})` : ''}\n`,
          );
      }
      opts.onEvent?.(event);
    }
    clearQueue();
    return await terminalTaskRecord(call, taskId, ctrl.signal);
  } catch (error) {
    clearQueue();
    await cancelTask(
      call,
      taskId,
      timedOut ? 'queue timeout in WrongStack' : 'interrupted in WrongStack',
    );
    if (timedOut) throw new WfQueueTimeout(timeoutMs);
    if (signal.aborted) throw new WfAborted();
    throw error;
  } finally {
    clearQueue();
    signal.removeEventListener('abort', abort);
    releaseShutdown();
  }
}
