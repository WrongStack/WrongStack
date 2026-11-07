import {
  boardKey,
  cleanupEmptySessionKanbanBoards,
  cleanupSessionKanbanBoardIfEmpty,
  ensureSessionKanbanBoard,
  isOwnedSessionBoard,
  releaseActiveSessionBoard,
  retainActiveSessionBoard,
  sessionIdFromTags,
} from './session-kanban-boards.js';

export {
  cleanupEmptySessionKanbanBoards,
  cleanupSessionKanbanBoard,
  cleanupSessionKanbanBoardIfEmpty,
  ensureSessionKanbanBoard,
  SESSION_KANBAN_COLUMNS,
} from './session-kanban-boards.js';

import { type FSWatcher, watch } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import type { Context, TodoItem } from '@wrongstack/core/agent';
import { loadPlan, loadTasks, type PlanItem } from '@wrongstack/core/storage';
import type { TaskItem } from '@wrongstack/core/utils';
import {
  bridgeKanbanSupervisor,
  getBoard,
  getKanbanOrchestrationSnapshot,
  type KanbanBoard,
  type KanbanTask,
  pruneSessionBoards,
  touchKanbanPresence,
} from '@wrongstack/kanban';
import {
  planFileToSerializedGraph,
  taskFileToSerializedGraph,
  todoListToSerializedGraph,
} from './session-kanban-graph.js';
import { deliverKanbanManagementReview } from './session-kanban-management.js';
import {
  activeMirrors,
  backgroundWork,
  mirrorFailures,
  mirrorKey,
  pendingMirrors,
  projectGraph,
  queueLatestMirror,
  trackBackgroundWork,
} from './session-kanban-mirror-queue.js';
import {
  applyManagedKanbanBoardToTodos as applyManagedKanbanBoardToTodosSync,
  applySessionKanbanBoardToTodos as applySessionKanbanBoardToTodosSync,
  applySessionKanbanTaskToSource as applySessionKanbanTaskToSourceSync,
  type SessionKanbanSourceUpdate,
  todosNeedingSessionMirror,
} from './session-kanban-sync.js';

export {
  PLAN_STATUS_TO_TASK,
  planFileToSerializedGraph,
  taskFileToSerializedGraph,
  todoListToSerializedGraph,
} from './session-kanban-graph.js';

export {
  blockingTitles,
  orderTasksForTodos,
  type SessionKanbanSourceUpdate,
  todosNeedingSessionMirror,
} from './session-kanban-sync.js';

const bindings = new WeakMap<Context, () => void>();
const suppressedTodoMirrors = new WeakSet<Context>();

export function takeSessionMirrorFailure(
  projectRoot: string | undefined,
  sessionId: string,
): string | undefined {
  if (!projectRoot || !sessionId) return undefined;
  const key = boardKey(projectRoot, sessionId);
  const failure = mirrorFailures.get(key);
  if (!failure) return undefined;
  mirrorFailures.delete(key);
  return `Kanban mirror (${failure.sourceSystem}) failed and the board may be stale: ${failure.message}`;
}

function hasInFlightTodoMirror(projectRoot: string | undefined, sessionId: string): boolean {
  if (!projectRoot || !sessionId) return false;
  const key = mirrorKey(projectRoot, sessionId, 'session-todo');
  return pendingMirrors.has(key) || activeMirrors.has(key);
}

export function projectSessionTodosToKanban(
  projectRoot: string | undefined,
  todos: readonly TodoItem[],
  sessionId: string,
): Promise<KanbanBoard | null> {
  return projectGraph(
    projectRoot,
    sessionId,
    todoListToSerializedGraph(todos, sessionId),
    'session-todo',
  );
}

export function projectSessionTasksToKanban(
  projectRoot: string | undefined,
  tasks: readonly TaskItem[],
  sessionId: string,
): Promise<KanbanBoard | null> {
  return projectGraph(
    projectRoot,
    sessionId,
    taskFileToSerializedGraph(tasks, sessionId),
    'session-task',
  );
}

