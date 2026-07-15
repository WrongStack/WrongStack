import { type FSWatcher, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  type Context,
  deserializeTaskGraph,
  loadPlan,
  loadTasks,
  mutatePlan,
  mutateTasks,
  type PlanFile,
  type PlanItem,
  type SerializedTaskGraph,
  type TaskFile,
  type TaskItem,
  type TaskStatus,
  type TodoItem,
} from '@wrongstack/core';
import {
  createBoard,
  getBoard,
  type KanbanBoard,
  type KanbanColumn,
  type KanbanTask,
  listBoards,
  removeBoard,
  syncBoardFromTaskGraph,
  updateBoard,
} from '@wrongstack/kanban';

const SESSION_BOARD_TAG = 'session-work';
const MIRROR_DISABLED_ENV = 'WRONGSTACK_KANBAN_TASK_MIRROR';

/** The canonical workflow shared by WebUI and TUI session boards. */
export const SESSION_KANBAN_COLUMNS: KanbanColumn[] = [
  { id: 'todo', title: 'Todo', order: 0, wipLimit: 0, color: '#2563eb' },
  { id: 'in-progress', title: 'Running', order: 1, wipLimit: 1, color: '#d97706' },
  { id: 'review', title: 'Preview', order: 2, wipLimit: 0, color: '#7c3aed' },
  { id: 'done', title: 'Done', order: 3, wipLimit: 0, color: '#16a34a' },
];

const boardQueue = new Map<string, Promise<void>>();
const boardEnsures = new Map<string, Promise<KanbanBoard>>();
const bindings = new WeakMap<Context, () => void>();
const suppressedTodoMirrors = new WeakSet<Context>();
const activeSessionBoards = new Map<string, number>();

function boardKey(projectRoot: string, sessionId: string): string {
  return `${projectRoot}\0${sessionId}`;
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

/** Create (or migrate) the single Kanban board owned by a session. */
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
      });
    }

    // Boards produced by the older task/plan mirrors used the generic five
    // columns. Migrate only session-owned boards; updateBoard reconciles cards
    // from Backlog into Todo while preserving Running/Preview/Done cards.
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

/** Remove a particular inactive session's system-owned board when it has no cards. */
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

/** Prune stale empty session boards while preserving manual and live boards. */
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
      },
    );
    return result?.board ?? null;
  });
}

export function todoListToSerializedGraph(
  todos: readonly TodoItem[],
  sessionId: string,
): SerializedTaskGraph {
  const nodes = todos.map((todo, index) => ({
    id: todo.id,
    title: todo.content,
    description: todo.activeForm ?? '',
    type: 'chore' as const,
    priority: 'medium' as const,
    status: todo.status,
    createdAt: index,
    updatedAt: index,
  }));
  return {
    id: `todo:${sessionId}`,
    specId: `todo:${sessionId}`,
    title: 'Session todos',
    nodes,
    edges: [],
    rootNodes: nodes.map((node) => node.id),
    createdAt: 0,
    updatedAt: 0,
  };
}

export function taskFileToSerializedGraph(
  tasks: readonly TaskItem[],
  sessionId: string,
): SerializedTaskGraph {
  const ids = new Set(tasks.map((task) => task.id));
  const nodes = tasks.map((task, index) => ({
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    type: task.type,
    priority: task.priority,
    status: task.status,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    ...(task.estimateHours !== undefined ? { estimateHours: task.estimateHours } : {}),
    createdAt: index,
    updatedAt: index,
  }));
  const edges = tasks.flatMap((task) =>
    (task.dependsOn ?? [])
      .filter((dependency) => ids.has(dependency))
      .map((dependency) => ({
        id: `${dependency}->${task.id}`,
        from: dependency,
        to: task.id,
        type: 'depends_on' as const,
      })),
  );
  const hasIncoming = new Set(edges.map((edge) => edge.to));
  const rootNodes = nodes.filter((node) => !hasIncoming.has(node.id)).map((node) => node.id);
  return {
    // Keep the historical graph id so existing mirrored task cards are reused.
    id: `session:${sessionId}`,
    specId: `session:${sessionId}`,
    title: 'Session tasks',
    nodes,
    edges,
    rootNodes: rootNodes.length ? rootNodes : nodes[0] ? [nodes[0].id] : [],
    createdAt: 0,
    updatedAt: 0,
  };
}

