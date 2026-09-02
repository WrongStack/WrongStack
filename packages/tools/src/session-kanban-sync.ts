import type { Context, TodoItem } from '@wrongstack/core/agent';
import { getSharedProjectMailbox } from '@wrongstack/core/coordination';
import { mutatePlan, mutateTasks, type PlanFile, type TaskFile } from '@wrongstack/core/storage';
import type { TaskStatus } from '@wrongstack/core/types';
import { formatTodosForModel, resolveWstackPaths } from '@wrongstack/core/utils';
import {
  getDependencyReadinessIssues,
  type KanbanBoard,
  type KanbanTask,
} from '@wrongstack/kanban';

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

export function todoStatus(task: KanbanTask): TodoItem['status'] {
  const status = sourceStatus(task);
  if (status === 'completed') return 'completed';
  if (status === 'review' && task.assignment?.status === 'completed') return 'completed';
  if (status === 'in_progress' || status === 'review') return 'in_progress';
  return 'pending';
}

function sessionTodoFromTask(task: KanbanTask, board?: KanbanBoard): TodoItem {
  const blockedBy = board ? blockingTitles(board, task) : [];
  return {
    id: task.origin?.taskId ?? task.id,
    content: task.title,
    status: todoStatus(task),
    ...(task.description ? { activeForm: task.description } : {}),
    ...(blockedBy.length ? { blockedBy } : {}),
  };
}

function managedTodoFromTask(task: KanbanTask, board: KanbanBoard): TodoItem {
  return {
    ...sessionTodoFromTask(task, board),
    kanbanBoardId: board.id,
    kanbanTaskId: task.id,
  };
}

export function blockingTitles(board: KanbanBoard, task: KanbanTask): string[] {
  return getDependencyReadinessIssues(board, task).map((issue) => {
    const dependency = board.tasks.find((candidate) => candidate.id === issue.dependencyId);
    if (!dependency) return `${issue.dependencyId} (missing)`;
    return dependency.title;
  });
}

const PRIORITY_ORDER: Readonly<Record<string, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function orderTasksForTodos(board: KanbanBoard, tasks: readonly KanbanTask[]): KanbanTask[] {
  const columnOrder = new Map(board.columns.map((column) => [column.id, column.order]));
  const baseline = [...tasks].sort(
    (left, right) =>
      (columnOrder.get(left.columnId) ?? 0) - (columnOrder.get(right.columnId) ?? 0) ||
      (PRIORITY_ORDER[left.priority] ?? 2) - (PRIORITY_ORDER[right.priority] ?? 2) ||
      left.order - right.order ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );

  const included = new Set(baseline.map((task) => task.id));
  const remaining = new Map(baseline.map((task) => [task.id, task]));
  const emitted: KanbanTask[] = [];
  const done = new Set<string>();

  while (remaining.size > 0) {
    const ready = baseline.filter(
      (task) =>
        remaining.has(task.id) &&
        (task.dependsOn ?? []).every(
          (dependencyId) => !included.has(dependencyId) || done.has(dependencyId),
        ),
    );
    if (ready.length === 0) break;
    for (const task of ready) {
      remaining.delete(task.id);
      done.add(task.id);
      emitted.push(task);
    }
  }
  for (const task of baseline) if (remaining.has(task.id)) emitted.push(task);
  return emitted;
}

function sameTodos(left: readonly TodoItem[], right: readonly TodoItem[]): boolean {
  return (
    left.length === right.length &&
    left.every((todo, index) => {
      const candidate = right[index];
      return (
        candidate?.id === todo.id &&
        candidate.content === todo.content &&
        candidate.status === todo.status &&
        candidate.activeForm === todo.activeForm &&
        candidate.promotedFromPlan === todo.promotedFromPlan &&
        candidate.promotedFromTask === todo.promotedFromTask &&
        candidate.kanbanBoardId === todo.kanbanBoardId &&
        candidate.kanbanTaskId === todo.kanbanTaskId &&
        (candidate.blockedBy ?? []).join('\u0000') === (todo.blockedBy ?? []).join('\u0000')
      );
    })
  );
}

