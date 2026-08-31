import { type FSWatcher, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Context, TodoItem } from '@wrongstack/core/agent';
import { loadPlan, loadTasks, type PlanItem } from '@wrongstack/core/storage';
import { deserializeTaskGraph } from '@wrongstack/core/tasking';
import type { SerializedTaskGraph } from '@wrongstack/core/types';
import type { TaskItem } from '@wrongstack/core/utils';
import {
  bridgeKanbanSupervisor,
  compactSessionMirrorBoard,
  createBoard,
  DEFAULT_COLUMNS,
  getBoard,
  getKanbanOrchestrationSnapshot,
  type KanbanBoard,
  type KanbanColumn,
  type KanbanTask,
  listBoards,
  pruneSessionBoards,
  removeBoard,
  syncBoardFromTaskGraph,
  touchKanbanPresence,
  updateBoard,
} from '@wrongstack/kanban';
import {
  planFileToSerializedGraph,
  taskFileToSerializedGraph,
  todoListToSerializedGraph,
} from './session-kanban-graph.js';
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

const SESSION_BOARD_TAG = 'session-work';
const MIRROR_DISABLED_ENV = 'WRONGSTACK_KANBAN_TASK_MIRROR';

export const SESSION_KANBAN_COLUMNS: KanbanColumn[] = DEFAULT_COLUMNS.map((column) => ({
  ...column,
}));

const boardQueue = new Map<string, Promise<void>>();
const boardEnsures = new Map<string, Promise<KanbanBoard>>();
type PendingMirror = {
  projectRoot: string;
  sessionId: string;
  graph: SerializedTaskGraph;
  reconciliationGraph?: SerializedTaskGraph | undefined;
  sourceSystem: 'session-todo' | 'session-task' | 'session-plan';
};
const pendingMirrors = new Map<string, PendingMirror>();
const activeMirrors = new Set<string>();
const mirrorFailures = new Map<
  string,
  { message: string; sourceSystem: PendingMirror['sourceSystem'] }
>();
const bindings = new WeakMap<Context, () => void>();
const suppressedTodoMirrors = new WeakSet<Context>();
const activeSessionBoards = new Map<string, number>();

function boardKey(projectRoot: string, sessionId: string): string {
  return `${projectRoot}\0${sessionId}`;
}

function mirrorKey(
  projectRoot: string,
  sessionId: string,
  sourceSystem: PendingMirror['sourceSystem'],
): string {
  return `${boardKey(projectRoot, sessionId)}\0${sourceSystem}`;
}

function completedReconciliationGraph(
  latest: SerializedTaskGraph,
  candidates: readonly SerializedTaskGraph[],
): SerializedTaskGraph | undefined {
  const latestNodeIds = new Set(latest.nodes.map((node) => node.id));
  const carriedNodeIds = new Set<string>();
  const completedNodes = candidates.flatMap((candidate) =>
    candidate.nodes.filter((node) => {
      if (
        node.status !== 'completed' ||
        latestNodeIds.has(node.id) ||
        carriedNodeIds.has(node.id)
      ) {
        return false;
      }
      carriedNodeIds.add(node.id);
      return true;
    }),
  );
  if (completedNodes.length === 0) return undefined;

  const carriedRequirements = completedNodes.flatMap((node) =>
    node.specRequirementId ? [node.specRequirementId] : [],
  );
  return {
    ...latest,
    nodes: [...latest.nodes, ...completedNodes],
    rootNodes: [...new Set([...latest.rootNodes, ...completedNodes.map((node) => node.id)])],
    ...(latest.requiredRequirementIds
      ? {
          requiredRequirementIds: [
            ...new Set([...latest.requiredRequirementIds, ...carriedRequirements]),
          ],
        }
      : {}),
  };
}

function sessionTag(sessionId: string): string {
  return `session:${sessionId}`;
}

function sessionBoardTitle(sessionId: string): string {
  const leaf = sessionId.split(/[\\/]/).filter(Boolean).pop() ?? sessionId;
  return `Session ${leaf.slice(0, 12)}`;
}

function sessionBoardTags(sessionId: string): string[] {
  return ['session', SESSION_BOARD_TAG, sessionTag(sessionId)];
}

function sessionIdFromTags(tags: readonly string[] | undefined): string | null {
  const tag = tags?.find((candidate) => candidate.startsWith('session:'));
  return tag?.slice('session:'.length) || null;
}

function isOwnedSessionBoard(tags: readonly string[] | undefined): boolean {
  return Boolean(tags?.includes(SESSION_BOARD_TAG) && sessionIdFromTags(tags));
}

function retainActiveSessionBoard(projectRoot: string, sessionId: string): void {
  const key = boardKey(projectRoot, sessionId);
  activeSessionBoards.set(key, (activeSessionBoards.get(key) ?? 0) + 1);
}