export function projectSessionPlanToKanban(
  projectRoot: string | undefined,
  items: readonly PlanItem[],
  sessionId: string,
): Promise<KanbanBoard | null> {
  return projectGraph(
    projectRoot,
    sessionId,
    planFileToSerializedGraph(items, sessionId),
    'session-plan',
  );
}

/**
 * Waits for background work started so far to finish. Background work can
 * start more background work (the mirror pump re-queues itself), so this
 * drains in passes until a full pass adds nothing; the pass cap keeps a
 * pathological re-queue loop from hanging a caller forever.
 */
export async function settleSessionKanbanBackgroundWork(maxPasses = 25): Promise<void> {
  for (let pass = 0; pass < maxPasses && backgroundWork.size > 0; pass += 1) {
    await Promise.all([...backgroundWork]);
  }
}

function fireAndForget(context: string, work: Promise<unknown>): void {
  trackBackgroundWork(
    work.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'session-kanban',
          context,
          message,
          timestamp: new Date().toISOString(),
        }),
      );
    }),
  );
}

export function mirrorSessionTodosToKanban(
  projectRoot: string | undefined,
  todos: readonly TodoItem[],
  sessionId: string,
): void {
  queueLatestMirror(
    projectRoot,
    sessionId,
    todoListToSerializedGraph(todos, sessionId),
    'session-todo',
  );
}

export function mirrorSessionTasksToKanban(
  projectRoot: string | undefined,
  tasks: readonly TaskItem[],
  sessionId: string,
): void {
  queueLatestMirror(
    projectRoot,
    sessionId,
    taskFileToSerializedGraph(tasks, sessionId),
    'session-task',
  );
}

export function mirrorSessionPlanToKanban(
  projectRoot: string | undefined,
  items: readonly PlanItem[],
  sessionId: string,
): void {
  queueLatestMirror(
    projectRoot,
    sessionId,
    planFileToSerializedGraph(items, sessionId),
    'session-plan',
  );
}