export function broadcastTodoUpdate(context: Context, todos: readonly TodoItem[]): void {
  const sessionId = context.session?.id ?? '';
  if (!context.agentId || !sessionId) return;
  const statusCounts = { pending: 0, inProgress: 0, completed: 0 };
  for (const todo of todos) {
    if (todo.status === 'completed') statusCounts.completed++;
    else if (todo.status === 'in_progress') statusCounts.inProgress++;
    else statusCounts.pending++;
  }
  const projectDir = resolveWstackPaths({ projectRoot: context.projectRoot }).projectDir;
  const mailbox = getSharedProjectMailbox(projectDir);
  // Session-targeted, not `to: '*'`: the update describes THIS session's todo
  // list, so only agents inside this session should receive it. A project-wide
  // fan-out let one session's board projection land in every other session's
  // mailbox (cross-session todo bleed). `status` is a valid type for the
  // multi-recipient `@session:` form (only assign/steer require one recipient).
  //
  // Human-readable summary only. The body used to be
  // `JSON.stringify({kind: "kanban.todos.updated", ...})` — machine-shaped
  // clutter that rendered as opaque braces in every recipient's context.
  // Nothing parses it (WebUI kanban events go over a separate WS channel),
  // and the identity data it carried is already elsewhere: the session is
  // the `@session:` recipient, the count is in the subject.
  void mailbox
    .send({
      from: context.agentId,
      to: `@session:${sessionId}`,
      type: 'status',
      subject: `Kanban todo list updated (${todos.length} item${todos.length === 1 ? '' : 's'})`,
      body:
        `Shared Kanban board synced this session's todo list: ${todos.length} item${todos.length === 1 ? '' : 's'} — ` +
        `${statusCounts.completed} completed, ${statusCounts.inProgress} in progress, ${statusCounts.pending} pending.`,
      priority: 'normal',
      senderSessionId: sessionId,
    })
    .catch(() => {
      // Mailbox awareness is best-effort; canonical state is already updated.
    });
}

function notifyTodoUpdate(context: Context, todos: readonly TodoItem[]): void {
  const summary = formatTodosForModel(todos);
  const text =
    `[KANBAN TODO UPDATE]\nAnother Kanban agent reassessed the shared board. The canonical todo list is now:\n${summary}\n` +
    'Reassess your current plan before continuing; do not rely on the initial todo snapshot. ' +
    "Preserve each row's <kanban board/task> binding verbatim on your next `todo` call — a row that loses it stops advancing its card.";
  const state = context.state as Partial<Context['state']>;
  if (typeof state.appendBlockToLastUserMessage === 'function') {
    if (state.appendBlockToLastUserMessage({ type: 'text', text })) return;
  }
  if (typeof state.appendMessage === 'function') {
    state.appendMessage({ role: 'user', content: [{ type: 'text', text }] });
  }
}

export function todosNeedingSessionMirror(
  todos: readonly TodoItem[],
  activeBoardId: string | undefined,
): readonly TodoItem[] {
  if (!activeBoardId) return todos;
  return todos.filter((todo) => todo.kanbanBoardId !== activeBoardId || !todo.kanbanTaskId);
}

export function applySessionKanbanBoardToTodos(
  context: Context,
  board: KanbanBoard,
  options: {
    sessionIdFromTags: (tags: readonly string[] | undefined) => string | null;
    isOwnedSessionBoard: (tags: readonly string[] | undefined) => boolean;
    hasInFlightTodoMirror: (projectRoot: string | undefined, sessionId: string) => boolean;
    suppressedTodoMirrors: WeakSet<Context>;
  },
): TodoItem[] {
  const sessionId = context.session?.id ?? '';
  if (
    !sessionId ||
    options.sessionIdFromTags(board.tags) !== sessionId ||
    !options.isOwnedSessionBoard(board.tags)
  ) {
    return [...context.todos];
  }
  if (options.hasInFlightTodoMirror(context.projectRoot, sessionId)) return [...context.todos];

  const projectedTodos = orderTasksForTodos(
    board,
    board.tasks.filter(
      (task) =>
        task.status !== 'archived' &&
        (!task.origin ||
          task.origin.system === 'session-todo' ||
          (task.origin.graphId ?? '').startsWith('todo:')),
    ),
  ).map((task) => sessionTodoFromTask(task, board));

  const allCompleted =
    projectedTodos.length > 0 && projectedTodos.every((todo) => todo.status === 'completed');
  const effectiveTodos = allCompleted ? [] : projectedTodos;
  if (sameTodos(context.todos, effectiveTodos)) return [...context.todos];
  options.suppressedTodoMirrors.add(context);
  try {
    context.state.replaceTodos(projectedTodos);
  } finally {
    options.suppressedTodoMirrors.delete(context);
  }
  notifyTodoUpdate(context, context.todos);
  broadcastTodoUpdate(context, context.todos);
  return [...context.todos];
}