function releaseActiveSessionBoard(projectRoot: string, sessionId: string): void {
  const key = boardKey(projectRoot, sessionId);
  const remaining = (activeSessionBoards.get(key) ?? 0) - 1;
  if (remaining > 0) activeSessionBoards.set(key, remaining);
  else activeSessionBoards.delete(key);
}

function isSessionBoardActive(projectRoot: string, sessionId: string): boolean {
  return (activeSessionBoards.get(boardKey(projectRoot, sessionId)) ?? 0) > 0;
}

function sameColumns(columns: readonly KanbanColumn[]): boolean {
  return (
    columns.length === SESSION_KANBAN_COLUMNS.length &&
    columns.every((column, index) => column.id === SESSION_KANBAN_COLUMNS[index]?.id)
  );
}

export async function ensureSessionKanbanBoard(
  projectRoot: string | undefined,
  sessionId: string,
): Promise<KanbanBoard | null> {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return null;
  const key = boardKey(projectRoot, sessionId);
  const inFlight = boardEnsures.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const summary = (await listBoards(projectRoot)).find((board) =>
      board.tags?.includes(sessionTag(sessionId)),
    );
    let board = summary ? await getBoard(projectRoot, summary.id) : null;
    if (!board) {
      return createBoard(projectRoot, {
        title: sessionBoardTitle(sessionId),
        description: 'Live session work: todos, tasks, and plan items.',
        tags: sessionBoardTags(sessionId),
        columns: SESSION_KANBAN_COLUMNS,
        generatedBy: `session-kanban:${sessionId}`,
        kind: 'session_mirror' as const,
        retention: { mode: 'archive_after_ttl' as const, ttlMs: 7 * 24 * 60 * 60 * 1000 },
      });
    }

    if (!sameColumns(board.columns) || !board.tags?.includes(SESSION_BOARD_TAG)) {
      board =
        (await updateBoard(projectRoot, board.id, {
          title: sessionBoardTitle(sessionId),
          description: 'Live session work: todos, tasks, and plan items.',
          tags: [...new Set([...(board.tags ?? []), ...sessionBoardTags(sessionId)])],
          columns: SESSION_KANBAN_COLUMNS,
        })) ?? board;
    }
    return board;
  })();

  boardEnsures.set(key, promise);
  try {
    return await promise;
  } finally {
    boardEnsures.delete(key);
  }
}

function enqueueBoardWork<T>(
  projectRoot: string,
  sessionId: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = boardKey(projectRoot, sessionId);
  const previous = boardQueue.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(work);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  boardQueue.set(key, tail);
  void tail.then(() => {
    if (boardQueue.get(key) === tail) boardQueue.delete(key);
  });
  return result;
}

async function removeEmptySessionBoard(
  projectRoot: string,
  boardId: string,
  sessionId: string,
): Promise<string | null> {
  return enqueueBoardWork(projectRoot, sessionId, async () => {
    if (isSessionBoardActive(projectRoot, sessionId)) return null;
    const board = await getBoard(projectRoot, boardId);
    if (!board || board.tasks.length > 0 || !isOwnedSessionBoard(board.tags)) return null;
    if (sessionIdFromTags(board.tags) !== sessionId) return null;
    return (await removeBoard(projectRoot, board.id)) ? board.id : null;
  });
}

async function removeOwnedSessionBoard(
  projectRoot: string,
  boardId: string,
  sessionId: string,
): Promise<string | null> {
  return enqueueBoardWork(projectRoot, sessionId, async () => {
    if (isSessionBoardActive(projectRoot, sessionId)) return null;
    const board = await getBoard(projectRoot, boardId);
    if (!board || !isOwnedSessionBoard(board.tags)) return null;
    if (sessionIdFromTags(board.tags) !== sessionId) return null;
    return (await removeBoard(projectRoot, board.id)) ? board.id : null;
  });
}

export async function cleanupSessionKanbanBoard(
  projectRoot: string | undefined,
  sessionId: string,
): Promise<string[]> {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return [];
  if (isSessionBoardActive(projectRoot, sessionId)) return [];
  const candidates = (await listBoards(projectRoot)).filter(
    (board) => isOwnedSessionBoard(board.tags) && sessionIdFromTags(board.tags) === sessionId,
  );
  const removed = await Promise.all(
    candidates.map((board) => removeOwnedSessionBoard(projectRoot, board.id, sessionId)),
  );
  return removed.filter((boardId): boardId is string => Boolean(boardId));
}

