import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import type { Context, TodoItem } from '@wrongstack/core/agent';
import { loadPlan, loadTasks, savePlan, saveTasks } from '@wrongstack/core/storage';
import { toErrorMessage, withFileLock } from '@wrongstack/core/utils';
import { getBoard, type KanbanTask } from '@wrongstack/kanban';
import {
  applyManagedKanbanBoardToTodos,
  mirrorSessionTodosToKanban,
  takeSessionMirrorFailure,
} from './session-kanban.js';
import {
  bindTodosToBoard,
  createMissingManagedCards,
  deduplicateManagedTodoRows,
  demoteBlockedInProgress,
  synchronizeManagedKanban,
} from './todo-kanban-sync.js';

export interface TodoInput {
  todos: TodoItem[];
}

export interface TodoKanbanBinding {
  todoId: string;
  boardId: string;
  taskId: string;
  taskStatus: KanbanTask['status'];
}

export interface TodoOutput {
  count: number;
  in_progress: number;
  kanban_synced?: number | undefined;
  kanban_warnings?: string[] | undefined;
  kanban_bindings?: TodoKanbanBinding[] | undefined;
}

function activeBoardId(items: readonly TodoItem[], ctx: Context): string {
  const metaKanban = ctx.meta?.['kanban'];
  const metaBoardId =
    metaKanban && typeof metaKanban === 'object'
      ? (metaKanban as Record<string, unknown>)['boardId']
      : undefined;
  return (
    ctx.currentKanbanBoardId ??
    (typeof metaBoardId === 'string' ? metaBoardId : undefined) ??
    items.find((item) => item.kanbanBoardId)?.kanbanBoardId ??
    ''
  );
}