export function attachSessionKanbanMirror(context: Context): () => void {
  const existing = bindings.get(context);
  if (existing) return existing;

  let detached = false;
  let watcherGeneration = 0;
  const attachedProjectRoot = context.projectRoot ?? '';
  let registeredSessionId = '';
  const syncActiveSessionRegistration = () => {
    if (!attachedProjectRoot) return;
    const currentSessionId = context.session?.id ?? '';
    if (currentSessionId === registeredSessionId) return;
    if (registeredSessionId) {
      releaseActiveSessionBoard(attachedProjectRoot, registeredSessionId);
      fireAndForget(
        'cleanup-board',
        cleanupSessionKanbanBoardIfEmpty(attachedProjectRoot, registeredSessionId),
      );
    }
    registeredSessionId = currentSessionId;
    if (registeredSessionId) {
      retainActiveSessionBoard(attachedProjectRoot, registeredSessionId);
    }
  };
  syncActiveSessionRegistration();

  let watcher: FSWatcher | null = null;
  let watchedDir = '';
  let timer: NodeJS.Timeout | null = null;
  let unsubscribeBoardEvents: (() => void) | null = null;
  let watchedBoardId = '';
  let boardTimer: NodeJS.Timeout | null = null;
  let presenceTimer: NodeJS.Timeout | null = null;

  const sessionId = () => context.session?.id ?? '';
  const activeManagedBoardId = () => {
    const metaKanban = context.meta['kanban'];
    const metaBoardId =
      metaKanban && typeof metaKanban === 'object'
        ? (metaKanban as Record<string, unknown>)['boardId']
        : undefined;
    return (
      context.currentKanbanBoardId ??
      (typeof metaBoardId === 'string' && metaBoardId ? metaBoardId : '')
    );
  };
  const isCurrent = (id: string, boardId: string, generation: number) =>
    !detached &&
    generation === watcherGeneration &&
    sessionId() === id &&
    activeManagedBoardId() === boardId &&
    (context.projectRoot ?? '') === attachedProjectRoot;
  const stopBoardWatcher = () => {
    unsubscribeBoardEvents?.();
    unsubscribeBoardEvents = null;
    if (boardTimer) clearTimeout(boardTimer);
    boardTimer = null;
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = null;
    watchedBoardId = '';
  };
  const refreshFiles = async () => {
    const id = sessionId();
    const generation = watcherGeneration;
    const managedBoardId = activeManagedBoardId();
    if (!id || detached) return;
    const planPath = context.meta['plan.path.resolved'] ?? context.meta['plan.path'];
    const taskPath = context.meta['task.path.resolved'] ?? context.meta['task.path'];
    if (typeof planPath === 'string' && planPath) {
      const plan = await loadPlan(planPath);
      if (
        !isCurrent(id, managedBoardId, generation) ||
        (context.meta['plan.path.resolved'] ?? context.meta['plan.path']) !== planPath
      )
        return;
      if (plan) await projectSessionPlanToKanban(attachedProjectRoot, plan.items, id);
    }
    if (!isCurrent(id, managedBoardId, generation)) return;
    if (typeof taskPath === 'string' && taskPath) {
      const tasks = await loadTasks(taskPath);
      if (
        !isCurrent(id, managedBoardId, generation) ||
        (context.meta['task.path.resolved'] ?? context.meta['task.path']) !== taskPath
      )
        return;
      if (tasks) await projectSessionTasksToKanban(attachedProjectRoot, tasks.tasks, id);
    }
  };

  const refreshBoard = async () => {
    const boardId = watchedBoardId;
    const id = sessionId();
    const managedBoardId = activeManagedBoardId();
    const generation = watcherGeneration;
    if (!boardId || detached) return;
    const board = await getBoard(attachedProjectRoot, boardId);
    if (!board || !isCurrent(id, managedBoardId, generation) || watchedBoardId !== boardId) return;
    deliverKanbanManagementReview(context, board);
    if (board.lifecycle?.mode === 'managed') applyManagedKanbanBoardToTodos(context, board);
    else applySessionKanbanBoardToTodos(context, board);
  };

  const configureBoardWatcher = async () => {
    if (detached) return;
    const generation = ++watcherGeneration;
    const id = sessionId();
    const managedBoardId = activeManagedBoardId();
    stopBoardWatcher();
    const board = managedBoardId
      ? await getBoard(attachedProjectRoot, managedBoardId)
      : id
        ? await ensureSessionKanbanBoard(attachedProjectRoot, id)
        : null;
    if (!board || !isCurrent(id, managedBoardId, generation)) return;
    watchedBoardId = board.id;
    try {
      unsubscribeBoardEvents = bridgeKanbanSupervisor(
        attachedProjectRoot,
        (event) => {
          if (!isCurrent(id, managedBoardId, generation)) return;
          const data = event.data as { boardId?: string } | undefined;
          if (data?.boardId !== board.id) return;
          if (boardTimer) clearTimeout(boardTimer);
          boardTimer = setTimeout(() => fireAndForget('refresh-board', refreshBoard()), 60);
        },
        { autoReconnect: true, reconnectDelayMs: 1_000 },
      );
      const touchPresence = () =>
        isCurrent(id, managedBoardId, generation)
          ? touchKanbanPresence(attachedProjectRoot, board.id, {
              sessionId: id,
              agentId: context.agentId,
              agentName: context.agentName,
            })
          : Promise.resolve(null);
      fireAndForget('touch-presence', touchPresence());
      if (presenceTimer) clearInterval(presenceTimer);
      presenceTimer = setInterval(() => fireAndForget('touch-presence', touchPresence()), 60_000);
      presenceTimer.unref?.();
      if (board.lifecycle?.mode === 'managed') applyManagedKanbanBoardToTodos(context, board);
    } catch {
      unsubscribeBoardEvents = null;
      watchedBoardId = '';
    }
  };

  const configureWatcher = () => {
    if (detached) return;
    const planPath = context.meta['plan.path'];
    const taskPath = context.meta['task.path'];
    const candidate =
      typeof planPath === 'string' && planPath
        ? dirname(planPath)
        : typeof taskPath === 'string' && taskPath
          ? dirname(taskPath)
          : '';
    if (candidate === watchedDir) return;
    watcher?.close();
    watcher = null;
    watchedDir = candidate;
    if (!candidate) return;
    try {
      watcher = watch(candidate, { persistent: false }, (_event, filename) => {
        if (detached || watchedDir !== candidate) return;
        const name = filename?.toString();
        // Windows reports a deleted watched directory as an endless 'rename'
        // storm of its own absolute path (never error/close). Stop watching;
        // the next plan/task path change re-arms.
        if (name && isAbsolute(name)) {
          watcher?.close();
          watcher = null;
          watchedDir = '';
          return;
        }
        const currentPlanPath = context.meta['plan.path.resolved'] ?? context.meta['plan.path'];
        const currentTaskPath = context.meta['task.path.resolved'] ?? context.meta['task.path'];
        const planName = typeof currentPlanPath === 'string' ? basename(currentPlanPath) : '';
        const taskName = typeof currentTaskPath === 'string' ? basename(currentTaskPath) : '';
        if (name && name !== planName && name !== taskName) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fireAndForget('refresh-files', refreshFiles()), 60);
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
        watchedDir = '';
      });
    } catch {
      watcher = null;
      watchedDir = '';
    }
  };

  const unsubscribe = context.state.onChange((change) => {
    if (detached) return;
    if (change.kind === 'todos_replaced' && !suppressedTodoMirrors.has(context)) {
      const snapshot = change.completedSnapshot ?? change.todos;
      const unbound = todosNeedingSessionMirror(snapshot, activeManagedBoardId());
      if (snapshot.length > 0 && unbound.length === 0) return;
      mirrorSessionTodosToKanban(context.projectRoot, unbound, sessionId());
      return;
    }
    if (
      change.kind === 'meta_set' &&
      (change.key === 'plan.path' || change.key === 'task.path' || change.key === 'kanban')
    ) {
      syncActiveSessionRegistration();
      configureWatcher();
      if (!activeManagedBoardId()) {
        fireAndForget('ensure-board', ensureSessionKanbanBoard(context.projectRoot, sessionId()));
      }
      fireAndForget('configure-watcher', configureBoardWatcher());
      fireAndForget('refresh-board', refreshBoard());
      fireAndForget('refresh-files', refreshFiles());
    }
  });

  configureWatcher();
  fireAndForget('configure-watcher', configureBoardWatcher());

  const detach = () => {
    if (detached) return;
    detached = true;
    watcherGeneration++;
    unsubscribe();
    if (timer) clearTimeout(timer);
    watcher?.close();
    stopBoardWatcher();
    bindings.delete(context);
    if (attachedProjectRoot && registeredSessionId) {
      releaseActiveSessionBoard(attachedProjectRoot, registeredSessionId);
      fireAndForget(
        'cleanup-board',
        cleanupSessionKanbanBoardIfEmpty(attachedProjectRoot, registeredSessionId),
      );
      registeredSessionId = '';
    }
  };
  bindings.set(context, detach);
  return detach;
}