export async function cleanupSessionKanbanBoardIfEmpty(
  projectRoot: string | undefined,
  sessionId: string,
): Promise<string[]> {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return [];
  if (isSessionBoardActive(projectRoot, sessionId)) return [];
  const candidates = (await listBoards(projectRoot)).filter(
    (board) =>
      board.taskCount === 0 &&
      isOwnedSessionBoard(board.tags) &&
      sessionIdFromTags(board.tags) === sessionId,
  );
  const removed = await Promise.all(
    candidates.map((board) => removeEmptySessionBoard(projectRoot, board.id, sessionId)),
  );
  return removed.filter((boardId): boardId is string => Boolean(boardId));
}

export async function cleanupEmptySessionKanbanBoards(
  projectRoot: string | undefined,
  activeSessionId = '',
): Promise<string[]> {
  if (!projectRoot || process.env[MIRROR_DISABLED_ENV] === '0') return [];
  const candidates = (await listBoards(projectRoot)).flatMap((board) => {
    const ownerSessionId = sessionIdFromTags(board.tags);
    return board.taskCount === 0 &&
      isOwnedSessionBoard(board.tags) &&
      ownerSessionId &&
      ownerSessionId !== activeSessionId &&
      !isSessionBoardActive(projectRoot, ownerSessionId)
      ? [{ boardId: board.id, sessionId: ownerSessionId }]
      : [];
  });
  const removed = await Promise.all(
    candidates.map(({ boardId, sessionId }) =>
      removeEmptySessionBoard(projectRoot, boardId, sessionId),
    ),
  );
  return removed.filter((boardId): boardId is string => Boolean(boardId));
}

async function projectGraph(
  projectRoot: string | undefined,
  sessionId: string,
  graph: SerializedTaskGraph,
  sourceSystem: 'session-todo' | 'session-task' | 'session-plan',
): Promise<KanbanBoard | null> {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return null;
  return enqueueBoardWork(projectRoot, sessionId, async () => {
    const board = await ensureSessionKanbanBoard(projectRoot, sessionId);
    if (!board) return null;
    const result = await syncBoardFromTaskGraph(
      projectRoot,
      board.id,
      deserializeTaskGraph(graph),
      {
        sourceSystem,
        tags: [...new Set([...(board.tags ?? []), ...sessionBoardTags(sessionId)])],
        archiveMissingTasks: true,
        includeCompletedTasks: true,
        allowRequirementScopeShrink: true,
      },
    );
    if (!result) return null;
    const compacted = await compactSessionMirrorBoard(projectRoot, board.id);
    if (compacted?.removedTaskIds.length) {
      return (await getBoard(projectRoot, board.id)) ?? result.board;
    }
    return result.board;
  });
}

