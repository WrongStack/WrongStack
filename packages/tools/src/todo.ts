import type { Context, TodoItem } from '@wrongstack/core/agent';
import {
  loadPlan,
  loadTasks,
  savePlan,
  saveTasks,
  setPlanItemStatus,
} from '@wrongstack/core/storage';
import type { Tool } from '@wrongstack/core/types';
import { ToolValidationError } from '@wrongstack/core/types';
import { addTask, getBoard, type KanbanBoard, type KanbanTask } from '@wrongstack/kanban';
import { kanbanTool } from './kanban.js';
import {
  applyManagedKanbanBoardToTodos,
  blockingTitles,
  mirrorSessionTodosToKanban,
  takeSessionMirrorFailure,
} from './session-kanban.js';

export interface TodoInput {
  todos: TodoItem[];
}

export interface TodoOutput {
  count: number;
  in_progress: number;
  kanban_synced?: number | undefined;
  kanban_warnings?: string[] | undefined;
  kanban_bindings?:
    | Array<{
        todoId: string;
        boardId: string;
        taskId: string;
        taskStatus: KanbanTask['status'];
      }>
    | undefined;
}

function normalizedTitle(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
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

function bindTodosToBoard(
  items: readonly TodoItem[],
  previous: readonly TodoItem[],
  board: KanbanBoard,
): TodoItem[] {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const taskById = new Map(board.tasks.map((task) => [task.id, task]));
  const taskByOriginId = new Map(
    board.tasks.filter((task) => task.origin?.taskId).map((task) => [task.origin!.taskId, task]),
  );
  const available = board.tasks
    .filter(
      (task) =>
        task.status !== 'archived' &&
        task.mergedIntoTaskId === undefined &&
        (!task.childTaskIds || task.childTaskIds.length === 0),
    )
    .sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.order - right.order,
    );
  const used = new Set<string>();

  return items.map((item) => {
    const previousItem = previousById.get(item.id);
    const requestedTaskId =
      item.kanbanBoardId === board.id
        ? item.kanbanTaskId
        : previousItem?.kanbanBoardId === board.id
          ? previousItem.kanbanTaskId
          : undefined;
    const title = normalizedTitle(item.content);
    const candidates: Array<KanbanTask | undefined> = [
      requestedTaskId ? taskById.get(requestedTaskId) : undefined,
      taskById.get(item.id),
      taskByOriginId.get(item.id),
      available.find((task) => !used.has(task.id) && normalizedTitle(task.title) === title),
    ];
    const task = candidates.find((candidate) => candidate && !used.has(candidate.id));
    if (!task) {
      const { blockedBy: _discarded, ...rest } = item;
      return { ...rest };
    }
    used.add(task.id);
    // `blockedBy` is board-derived, never model-supplied: recompute it here so
    // a stale or invented value in the request cannot mask real blocking.
    const blockedBy = blockingTitles(board, task);
    return {
      ...item,
      kanbanBoardId: board.id,
      kanbanTaskId: task.id,
      ...(blockedBy.length ? { blockedBy } : { blockedBy: undefined }),
    };
  });
}

/**
 * Refuse to start work whose dependencies are unmet.
 *
 * `start_task` already rejects a blocked card, but it did so *after* the row
 * was recorded as `in_progress` — leaving the list claiming work had begun
 * while the board never moved. Demote here so the two surfaces cannot
 * disagree, and say why.
 */
function demoteBlockedInProgress(items: TodoItem[], warnings: string[]): TodoItem[] {
  return items.map((item) => {
    if (item.status !== 'in_progress' || !item.blockedBy?.length) return item;
    warnings.push(
      `"${item.content}" cannot start yet — it waits on: ${item.blockedBy.join('; ')}. ` +
        'Kept as pending; complete the blocking work first.',
    );
    return { ...item, status: 'pending' as const };
  });
}

/**
 * Open real cards for rows a managed board has no task for.
 *
 * The board is the authority on state, but the compact list is where new work
 * gets discovered mid-run. Previously an unmatched row was only reported as
 * "did not match a real Kanban task and was not applied" — so work the model
 * added during a run never reached the board, and the user saw a todo that no
 * card would ever track. Creating the card keeps the two surfaces total.
 *
 * Returns the todoId -> new taskId bindings so the caller can attach them
 * directly rather than re-deriving them from a title match.
 */