export async function rebindSessionKanbanTask(
  context: Context,
): Promise<{ boardId: string; taskId: string } | null> {
  const sessionId = context.session?.id;
  if (!sessionId || !context.projectRoot) return null;
  if (context.currentKanbanTaskId) return null;
  const projectRoot = context.projectRoot;
  const initialBoardId = context.currentKanbanBoardId;

  let best: { boardId: string; taskId: string; lastSeenAt: string } | undefined;
  try {
    const snapshot = await getKanbanOrchestrationSnapshot(projectRoot);
    const nowMs = Date.now();
    for (const result of snapshot.running) {
      const assignment = result.task.assignment;
      if (assignment?.status !== 'running') continue;
      const expiresAt = assignment.leaseExpiresAt
        ? Date.parse(assignment.leaseExpiresAt)
        : Number.NaN;
      if (Number.isFinite(expiresAt) && expiresAt <= nowMs) continue;
      const entry = result.board.presence?.find(
        (candidate) => candidate.sessionId === sessionId && candidate.taskId === result.task.id,
      );
      if (!entry) continue;
      if (!best || entry.lastSeenAt > best.lastSeenAt) {
        best = { boardId: result.board.id, taskId: result.task.id, lastSeenAt: entry.lastSeenAt };
      }
    }
  } catch {
    return null;
  }
  if (!best) return null;
  if (
    context.session?.id !== sessionId ||
    context.projectRoot !== projectRoot ||
    context.currentKanbanTaskId ||
    context.currentKanbanBoardId !== initialBoardId
  )
    return null;
  context.setCurrentKanbanTask?.(best.taskId, best.boardId);
  return { boardId: best.boardId, taskId: best.taskId };
}