const PLAN_STATUS_TO_TASK: Record<PlanItem['status'], TaskStatus> = {
  open: 'pending',
  in_progress: 'in_progress',
  done: 'completed',
};

export function planFileToSerializedGraph(
  items: readonly PlanItem[],
  sessionId: string,
): SerializedTaskGraph {
  const nodes = items.map((item, index) => ({
    id: item.id,
    title: item.title,
    description: item.details ?? '',
    type: 'chore' as const,
    priority: 'medium' as const,
    status: PLAN_STATUS_TO_TASK[item.status],
    createdAt: index,
    updatedAt: index,
  }));
  return {
    id: `plan:${sessionId}`,
    specId: `plan:${sessionId}`,
    title: 'Session plan',
    nodes,
    edges: [],
    rootNodes: nodes.map((node) => node.id),
    createdAt: 0,
    updatedAt: 0,
  };
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

function fireAndForget(work: Promise<unknown>): void {
  void work.catch(() => {
    // The session files/state remain recoverable if the observational board
    // cannot be written; the next mutation or file watcher retries the mirror.
  });
}

export function mirrorSessionTodosToKanban(
  projectRoot: string | undefined,
  todos: readonly TodoItem[],
  sessionId: string,
): void {
  fireAndForget(projectSessionTodosToKanban(projectRoot, todos, sessionId));
}

export function mirrorSessionTasksToKanban(
  projectRoot: string | undefined,
  tasks: readonly TaskItem[],
  sessionId: string,
): void {
  fireAndForget(projectSessionTasksToKanban(projectRoot, tasks, sessionId));
}

export function mirrorSessionPlanToKanban(
  projectRoot: string | undefined,
  items: readonly PlanItem[],
  sessionId: string,
): void {
  fireAndForget(projectSessionPlanToKanban(projectRoot, items, sessionId));
}

/**
 * Bind all live session work paths to Kanban. Todo changes are observed from
 * ConversationState; plan/task sidecars are watched so slash commands, WebUI,
 * plugins, and tools all pass through the same board.
 */
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
      fireAndForget(cleanupSessionKanbanBoardIfEmpty(attachedProjectRoot, registeredSessionId));
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

  const sessionId = () => context.session?.id ?? '';
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
        timer = setTimeout(() => fireAndForget(refreshFiles()), 60);
      });
      watcher.on('error', () => watcher?.close());
    } catch {
      // The session directory can briefly disappear during project/session
      // switches; the next meta update re-attempts the binding.
      watcher = null;
      watchedDir = '';
    }
  };

  const unsubscribe = context.state.onChange((change) => {
    if (change.kind === 'todos_replaced' && !suppressedTodoMirrors.has(context)) {
      // ConversationState auto-clears an all-done tactical list. Project the
      // pre-clear completion snapshot so every card reaches Done atomically.
      mirrorSessionTodosToKanban(
        context.projectRoot,
        change.completedSnapshot ?? change.todos,
        sessionId(),
      );
      return;
    }
    if (change.kind === 'meta_set' && (change.key === 'plan.path' || change.key === 'task.path')) {
      syncActiveSessionRegistration();
      configureWatcher();
      fireAndForget(ensureSessionKanbanBoard(context.projectRoot, sessionId()));
      fireAndForget(refreshFiles());
    }
  });

  configureWatcher();

  const detach = () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    watcher?.close();
    bindings.delete(context);
    if (attachedProjectRoot && registeredSessionId) {
      releaseActiveSessionBoard(attachedProjectRoot, registeredSessionId);
      fireAndForget(cleanupSessionKanbanBoardIfEmpty(attachedProjectRoot, registeredSessionId));
      registeredSessionId = '';
    }
  };
  bindings.set(context, detach);
  return detach;
}