export const todoTool: Tool<TodoInput, TodoOutput> = {
  name: 'todo',
  category: 'Session',
  description:
    'Manage the compact active-work list. With a managed Kanban binding, every row resolves to a real card and status changes advance that card; without Kanban it remains session-only state. ' +
    'Each call replaces ordering and supplied fields, but unfinished omitted rows are retained until completed.',
  usageHint:
    'BEST PRACTICE for complex tasks:\n' +
    '- At the beginning of a non-trivial task, create a clear todo list with specific, actionable items.\n' +
    '- Only **one** item should be `in_progress` at any time.\n' +
    '- Update the list frequently as work progresses (mark items done, add new ones, change status).\n' +
    '- **Re-order items** to reflect current priorities. Omission is not cancellation: unfinished rows are retained until completed.\n' +
    '- When all items are completed the board auto-clears — you do NOT need to send an empty list.\n' +
    '- The system and user can see this list, so keep it honest and up-to-date.\n' +
    'This tool is extremely valuable for maintaining focus and giving the user visibility into your plan.',
  permission: 'confirm',
  mutating: true,
  timeoutMs: 30_000,
  capabilities: ['session.todo', 'fs.write'],
  subjectKey: 'todos',
  icon: 'todo',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Unique identifier for the todo item (e.g. "1", "auth-flow").',
            },
            content: {
              type: 'string',
              description: 'Clear, actionable description of the task.',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current status. Only one item should be "in_progress" at a time.',
            },
            activeForm: {
              type: 'string',
              description:
                'Optional present-tense form shown while the task is active (e.g. "Fixing auth bug").',
            },
            kanbanBoardId: {
              type: 'string',
              description: 'Kanban board that owns this UI row when Kanban is active.',
            },
            kanbanTaskId: {
              type: 'string',
              description: 'Real Kanban task represented by this UI row.',
            },
          },
          required: ['id', 'content', 'status'],
        },
        description:
          'The desired todo list. Supplied rows are replaced/reordered; unfinished omitted rows are retained.',
      },
    },
    required: ['todos'],
  },
  async execute(input, ctx, call) {
    const signal = call?.signal ?? ctx.signal ?? new AbortController().signal;
    signal.throwIfAborted();

    if (!Array.isArray(input?.todos)) {
      throw new ToolValidationError({
        message: 'todo: todos must be an array',
        field: 'todos',
      });
    }

    const VALID_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);
    for (const item of input.todos) {
      if (!item || typeof item !== 'object') {
        throw new ToolValidationError({
          message: 'todo: each item in todos must be an object',
          field: 'todos',
        });
      }
      if (!item.id || typeof item.id !== 'string' || !item.id.trim()) {
        throw new ToolValidationError({
          message: 'todo: each item must have a non-empty string "id"',
          field: 'todos',
        });
      }
      if (item.content === undefined || typeof item.content !== 'string') {
        throw new ToolValidationError({
          message: `todo: item "${item.id}" must have a string "content"`,
          field: 'todos',
        });
      }
      if (!item.status || !VALID_STATUSES.has(item.status)) {
        throw new ToolValidationError({
          message: `todo: item "${item.id}" has invalid status "${item.status}". Allowed: pending, in_progress, completed`,
          field: 'todos',
        });
      }
    }

    const previousById = new Map((ctx.todos ?? []).map((item) => [item.id, item]));
    const items = input.todos
      .filter((t): t is TodoItem => Boolean(t?.id && t.content))
      .map((item) => {
        const previous = previousById.get(item.id);
        // The tool schema does not expose promotion metadata. Preserve source
        // identity before checking omissions, or an ordinary status update
        // becomes a new row alongside the unfinished original.
        const sameBinding =
          (!item.kanbanBoardId || item.kanbanBoardId === previous?.kanbanBoardId) &&
          (!item.kanbanTaskId || item.kanbanTaskId === previous?.kanbanTaskId);
        return {
          ...item,
          ...(previous && sameBinding
            ? {
                promotedFromPlan: item.promotedFromPlan ?? previous.promotedFromPlan,
                promotedFromTask: item.promotedFromTask ?? previous.promotedFromTask,
                kanbanBoardId: item.kanbanBoardId ?? previous.kanbanBoardId,
                kanbanTaskId: item.kanbanTaskId ?? previous.kanbanTaskId,
              }
            : {}),
        };
      });
    const todoIdentity = (item: TodoItem): string =>
      item.kanbanBoardId && item.kanbanTaskId
        ? `kanban:${item.kanbanBoardId}:${item.kanbanTaskId}`
        : item.promotedFromTask
          ? `task:${item.promotedFromTask}:${item.id}`
          : item.promotedFromPlan
            ? `plan:${item.promotedFromPlan}:${item.id}`
            : `todo:${item.id}`;
    const requestedIdentities = new Set(items.map(todoIdentity));
    for (const previous of ctx.todos ?? []) {
      const identity = todoIdentity(previous);
      if (previous.status === 'completed' || requestedIdentities.has(identity)) {
        continue;
      }
      // Replacement is still allowed to reorder and update work, but omission
      // is not a cancellation mechanism. Retain unfinished rows so a shorter
      // model-generated list cannot make work disappear.
      items.push({ ...previous });
      requestedIdentities.add(identity);
    }
    const inProgress = items.filter((t) => t.status === 'in_progress');
    if (inProgress.length > 1) {
      // Keep only the first as in_progress, mark rest pending
      let seenInProgress = false;
      for (const item of items) {
        if (item.status === 'in_progress') {
          if (seenInProgress) item.status = 'pending';
          seenInProgress = true;
        }
      }
    }
    const boardId = activeBoardId(items, ctx);
    let board = boardId ? await getBoard(ctx.projectRoot, boardId) : null;
    const managed = board?.lifecycle?.mode === 'managed';
    const managedItems = managed && board ? deduplicateManagedTodoRows(items, board.id) : items;
    let boundItems =
      managed && board ? bindTodosToBoard(managedItems, ctx.todos ?? [], board) : managedItems;

    // Rows that still resolve to no card are new work, not noise. Open cards
    // for them and bind directly to the returned ids — never by re-running the
    // title match, which is exactly the fuzzy step this avoids.
    const creationWarnings: string[] = [];
    if (managed && board) {
      const managedBoardId = board.id;
      const created = await createMissingManagedCards(boundItems, board, ctx, creationWarnings);
      if (created.size > 0) {
        boundItems = boundItems.map((item) => {
          const taskId = created.get(item.id);
          return taskId ? { ...item, kanbanBoardId: managedBoardId, kanbanTaskId: taskId } : item;
        });
        board = (await getBoard(ctx.projectRoot, managedBoardId)) ?? board;
        boundItems = bindTodosToBoard(boundItems, ctx.todos ?? [], board);
      }
      boundItems = demoteBlockedInProgress(boundItems, creationWarnings);
    }
    ctx.state.replaceTodos(boundItems);

    const kanbanSync =
      managed && board
        ? await synchronizeManagedKanban(boundItems, board, ctx, signal)
        : { synced: 0, warnings: [] as string[] };
    kanbanSync.warnings.unshift(...creationWarnings);
    if (managed && board) {
      const unresolved = boundItems.filter(
        (item) => item.kanbanBoardId !== board.id || !item.kanbanTaskId,
      );
      if (unresolved.length > 0) {
        kanbanSync.warnings.push(
          `${unresolved.length} Todo row(s) could not be bound to a Kanban task and were not applied. Preserve kanbanBoardId/kanbanTaskId when updating the projection.`,
        );
      }
    }
    // A rejected background mirror leaves the board silently behind the list.
    // Drain it here so the divergence is reported where it is actionable.
    const mirrorFailure = takeSessionMirrorFailure(ctx.projectRoot, ctx.session?.id ?? '');
    if (mirrorFailure) kanbanSync.warnings.push(mirrorFailure);
    let projectedBoard = board;
    if (managed && board) {
      const refreshed = await getBoard(ctx.projectRoot, board.id);
      if (refreshed) {
        projectedBoard = refreshed;
        applyManagedKanbanBoardToTodos(ctx, refreshed, boundItems);
      }
    }

    // Kanban is the session work surface. Mirror the requested list (rather
    // than ctx.todos) so the final all-completed snapshot reaches Done even
    // though ConversationState auto-clears an all-done tactical todo list.
    // Fire-and-forget: the mirror is observational and must not block the tool
    // response (or consume the tool's timeout budget) waiting on kanban file
    // locks that may be held by other agents.
    if (!managed) {
      mirrorSessionTodosToKanban(ctx.projectRoot, items, ctx.session?.id ?? 'session');
    }

    // Auto-complete parent plan items / tasks when all their promoted
    // todos are done. Runs after state mutation so the UI sees the new
    // todo list before we touch the plan/task files.
    const completedPlanIds = new Set<string>();
    const completedTaskIds = new Set<string>();
    const pendingPlanIds = new Set<string>();
    const pendingTaskIds = new Set<string>();

    // Parent completion follows accepted card state, not the model's request.
    // Keep metadata from boundItems: the canonical todo projection may already
    // have auto-cleared and does not carry promotion metadata.
    for (const item of boundItems) {
      const completed = managed
        ? item.kanbanBoardId === projectedBoard?.id &&
          projectedBoard?.tasks.find((task) => task.id === item.kanbanTaskId)?.status ===
            'completed'
        : item.status === 'completed';
      if (item.promotedFromPlan) {
        (completed ? completedPlanIds : pendingPlanIds).add(item.promotedFromPlan);
      }
      if (item.promotedFromTask) {
        (completed ? completedTaskIds : pendingTaskIds).add(item.promotedFromTask);
      }
    }

    // Mark fully-completed plan items as done. Prefer the RESOLVED path the
    // plan tool actually wrote ('plan.path.resolved' — set for both session
    // and project scope) over the seeded session path, so project-scoped plan
    // items promoted to todos roll up against the real backlog file.
    const meta = ctx.meta as Record<string, unknown> | undefined;
    const planPath = meta?.['plan.path.resolved'] ?? meta?.['plan.path'];
    if (typeof planPath === 'string' && planPath && completedPlanIds.size > 0) {
      try {
        await withFileLock(planPath, async () => {
          const plan = await loadPlan(planPath);
          if (!plan) return;
          let modified = false;
          for (const planId of completedPlanIds) {
            if (pendingPlanIds.has(planId)) continue;
            const item = plan.items.find((candidate) => candidate.id === planId);
            if (!item || item.status === 'done') continue;
            item.status = 'done';
            item.updatedAt = new Date().toISOString();
            plan.updatedAt = item.updatedAt;
            modified = true;
          }
          if (modified && !(await savePlan(planPath, plan))) {
            throw new Error('Plan completion was not saved.');
          }
        });
      } catch (error) {
        kanbanSync.warnings.push(`Plan completion was not saved: ${toErrorMessage(error)}`);
      }
    }

    // Mark fully-completed tasks as completed — same resolved-path preference
    // as the plan rollup above.
    const taskPath = meta?.['task.path.resolved'] ?? meta?.['task.path'];
    if (typeof taskPath === 'string' && taskPath && completedTaskIds.size > 0) {
      try {
        await withFileLock(taskPath, async () => {
          const file = await loadTasks(taskPath);
          if (!file) return;
          let modified = false;
          for (const taskId of completedTaskIds) {
            if (pendingTaskIds.has(taskId)) continue;
            const task = file.tasks.find((t) => t.id === taskId);
            if (task && task.status !== 'completed') {
              task.status = 'completed';
              task.updatedAt = new Date().toISOString();
              modified = true;
            }
          }
          if (modified && !(await saveTasks(taskPath, file))) {
            throw new Error('Task completion was not saved.');
          }
        });
      } catch (error) {
        kanbanSync.warnings.push(`Task completion was not saved: ${toErrorMessage(error)}`);
      }
    }

    return {
      count: items.length,
      in_progress: (ctx.todos ?? boundItems).filter((t) => t.status === 'in_progress').length,
      ...(kanbanSync.synced > 0 ? { kanban_synced: kanbanSync.synced } : {}),
      ...(kanbanSync.warnings.length > 0 ? { kanban_warnings: kanbanSync.warnings } : {}),
      ...(projectedBoard?.lifecycle?.mode === 'managed'
        ? {
            kanban_bindings: boundItems.flatMap((item) => {
              if (item.kanbanBoardId !== projectedBoard.id || !item.kanbanTaskId) return [];
              const task = projectedBoard.tasks.find(
                (candidate) => candidate.id === item.kanbanTaskId,
              );
              return task
                ? [
                    {
                      todoId: item.id,
                      boardId: projectedBoard.id,
                      taskId: task.id,
                      taskStatus: task.status,
                    },
                  ]
                : [];
            }),
          }
        : {}),
    };
  },
};
