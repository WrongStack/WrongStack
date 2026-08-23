import * as fsp from 'node:fs/promises';
import type { TodoItem } from '../core/context.js';
import type { ConversationState } from '../core/conversation-state.js';
import type { EventBus } from './event-bus-port.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';

/**
 * On-disk checkpoint for `ctx.todos`. Written atomically every time the
 * todo list changes, read once on session resume. This is the missing
 * piece that lets `wstack resume <id>` rehydrate where the previous run
 * stopped instead of starting with an empty board.
 *
 * Schema is intentionally small — a single JSON object so a future
 * format bump is easy. The `version` field is the only contract; the
 * shape under `todos` mirrors `TodoItem` so reading is a straight assign.
 */
export interface TodosCheckpointFile {
  version: 1;
  sessionId: string;
  updatedAt: string;
  todos: TodoItem[];
}

export type TodosCheckpointDetach = () => Promise<void>;

/** Read a checkpoint from disk. Returns null when the file doesn't
 *  exist or is corrupt — callers treat both cases as "no prior state".
 */
export async function loadTodosCheckpoint(
  filePath: string,
  events?: EventBus,
  traceId?: string,
  sessionId?: string,
): Promise<TodoItem[] | null> {
  const t0 = Date.now();
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    events?.emit('storage.error', {
      sessionId: sessionId ?? '~boot~',
      store: 'todos',
      filePath,
      operation: 'load',
      outcome: 'failure',
      error: toErrorMessage(err),
      recoverable: true,
      ...(traceId !== undefined && { traceId }),
    });
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as TodosCheckpointFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.todos)) {
      events?.emit('storage.read', {
        sessionId: sessionId ?? '~boot~',
        store: 'todos',
        filePath,
        operation: 'load',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: 'invalid_schema',
        ...(traceId !== undefined && { traceId }),
      });
      return null;
    }
    events?.emit('storage.read', {
      sessionId: sessionId ?? parsed.sessionId ?? '~boot~',
      store: 'todos',
      filePath,
      operation: 'load',
      outcome: 'success',
      durationMs: Date.now() - t0,
      ...(traceId !== undefined && { traceId }),
    });
    return parsed.todos.filter(
      (t): t is TodoItem =>
        !!t &&
        typeof t.id === 'string' &&
        typeof t.content === 'string' &&
        typeof t.status === 'string' &&
        (t.activeForm === undefined || typeof t.activeForm === 'string'),
    );
  } catch {
    events?.emit('storage.read', {
      sessionId: sessionId ?? '~boot~',
      store: 'todos',
      filePath,
      operation: 'load',
      outcome: 'failure',
      durationMs: Date.now() - t0,
      error: 'parse_failed',
      ...(traceId !== undefined && { traceId }),
    });
    return null;
  }
}

/** Write the checkpoint atomically. Best-effort: a write failure is
 *  logged but does not throw — losing one checkpoint shouldn't bring
 *  down the agent run.
 */
export async function saveTodosCheckpoint(
  filePath: string,
  sessionId: string,
  todos: readonly TodoItem[],
  events?: EventBus,
  traceId?: string,
  warn?: (msg: string) => void,
): Promise<void> {
  const t0 = Date.now();
  const payload: TodosCheckpointFile = {
    version: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    todos: [...todos],
  };
  try {
    await atomicWrite(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    events?.emit('storage.write', {
      sessionId,
      store: 'todos',
      filePath,
      operation: 'save',
      outcome: 'success',
      durationMs: Date.now() - t0,
      ...(traceId !== undefined && { traceId }),
    });
  } catch (err) {
    events?.emit('storage.error', {
      sessionId,
      store: 'todos',
      filePath,
      operation: 'save',
      outcome: 'failure',
      error: toErrorMessage(err),
      recoverable: false,
      ...(traceId !== undefined && { traceId }),
    });
    (
      warn ??
      ((m) =>
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'todos_checkpoint.save_failed',
            message: m,
            timestamp: new Date().toISOString(),
          }),
        ))
    )(toErrorMessage(err));
  }
}

/**
 * Subscribe a `ConversationState` so every `todos_replaced` mutation
 * triggers an atomic write to disk. Returns the unsubscribe function.
 *
 * Writes are debounced by 150ms so a flurry of edits (e.g. the LLM
 * marking three items done in the same tool call) coalesces into one
 * disk hit.
 */
export function attachTodosCheckpoint(
  state: ConversationState,
  filePath: string,
  sessionId: string,
  events?: EventBus,
  traceId?: string,
  warn?: (msg: string) => void,
): TodosCheckpointDetach {
  let timer: NodeJS.Timeout | null = null;
  let pending: readonly TodoItem[] | null = null;
  let queuedWrite: readonly TodoItem[] | null = null;
  let writeInFlight: Promise<void> | null = null;

  const enqueueWrite = (todos: readonly TodoItem[]) => {
    queuedWrite = todos;
    if (writeInFlight) return writeInFlight;
    const drain = (async () => {
      while (queuedWrite) {
        const latest = queuedWrite;
        queuedWrite = null;
        await saveTodosCheckpoint(filePath, sessionId, latest, events, traceId).catch((err) => {
          const msg = toErrorMessage(err);
          (
            warn ??
            ((m) =>
              console.error(
                JSON.stringify({
                  level: 'error',
                  event: 'todos_checkpoint.write_failed',
                  sessionId,
                  message: m,
                  timestamp: new Date().toISOString(),
                }),
              ))
          )(msg);
        });
      }
    })().finally(() => {
      if (writeInFlight === drain) writeInFlight = null;
      if (queuedWrite) enqueueWrite(queuedWrite);
    });
    writeInFlight = drain;
    return drain;
  };

  const flush = () => {
    timer = null;
    if (pending) {
      const todos = pending;
      pending = null;
      return enqueueWrite(todos);
    }
    /* v8 ignore next -- defensive: flush is only invoked when a change is pending */
    return writeInFlight ?? Promise.resolve();
  };

  const unsubscribe = state.onChange((change) => {
    if (change.kind !== 'todos_replaced') return;
    pending = change.todos;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, 150);
  });
  let detached = false;
  let detachPromise: Promise<void> | null = null;
  return () => {
    if (detachPromise) return detachPromise;
    if (detached) return Promise.resolve();
    detached = true;
    unsubscribe();
    detachPromise = (async () => {
      if (timer) {
        clearTimeout(timer);
        // Flush any pending write before detach so callers can safely
        // unsubscribe at shutdown without losing the last update.
        await flush();
      } else {
        await writeInFlight;
      }
    })();
    return detachPromise;
  };
}