/** Fully hydrate a session board before a host announces the session as ready. */
export async function hydrateSessionKanban(context: Context): Promise<KanbanBoard | null> {
  const id = context.session?.id ?? '';
  if (!id) return null;
  await cleanupEmptySessionKanbanBoards(context.projectRoot, id);
  let board = await ensureSessionKanbanBoard(context.projectRoot, id);
  if (context.todos.length) {
    board = await projectSessionTodosToKanban(context.projectRoot, context.todos, id);
  }
  const planPath = context.meta['plan.path'];
  if (typeof planPath === 'string' && planPath) {
    const plan = await loadPlan(planPath);
    if (plan) board = await projectSessionPlanToKanban(context.projectRoot, plan.items, id);
  }
  const taskPath = context.meta['task.path'];
  if (typeof taskPath === 'string' && taskPath) {
    const tasks = await loadTasks(taskPath);
    if (tasks) board = await projectSessionTasksToKanban(context.projectRoot, tasks.tasks, id);
  }
  return board;
}

export interface SessionKanbanSourceUpdate {
  source: 'todo' | 'task' | 'plan' | null;
  todos?: TodoItem[] | undefined;
  tasks?: TaskFile | undefined;
  plan?: PlanFile | undefined;
}

function sourceStatus(task: KanbanTask): TaskStatus {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'in_progress') return 'in_progress';
  if (task.status === 'review') return 'review';
  if (task.status === 'blocked') return 'blocked';
  if (task.status === 'failed') return 'failed';
  return 'pending';
}

/** Reflect a TUI/WebUI Kanban card edit back to its originating work list. */
export async function applySessionKanbanTaskToSource(
  context: Context,
  task: KanbanTask,
  options: { remove?: boolean | undefined } = {},
): Promise<SessionKanbanSourceUpdate> {
  const originId = task.origin?.taskId;
  const graphId = task.origin?.graphId ?? '';
  if (!originId) return { source: null };

  if (task.origin?.system === 'session-todo' || graphId.startsWith('todo:')) {
    const next = options.remove
      ? context.todos.filter((todo) => todo.id !== originId)
      : context.todos.map((todo) =>
          todo.id === originId
            ? {
                ...todo,
                content: task.title,
                status:
                  sourceStatus(task) === 'completed'
                    ? ('completed' as const)
                    : sourceStatus(task) === 'in_progress' || sourceStatus(task) === 'review'
                      ? ('in_progress' as const)
                      : ('pending' as const),
              }
            : todo,
        );
    suppressedTodoMirrors.add(context);
    try {
      context.state.replaceTodos(next);
    } finally {
      suppressedTodoMirrors.delete(context);
    }
    return { source: 'todo', todos: [...context.todos] };
  }

  const id = context.session?.id ?? '';
  if (task.origin?.system === 'session-plan' || graphId.startsWith('plan:')) {
    const planPath = context.meta['plan.path'];
    if (typeof planPath !== 'string' || !planPath) return { source: 'plan' };
    const plan = await mutatePlan(planPath, id, (file) => ({
      ...file,
      updatedAt: new Date().toISOString(),
      items: options.remove
        ? file.items.filter((item) => item.id !== originId)
        : file.items.map((item) =>
            item.id === originId
              ? {
                  ...item,
                  title: task.title,
                  details: task.description,
                  status:
                    task.status === 'completed'
                      ? ('done' as const)
                      : task.status === 'in_progress' || task.status === 'review'
                        ? ('in_progress' as const)
                        : ('open' as const),
                  updatedAt: new Date().toISOString(),
                }
              : item,
          ),
    }));
    return { source: 'plan', plan };
  }

  if (
    task.origin?.system === 'session-task' ||
    task.origin?.system === 'session' ||
    graphId.startsWith('session:')
  ) {
    const taskPath = context.meta['task.path'];
    if (typeof taskPath !== 'string' || !taskPath) return { source: 'task' };
    const tasks = await mutateTasks(taskPath, id, (file) => ({
      ...file,
      tasks: options.remove
        ? file.tasks.filter((item) => item.id !== originId)
        : file.tasks.map((item) =>
            item.id === originId
              ? {
                  ...item,
                  title: task.title,
                  description: task.description,
                  status: sourceStatus(task),
                  updatedAt: new Date().toISOString(),
                }
              : item,
          ),
    }));
    return { source: 'task', tasks };
  }

  return { source: null };
}