export function applyManagedKanbanBoardToTodos(
  context: Context,
  board: KanbanBoard,
  suppressedTodoMirrors: WeakSet<Context>,
  options: {
    /** Extracts the owning session id from board tags (`session:<id>`). */
    sessionOwnerFromTags?: ((tags: readonly string[] | undefined) => string | null) | undefined;
  } = {},
): TodoItem[] {
  const metaKanban = context.meta['kanban'];
  const metaBoardId =
    metaKanban && typeof metaKanban === 'object'
      ? (metaKanban as Record<string, unknown>)['boardId']
      : undefined;
  const activeBoardId =
    context.currentKanbanBoardId ?? (typeof metaBoardId === 'string' ? metaBoardId : undefined);
  if (!activeBoardId || board.id !== activeBoardId || board.lifecycle?.mode !== 'managed') {
    return [...context.todos];
  }

  // Session-ownership guard: a board tagged as owned by ANOTHER session must
  // not project into this session's todo list. Without this, a session bound
  // to a foreign board (e.g. via the presence-scan rebind path) mirrored that
  // board's tasks here — the cross-session todo bleed. Boards without a
  // session tag are shared project boards and keep projecting as before.
  const ownerSessionId = options.sessionOwnerFromTags?.(board.tags);
  if (ownerSessionId && ownerSessionId !== (context.session?.id ?? '')) {
    return [...context.todos];
  }

  const projectedTodos = orderTasksForTodos(
    board,
    board.tasks.filter(
      (task) =>
        task.status !== 'archived' &&
        task.mergedIntoTaskId === undefined &&
        (!task.childTaskIds || task.childTaskIds.length === 0),
    ),
  ).map((task) => managedTodoFromTask(task, board));

  if (sameTodos(context.todos, projectedTodos)) return [...context.todos];
  suppressedTodoMirrors.add(context);
  try {
    context.state.replaceTodos(projectedTodos);
  } finally {
    suppressedTodoMirrors.delete(context);
  }
  notifyTodoUpdate(context, context.todos);
  broadcastTodoUpdate(context, context.todos);
  return [...context.todos];
}

export async function applySessionKanbanTaskToSource(
  context: Context,
  task: KanbanTask,
  suppressedTodoMirrors: WeakSet<Context>,
  options: { remove?: boolean | undefined } = {},
): Promise<SessionKanbanSourceUpdate> {
  const originId = task.origin?.taskId;
  const graphId = task.origin?.graphId ?? '';

  const isTodoOrigin = task.origin?.system === 'session-todo' || graphId.startsWith('todo:');
  const targetTodo = context.todos?.find(
    (todo) =>
      (originId !== undefined && todo.id === originId) ||
      todo.kanbanTaskId === task.id ||
      (todo.id === task.id && !todo.promotedFromPlan && !todo.promotedFromTask),
  );

  if (isTodoOrigin || targetTodo) {
    const matchedId = targetTodo?.id ?? originId;
    if (matchedId) {
      const mappedStatus = todoStatus(task);
      const next = options.remove
        ? context.todos.filter((todo) => todo.id !== matchedId)
        : context.todos.map((todo) =>
            todo.id === matchedId
              ? {
                  ...todo,
                  content: task.title,
                  status: mappedStatus,
                  kanbanTaskId: task.id,
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
  }

  if (!originId) return { source: null };

  const id = context.session?.id ?? '';
  if (task.origin?.system === 'session-plan' || graphId.startsWith('plan:')) {
    const planPath = context.meta['plan.path'];
    if (typeof planPath !== 'string' || !planPath) {
      throw new Error(
        'Cannot reflect this Kanban edit back to its plan source: the session has no plan.path configured. ' +
          'The board mutation already succeeded; the plan file is now out of sync.',
      );
    }
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
    if (typeof taskPath !== 'string' || !taskPath) {
      throw new Error(
        'Cannot reflect this Kanban edit back to its task source: the session has no task.path configured. ' +
          'The board mutation already succeeded; the task file is now out of sync.',
      );
    }
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