async function createMissingManagedCards(
  items: readonly TodoItem[],
  board: KanbanBoard,
  ctx: Context,
  warnings: string[],
): Promise<Map<string, string>> {
  const created = new Map<string, string>();
  for (const item of items) {
    if (item.kanbanBoardId === board.id && item.kanbanTaskId) continue;
    try {
      // A managed board rejects a card without a description, so derive one
      // rather than letting creation fail and silently drop the row.
      const result = await addTask(
        ctx.projectRoot,
        board.id,
        {
          title: item.content,
          description:
            item.activeForm?.trim() || `Added from the session todo list: ${item.content}`,
        },
        // The card mirrors this session's todo row, so the session owns it.
        {
          sessionId: ctx.eventSessionId?.() ?? ctx.session?.id ?? 'default-session',
          actor: 'todo',
        },
      );
      if (!result) {
        warnings.push(`Could not open a Kanban card for "${item.content}": board not found.`);
        continue;
      }
      created.set(item.id, result.task.id);
    } catch (error) {
      warnings.push(
        `Could not open a Kanban card for "${item.content}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return created;
}

async function synchronizeManagedKanban(
  items: readonly TodoItem[],
  board: KanbanBoard,
  ctx: Context,
  signal: AbortSignal,
): Promise<{ synced: number; warnings: string[] }> {
  let synced = 0;
  const warnings: string[] = [];
  const actor = ctx.agentId?.trim() || ctx.agentName?.trim() || 'kanban-agent';
  const execute = async (input: Parameters<(typeof kanbanTool)['execute']>[0]) => {
    const result = await kanbanTool.execute(input, ctx, { signal });
    if (!result.ok) warnings.push(result.message);
    else {
      synced++;
      if (result.message.includes('Warning:')) warnings.push(result.message);
    }
    return result;
  };

  // A host may select another Todo (manual continue, auto-proceed, WebUI)
  // by demoting the old in-progress row. Keep the real managed card in lockstep
  // instead of leaving two cards in Running while the compact list shows one.
  for (const item of items) {
    if (item.status !== 'pending' || item.kanbanBoardId !== board.id || !item.kanbanTaskId) {
      continue;
    }
    const task = board.tasks.find((candidate) => candidate.id === item.kanbanTaskId);
    if (task?.lifecycle?.currentStage !== 'running') continue;
    const released = await execute({
      action: 'mark_assignment',
      boardId: board.id,
      taskId: task.id,
      assignmentStatus: 'assigned',
      agentId: actor,
      lastResult: `Todo returned to queue: ${item.content}`,
    });
    if (!released.ok) continue;
    await execute({
      action: 'transition_task',
      boardId: board.id,
      taskId: task.id,
      lifecycleStage: 'todo',
      author: actor,
      transitionComment: `Todo returned to queue: ${item.content}`,
    });
  }

  // Done is terminal on a managed board — transitions out of it are refused by
  // design. A row that demotes a completed card therefore cannot be honoured,
  // and the next board projection silently restores it to completed. Report the
  // contradiction rather than letting the two surfaces quietly disagree.
  for (const item of items) {
    if (item.status === 'completed' || item.kanbanBoardId !== board.id || !item.kanbanTaskId) {
      continue;
    }
    const task = board.tasks.find((candidate) => candidate.id === item.kanbanTaskId);
    if (task?.status !== 'completed') continue;
    warnings.push(
      `"${item.content}" is already Done on the Kanban board and a completed card cannot be reopened; ` +
        'the row stays completed. Create a follow-up card for any remaining work.',
    );
  }

  for (const item of items) {
    if (item.status !== 'completed' || item.kanbanBoardId !== board.id || !item.kanbanTaskId) {
      continue;
    }
    const task = board.tasks.find((candidate) => candidate.id === item.kanbanTaskId);
    if (!task || task.status === 'completed') continue;
    // A completed todo whose card was never started (still in backlog/todo)
    // must be walked to Running first. The managed auto-transition inside
    // mark_assignment(completed) only fires when stage === 'running'; without
    // this pre-step the card sits in its original stage with a 'completed'
    // assignment status that the lifecycle gate never picks up — so the todo
    // surface shows completed while the board card is stuck, and the next
    // board projection reverts the todo because the card never reached
    // completed/review. start_task handles backlog→todo→running atomically.
    const stage = task.lifecycle?.currentStage;
    if (stage === 'backlog' || stage === 'todo') {
      const started = await execute({
        action: 'start_task',
        boardId: board.id,
        taskId: task.id,
        author: actor,
        agentId: actor,
        transitionComment: `Auto-started for completion: ${item.content}`,
      });
      if (!started.ok) {
        continue;
      }
    }
    await execute({
      action: 'mark_assignment',
      boardId: board.id,
      taskId: task.id,
      assignmentStatus: 'completed',
      agentId: actor,
      lastResult: `Todo completed: ${item.content}`,
    });
  }

  // Composite parents are intentionally absent from the compact Todo list.
  // Roll them up once every child is Done, otherwise all visible work can be
  // complete while the board remains forever open on an invisible parent.
  const attemptedParents = new Set<string>();
  let afterCompletions = await getBoard(ctx.projectRoot, board.id);
  while (afterCompletions) {
    const parent = afterCompletions.tasks.find(
      (task) =>
        task.atomic === true &&
        task.status !== 'completed' &&
        Boolean(task.childTaskIds?.length) &&
        !attemptedParents.has(task.id) &&
        task.childTaskIds?.every(
          (childId) =>
            afterCompletions?.tasks.find((candidate) => candidate.id === childId)?.status ===
            'completed',
        ),
    );
    if (!parent) break;
    attemptedParents.add(parent.id);
    const started = await execute({
      action: 'start_task',
      boardId: board.id,
      taskId: parent.id,
      author: actor,
      agentId: actor,
      transitionComment: 'All child tasks completed; validating composite parent.',
    });
    if (started.ok) {
      await execute({
        action: 'mark_assignment',
        boardId: board.id,
        taskId: parent.id,
        assignmentStatus: 'completed',
        agentId: actor,
        lastResult: 'All child tasks completed; composite result ready for verification.',
      });
    }
    afterCompletions = await getBoard(ctx.projectRoot, board.id);
  }
  const completionPending = items.some(
    (item) =>
      item.status === 'completed' &&
      item.kanbanBoardId === board.id &&
      Boolean(item.kanbanTaskId) &&
      afterCompletions?.tasks.find((task) => task.id === item.kanbanTaskId)?.status !== 'completed',
  );

  const active = items.find(
    (item) =>
      item.status === 'in_progress' &&
      item.kanbanBoardId === board.id &&
      Boolean(item.kanbanTaskId),
  );
  // A card sitting in Review or Done must not be silently yanked back to
  // Running by the todo projection. Review is awaiting acceptance (human or
  // auto-accept gate), and Done is terminal; reactivating either from a todo
  // `in_progress` row would discard the reviewer's pending decision. A
  // conscious repair is still possible via a direct `start_task` call.
  const activeStage = active?.kanbanTaskId
    ? afterCompletions?.tasks.find((task) => task.id === active.kanbanTaskId)?.lifecycle
        ?.currentStage
    : undefined;
  if (active?.kanbanTaskId) {
    if (activeStage === 'review' || activeStage === 'done') {
      warnings.push(
        `"${active.content}" is in ${activeStage === 'review' ? 'Review' : 'Done'} ` +
          `awaiting acceptance; not re-activating it from the todo list. ` +
          (activeStage === 'review'
            ? 'Call kanban start_task explicitly to reopen it as a repair.'
            : 'Done is terminal; reopen only by creating a follow-up card.'),
      );
    } else {
      await execute({
        action: 'start_task',
        boardId: board.id,
        taskId: active.kanbanTaskId,
        author: actor,
        agentId: actor,
        transitionComment: `Todo activated: ${active.content}`,
      });
    }
  }
  if (active?.kanbanTaskId && activeStage === 'review') {
    // Warning already pushed above; skip the completionPending echo so the
    // user gets one clear message about the held card.
  } else if (active?.kanbanTaskId && completionPending) {
    warnings.push(
      'A completed todo is still awaiting acceptance; the next independent Kanban task was started.',
    );
  } else if (!active && ctx.currentKanbanBoardId === board.id) {
    ctx.setCurrentKanbanTask(undefined, board.id);
  }
  return { synced, warnings };
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
      if (item.status !== undefined && !VALID_STATUSES.has(item.status)) {
        throw new ToolValidationError({
          message: `todo: item "${item.id}" has invalid status "${item.status}". Allowed: pending, in_progress, completed`,
          field: 'todos',
        });
      }
    }

    const items = input.todos.filter((t): t is TodoItem => Boolean(t?.id && t.content));
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
    let boundItems = managed && board ? bindTodosToBoard(items, ctx.todos ?? [], board) : items;

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
        applyManagedKanbanBoardToTodos(ctx, refreshed);
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

    for (const item of items) {
      if (item.promotedFromPlan) {
        (item.status === 'completed' ? completedPlanIds : pendingPlanIds).add(
          item.promotedFromPlan,
        );
      }
      if (item.promotedFromTask) {
        (item.status === 'completed' ? completedTaskIds : pendingTaskIds).add(
          item.promotedFromTask,
        );
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
        let plan = await loadPlan(planPath);
        if (plan) {
          let modified = false;
          for (const planId of completedPlanIds) {
            if (pendingPlanIds.has(planId)) continue;
            plan = setPlanItemStatus(plan, planId, 'done');
            modified = true;
          }
          if (modified) await savePlan(planPath, plan);
        }
      } catch {
        /* best-effort */
      }
    }

    // Mark fully-completed tasks as completed — same resolved-path preference
    // as the plan rollup above.
    const taskPath = meta?.['task.path.resolved'] ?? meta?.['task.path'];
    if (typeof taskPath === 'string' && taskPath && completedTaskIds.size > 0) {
      try {
        const file = await loadTasks(taskPath);
        if (file) {
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
          if (modified) await saveTasks(taskPath, file);
        }
      } catch {
        /* best-effort */
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