function queueLatestMirror(
  projectRoot: string | undefined,
  sessionId: string,
  graph: SerializedTaskGraph,
  sourceSystem: PendingMirror['sourceSystem'],
): void {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return;
  const key = mirrorKey(projectRoot, sessionId, sourceSystem);
  const previous = pendingMirrors.get(key);
  const reconciliationGraph = previous
    ? completedReconciliationGraph(
        graph,
        [previous.reconciliationGraph, previous.graph].filter(
          (candidate): candidate is SerializedTaskGraph => candidate !== undefined,
        ),
      )
    : undefined;
  pendingMirrors.set(key, {
    projectRoot,
    sessionId,
    graph,
    ...(reconciliationGraph ? { reconciliationGraph } : {}),
    sourceSystem,
  });
  if (activeMirrors.has(key)) return;
  activeMirrors.add(key);
  void (async () => {
    try {
      for (;;) {
        const pending = pendingMirrors.get(key);
        if (!pending) break;
        pendingMirrors.delete(key);
        try {
          if (pending.reconciliationGraph) {
            await projectGraph(
              pending.projectRoot,
              pending.sessionId,
              pending.reconciliationGraph,
              pending.sourceSystem,
            );
          }
          await projectGraph(
            pending.projectRoot,
            pending.sessionId,
            pending.graph,
            pending.sourceSystem,
          );
          mirrorFailures.delete(boardKey(pending.projectRoot, pending.sessionId));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          mirrorFailures.set(boardKey(pending.projectRoot, pending.sessionId), {
            message,
            sourceSystem: pending.sourceSystem,
          });
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'session-kanban.mirror-failed',
              sessionId: pending.sessionId,
              sourceSystem: pending.sourceSystem,
              message,
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }
    } finally {
      activeMirrors.delete(key);
      const pending = pendingMirrors.get(key);
      if (pending) {
        pendingMirrors.delete(key);
        queueLatestMirror(
          pending.projectRoot,
          pending.sessionId,
          pending.graph,
          pending.sourceSystem,
        );
      }
    }
  })();
}

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

function fireAndForget(context: string, work: Promise<unknown>): void {
  void work.catch((err: unknown) => {
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
  });
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
        cleanupSessionKanbanBoard(attachedProjectRoot, registeredSessionId),
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
  const refreshFiles = async () => {
    const id = sessionId();
    if (!id) return;
    const planPath = context.meta['plan.path'];
    if (typeof planPath === 'string' && planPath) {
      const plan = await loadPlan(planPath);
      if (plan) await projectSessionPlanToKanban(context.projectRoot, plan.items, id);
    }
    const taskPath = context.meta['task.path'];
    if (typeof taskPath === 'string' && taskPath) {
      const tasks = await loadTasks(taskPath);
      if (tasks) await projectSessionTasksToKanban(context.projectRoot, tasks.tasks, id);
    }
  };

  const refreshBoard = async () => {
    if (!watchedBoardId) return;
    const board = await getBoard(context.projectRoot, watchedBoardId);
    if (!board) return;
    if (board.lifecycle?.mode === 'managed') applyManagedKanbanBoardToTodos(context, board);
    else applySessionKanbanBoardToTodos(context, board);
  };

  const configureBoardWatcher = async () => {
    const id = sessionId();
    const managedBoardId = activeManagedBoardId();
    const board = managedBoardId
      ? await getBoard(context.projectRoot, managedBoardId)
      : id
        ? await ensureSessionKanbanBoard(context.projectRoot, id)
        : null;
    if (!board) return;
    if (board.id === watchedBoardId) {
      await refreshBoard();
      return;
    }
    unsubscribeBoardEvents?.();
    unsubscribeBoardEvents = null;
    watchedBoardId = board.id;
    try {
      unsubscribeBoardEvents = bridgeKanbanSupervisor(
        context.projectRoot,
        (event) => {
          const data = event.data as { boardId?: string } | undefined;
          if (data?.boardId !== board.id) return;
          if (boardTimer) clearTimeout(boardTimer);
          boardTimer = setTimeout(() => fireAndForget('refresh-board', refreshBoard()), 60);
        },
        { autoReconnect: true, reconnectDelayMs: 1_000 },
      );
      const touchPresence = () =>
        touchKanbanPresence(context.projectRoot, board.id, {
          sessionId: id,
          agentId: context.agentId,
          agentName: context.agentName,
        });
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
    const planPath = context.meta['plan.path'];
    const taskPath = context.meta['task.path'];
    const candidate =
      typeof planPath === 'string' && planPath
        ? dirname(planPath)
        : typeof taskPath === 'string' && taskPath
          ? dirname(taskPath)
          : '';
    if (!candidate || candidate === watchedDir) return;
    watcher?.close();
    watcher = null;
    watchedDir = candidate;
    try {
      watcher = watch(candidate, { persistent: false }, (_event, filename) => {
        const name = filename?.toString();
        const currentPlanPath = context.meta['plan.path'];
        const currentTaskPath = context.meta['task.path'];
        const planName = typeof currentPlanPath === 'string' ? basename(currentPlanPath) : '';
        const taskName = typeof currentTaskPath === 'string' ? basename(currentTaskPath) : '';
        if (name && name !== planName && name !== taskName) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fireAndForget('refresh-files', refreshFiles()), 60);
      });
      watcher.on('error', () => watcher?.close());
    } catch {
      watcher = null;
      watchedDir = '';
    }
  };

  const unsubscribe = context.state.onChange((change) => {
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
    unsubscribe();
    if (timer) clearTimeout(timer);
    if (boardTimer) clearTimeout(boardTimer);
    if (presenceTimer) clearInterval(presenceTimer);
    watcher?.close();
    unsubscribeBoardEvents?.();
    bindings.delete(context);
    if (attachedProjectRoot && registeredSessionId) {
      releaseActiveSessionBoard(attachedProjectRoot, registeredSessionId);
      fireAndForget(
        'cleanup-board',
        cleanupSessionKanbanBoard(attachedProjectRoot, registeredSessionId),
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

  let best: { boardId: string; taskId: string; lastSeenAt: string } | undefined;
  try {
    const snapshot = await getKanbanOrchestrationSnapshot(context.projectRoot);
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
  const planPath = context.meta?.['plan.path'];
  if (typeof planPath === 'string' && planPath) {
    const plan = await loadPlan(planPath);
    if (plan) board = await projectSessionPlanToKanban(context.projectRoot, plan.items, id);
  }
  const taskPath = context.meta?.['task.path'];
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

export function applyManagedKanbanBoardToTodos(context: Context, board: KanbanBoard): TodoItem[] {
  return applyManagedKanbanBoardToTodosSync(context, board, suppressedTodoMirrors, {
    sessionOwnerFromTags: sessionIdFromTags,
  });
}

export function applySessionKanbanTaskToSource(
  context: Context,
  task: KanbanTask,
  options: { remove?: boolean | undefined } = {},
): Promise<SessionKanbanSourceUpdate> {
  return applySessionKanbanTaskToSourceSync(context, task, suppressedTodoMirrors, options);
}