let degradationReason: string | undefined;

export function sessionKanbanDegradation(): string | undefined {
  return degradationReason;
}

export async function hydrateSessionKanban(context: Context): Promise<KanbanBoard | null> {
  const id = context.session?.id ?? '';
  if (!id) return null;
  try {
    const board = await hydrateSessionKanbanBoard(context, id);
    degradationReason = undefined;
    return board;
  } catch (error) {
    degradationReason = error instanceof Error ? error.message : String(error);
    fireAndForget('hydrate', Promise.reject(error));
    return null;
  }
}

async function hydrateSessionKanbanBoard(
  context: Context,
  id: string,
): Promise<KanbanBoard | null> {
  await rebindSessionKanbanTask(context);
  await cleanupEmptySessionKanbanBoards(context.projectRoot, id);
  if (context.projectRoot) {
    fireAndForget('prune-session-boards', pruneSessionBoards(context.projectRoot));
  }
  let board = await ensureSessionKanbanBoard(context.projectRoot, id);
  if (context.todos?.length) {
    board = await projectSessionTodosToKanban(context.projectRoot, context.todos, id);
  }
  const planPath = context.meta?.['plan.path.resolved'] ?? context.meta?.['plan.path'];
  if (typeof planPath === 'string' && planPath) {
    const plan = await loadPlan(planPath);
    if (plan) board = await projectSessionPlanToKanban(context.projectRoot, plan.items, id);
  }
  const taskPath = context.meta?.['task.path.resolved'] ?? context.meta?.['task.path'];
  if (typeof taskPath === 'string' && taskPath) {
    const tasks = await loadTasks(taskPath);
    if (tasks) board = await projectSessionTasksToKanban(context.projectRoot, tasks.tasks, id);
  }
  return board;
}

export function applySessionKanbanBoardToTodos(context: Context, board: KanbanBoard): TodoItem[] {
  return applySessionKanbanBoardToTodosSync(context, board, {
    sessionIdFromTags,
    isOwnedSessionBoard,
    hasInFlightTodoMirror,
    suppressedTodoMirrors,
  });
}

export function applyManagedKanbanBoardToTodos(
  context: Context,
  board: KanbanBoard,
  sourceTodos: readonly TodoItem[] = context.todos,
): TodoItem[] {
  return applyManagedKanbanBoardToTodosSync(context, board, suppressedTodoMirrors, {
    sessionOwnerFromTags: sessionIdFromTags,
    sourceTodos,
  });
}

export function applySessionKanbanTaskToSource(
  context: Context,
  task: KanbanTask,
  options: { remove?: boolean | undefined } = {},
): Promise<SessionKanbanSourceUpdate> {
  return applySessionKanbanTaskToSourceSync(context, task, suppressedTodoMirrors, options);
}
