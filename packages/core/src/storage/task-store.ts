import * as fsp from 'node:fs/promises';
import { SessionError } from '@wrongstack/contracts/types/errors';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';
import type { TaskItem } from '../utils/task-format.js';
import type { EventBus } from './event-bus-port.js';

const TRANSIENT_READ_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** Read a store file, retrying briefly through transient Windows sharing errors. */
async function readStoreFile(filePath: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.readFile(filePath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || code === undefined || !TRANSIENT_READ_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

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

function assertTaskMutationInvariants(previous: TaskFile, updated: TaskFile): void {
  const ids = updated.tasks.map((task) => task.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    throw new SessionError({
      message: 'Task mutation rejected: task IDs must be unique.',
      code: 'SESSION_WRITE_FAILED',
      sessionId: updated.sessionId,
      context: { operation: 'mutateTasks', invariant: 'unique_task_ids' },
    });
  }

  const omittedUnfinished = previous.tasks.filter(
    (task) => task.status !== 'completed' && !uniqueIds.has(task.id),
  );
  if (omittedUnfinished.length > 0) {
    throw new SessionError({
      message: `Task mutation rejected: unfinished tasks cannot be omitted: ${omittedUnfinished
        .map((task) => task.id)
        .join(', ')}. Complete them first.`,
      code: 'SESSION_WRITE_FAILED',
      sessionId: updated.sessionId,
      context: { operation: 'mutateTasks', invariant: 'unfinished_task_coverage' },
    });
  }

  const byId = new Map(updated.tasks.map((task) => [task.id, task]));
  for (const task of updated.tasks) {
    const missing = (task.dependsOn ?? []).filter((dependencyId) => !byId.has(dependencyId));
    if (missing.length > 0) {
      throw new SessionError({
        message: `Task mutation rejected: task "${task.id}" references missing dependencies: ${missing.join(', ')}.`,
        code: 'SESSION_WRITE_FAILED',
        sessionId: updated.sessionId,
        context: { operation: 'mutateTasks', invariant: 'dependency_identity' },
      });
    }
    if (task.status === 'in_progress' || task.status === 'review' || task.status === 'completed') {
      const unmet = (task.dependsOn ?? []).filter(
        (dependencyId) => byId.get(dependencyId)?.status !== 'completed',
      );
      if (unmet.length > 0) {
        throw new SessionError({
          message: `Task mutation rejected: task "${task.id}" cannot be ${task.status} before dependencies complete: ${unmet.join(', ')}.`,
          code: 'SESSION_WRITE_FAILED',
          sessionId: updated.sessionId,
          context: { operation: 'mutateTasks', invariant: 'dependency_completion' },
        });
      }
    }
  }
}

export function emptyTaskFile(sessionId: string): TaskFile {
  return {
    version: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    tasks: [],
  };
}

/**
 * Read the task file. Returns null when the file doesn't exist. With
 * `strict`, any other read error is thrown instead: a read-modify-write that
 * took "unreadable" for "empty" saved over every task in the file.
 */
export async function loadTasks(
  filePath: string,
  events?: EventBus,
  traceId?: string,
  options?: { strict?: boolean | undefined },
): Promise<TaskFile | null> {
  const t0 = Date.now();
  let raw: string;
  try {
    raw = await readStoreFile(filePath);
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
    if (options?.strict && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return null;
  }
  // An editor's UTF-8 BOM is not corruption. Under `strict`, an unparseable or
  // unknown-schema file is not "no file" either: the caller would save a fresh
  // file over it and drop every unfinished task.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  // A blank file holds nothing to lose; refusing it would lock the store out.
  if (text.trim() === '') return null;
  let parsed: TaskFile;
  try {
    parsed = JSON.parse(text) as TaskFile;
  } catch (err) {
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
    if (options?.strict) throw err;
    return null;
  }
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
    if (options?.strict) throw new Error(`unsupported task file schema in ${filePath}`);
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
  warn?: (msg: string) => void,
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
    (
      warn ??
      ((m) =>
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'task_store.save_failed',
            message: m,
            timestamp: new Date().toISOString(),
          }),
        ))
    )(toErrorMessage(err));
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
    let loaded: TaskFile | null;
    try {
      loaded = await loadTasks(filePath, events, traceId, { strict: true });
    } catch (err) {
      throw new SessionError({
        message: `Failed to read tasks from ${filePath} — the change was NOT saved.`,
        code: 'SESSION_WRITE_FAILED',
        sessionId,
        context: { filePath, operation: 'mutateTasks', cause: toErrorMessage(err) },
      });
    }
    const file = loaded ?? emptyTaskFile(sessionId);
    const previous = structuredClone(file);
    const updated = await fn(file);
    assertTaskMutationInvariants(previous, updated);
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
