import * as fsp from 'node:fs/promises';
import type { EventBus } from '../kernel/events.js';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';
import type { TaskItem } from '../utils/task-format.js';
import { SessionError } from '../types/errors.js';

// ---------------------------------------------------------------------------
// Task file persistence — one JSON file per session, resolved via
// `sessionScopedPath(projectSessions, sessionId, '.tasks.json')`.
//
// Low-level load/save are exported for read-only consumers. Mutating callers
// should use `mutateTasks` which wraps the entire read-modify-write cycle
// under a file-level lock, preventing races from parallel tool invocations.
// ---------------------------------------------------------------------------

export interface TaskFile {
  version: 1;
  sessionId: string;
  updatedAt: string;
  tasks: TaskItem[];
}

export function emptyTaskFile(sessionId: string): TaskFile {
  return {
    version: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    tasks: [],
  };
}

/** Read the task file. Returns null when the file doesn't exist. */
export async function loadTasks(
  filePath: string,
  events?: EventBus,
  traceId?: string,
): Promise<TaskFile | null> {
  const t0 = Date.now();
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    events?.emit('storage.error', {
      sessionId: traceId ?? '~boot~',
      store: 'tasks',
      filePath,
      operation: 'load',
      outcome: 'failure',
      error: toErrorMessage(err),
      recoverable: true,
    });
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as TaskFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) {
      events?.emit('storage.read', {
        sessionId: traceId ?? '~boot~',
        store: 'tasks',
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
      sessionId: traceId ?? '~boot~',
      store: 'tasks',
      filePath,
      operation: 'load',
      outcome: 'success',
      durationMs: Date.now() - t0,
      ...(traceId !== undefined && { traceId }),
    });
    return parsed;
  } catch {
    events?.emit('storage.read', {
      sessionId: traceId ?? '~boot~',
      store: 'tasks',
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

/**
 * Write the task file atomically. Prefer `mutateTasks` for read-modify-write
 * cycles — this low-level function does NOT acquire a lock.
 */
/**
 * Persist the task file. Returns `true` on success, `false` if the write
 * failed (still emits `storage.error` + warns — does NOT throw). `mutateTasks`
 * inspects the result and throws so the task TOOL can report `ok:false`
 * instead of falsely claiming the tasks were saved.
 */
export async function saveTasks(
  filePath: string,
  tasks: TaskFile,
  events?: EventBus,
  traceId?: string,
): Promise<boolean> {
  const t0 = Date.now();
  try {
    tasks.updatedAt = new Date().toISOString();
    await atomicWrite(filePath, JSON.stringify(tasks, null, 2), { mode: 0o600 });
    events?.emit('storage.write', {
      sessionId: traceId ?? '~boot~',
      store: 'tasks',
      filePath,
      operation: 'save',
      outcome: 'success',
      durationMs: Date.now() - t0,
      ...(traceId !== undefined && { traceId }),
    });
    return true;
  } catch (err) {
    events?.emit('storage.error', {
      sessionId: traceId ?? '~boot~',
      store: 'tasks',
      filePath,
      operation: 'save',
      outcome: 'failure',
      error: toErrorMessage(err),
      recoverable: false,
      ...(traceId !== undefined && { traceId }),
    });
    console.warn(
      '[task-store] save failed:',
      toErrorMessage(err),
    );
    return false;
  }
}

/**
 * Load, modify, and save the task file under a file-level lock.
 * `fn` receives the current TaskFile (or a fresh empty one) and must
 * return the mutated TaskFile (mutating in-place is fine — the returned
 * reference is what gets saved).
 *
 * This is the primary API for any code path that reads *and then writes*
 * the task file — it prevents races from parallel `batch_tool_use` calls.
 */
export async function mutateTasks(
  filePath: string,
  sessionId: string,
  fn: (file: TaskFile) => TaskFile | Promise<TaskFile>,
  events?: EventBus,
  traceId?: string,
): Promise<TaskFile> {
  return withFileLock(filePath, async () => {
    const file = (await loadTasks(filePath, events, traceId)) ?? emptyTaskFile(sessionId);
    const updated = await fn(file);
    const persisted = await saveTasks(filePath, updated, events, traceId);
    if (!persisted) {
      throw new SessionError({
        message: `Failed to persist tasks to ${filePath} — the change was NOT saved.`,
        code: 'SESSION_WRITE_FAILED',
        sessionId,
        context: { filePath, operation: 'mutateTasks' },
      });
    }
    return updated;
  });
}
