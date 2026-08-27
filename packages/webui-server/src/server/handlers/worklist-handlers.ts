import type { TodoItem } from '@wrongstack/core/agent';
import {
  addPlanItem,
  emptyPlan,
  getPlanTemplate,
  loadPlan,
  loadTasks,
  mutatePlan,
  mutateTasks,
  savePlan,
  setPlanItemStatus,
} from '@wrongstack/core/storage';
import type { WebSocket } from 'ws';
import type { WSServerMessage } from '../types.js';
import { validatePlanTemplateUsePayload } from '../ws-payload-validation.js';

export interface WorklistContext {
  context: {
    todos: TodoItem[];
    meta: Record<string, unknown>;
    session: { id: string } | null;
  };
  send: (ws: WebSocket, msg: WSServerMessage) => void;
  broadcast: (msg: WSServerMessage) => void;
  replaceTodos?: ((todos: TodoItem[]) => void) | undefined;
  mutateTodos?:
    | ((todos: TodoItem[]) => Promise<{ todos: TodoItem[]; warnings?: string[] | undefined }>)
    | undefined;
  mutateTaskStatus?:
    | ((
        id: string,
        status: 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed',
      ) => Promise<{ ok: boolean; message: string }>)
    | undefined;
  mutatePlan?:
    | ((
        operation:
          | { action: 'template_use'; template: string }
          | {
              action: 'status';
              target: string;
              status: 'open' | 'in_progress' | 'done';
            },
      ) => Promise<{ ok: boolean; message: string }>)
    | undefined;
}

export interface WorklistMessage {
  type: string;
  payload?: unknown;
}

function sendResult(ctx: WorklistContext, ws: WebSocket, success: boolean, message: string): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

function currentSessionId(ctx: WorklistContext): string {
  return ctx.context.session?.id ?? '';
}

function sessionPayload<T extends Record<string, unknown>>(
  ctx: WorklistContext,
  payload: T,
): T & { sessionId: string } {
  const provided = payload['sessionId'];
  const sessionId =
    typeof provided === 'string' && provided.length > 0 ? provided : currentSessionId(ctx);
  return { ...payload, sessionId };
}

function planPathOf(ctx: WorklistContext): string | undefined {
  const value = ctx.context.meta['plan.path'];
  return typeof value === 'string' && value ? value : undefined;
}

function taskPathOf(ctx: WorklistContext): string | undefined {
  const value = ctx.context.meta['task.path'];
  return typeof value === 'string' && value ? value : undefined;
}

export function handleTodosGet(ctx: WorklistContext, ws: WebSocket): void {
  ctx.send(ws, {
    type: 'todos.updated',
    payload: sessionPayload(ctx, { todos: [...ctx.context.todos] }),
  });
}

async function commitTodos(
  ctx: WorklistContext,
  todos: TodoItem[],
): Promise<{ todos: TodoItem[]; warnings: string[] }> {
  if (ctx.mutateTodos) {
    const result = await ctx.mutateTodos(todos);
    return { todos: result.todos, warnings: result.warnings ?? [] };
  }
  ctx.replaceTodos?.(todos);
  return { todos: [...todos], warnings: [] };
}

function managedProjectionMessage(): string {
  return 'Kanban-bound todos are task projections. Change or remove the task from Kanban.';
}

export async function handleTodosClear(ctx: WorklistContext, ws: WebSocket): Promise<void> {
  if (ctx.context.todos.some((todo) => todo.kanbanBoardId && todo.kanbanTaskId)) {
    sendResult(ctx, ws, false, managedProjectionMessage());
    return;
  }
  try {
    const result = await commitTodos(ctx, []);
    sendResult(ctx, ws, true, 'Todos cleared');
    ctx.broadcast({
      type: 'todos.updated',
      payload: sessionPayload(ctx, { todos: result.todos }),
    });
  } catch (error) {
    sendResult(ctx, ws, false, error instanceof Error ? error.message : String(error));
  }
}

export async function handleTodosRemove(
  ctx: WorklistContext,
  ws: WebSocket,
  payload: { id?: string | undefined; index?: number | undefined } | undefined,
): Promise<void> {
  if (!payload) {
    sendResult(ctx, ws, false, 'Missing id or index');
    return;
  }
  const todos = ctx.context.todos;
  let targetIndex = -1;
  if (typeof payload.id === 'string') {
    targetIndex = todos.findIndex((todo) => todo.id === payload.id);
  } else if (typeof payload.index === 'number' && payload.index > 0) {
    targetIndex = payload.index - 1;
  }
  const removed = todos[targetIndex];
  if (targetIndex < 0 || !removed) {
    sendResult(ctx, ws, false, 'Todo not found');
    return;
  }
  if (removed.kanbanBoardId && removed.kanbanTaskId) {
    sendResult(ctx, ws, false, managedProjectionMessage());
    return;
  }
  const next = [...todos.slice(0, targetIndex), ...todos.slice(targetIndex + 1)];
  try {
    const result = await commitTodos(ctx, next);
    sendResult(ctx, ws, true, `Removed: ${removed.content}`);
    ctx.broadcast({
      type: 'todos.updated',
      payload: sessionPayload(ctx, { todos: result.todos }),
    });
  } catch (error) {
    sendResult(ctx, ws, false, error instanceof Error ? error.message : String(error));
  }
}

export async function handleTodoUpdate(
  ctx: WorklistContext,
  ws: WebSocket,
  payload:
    | {
        id?: string | undefined;
        status?: TodoItem['status'] | undefined;
        activeForm?: string | undefined;
      }
    | undefined,
): Promise<void> {
  if (
    !payload ||
    typeof payload.id !== 'string' ||
    (payload.status !== undefined &&
      payload.status !== 'pending' &&
      payload.status !== 'in_progress' &&
      payload.status !== 'completed') ||
    (payload.activeForm !== undefined && typeof payload.activeForm !== 'string')
  ) {
    sendResult(ctx, ws, false, 'Invalid todo update payload');
    return;
  }
  const index = ctx.context.todos.findIndex((todo) => todo.id === payload.id);
  const existing = ctx.context.todos[index];
  if (index === -1 || !existing) {
    sendResult(ctx, ws, false, 'Todo not found');
    return;
  }
  const next = [...ctx.context.todos];
  next[index] = {
    ...existing,
    status: payload.status ?? existing.status,
    activeForm: payload.activeForm !== undefined ? payload.activeForm : existing.activeForm,
  };
  try {
    const result = await commitTodos(ctx, next);
    const projected = result.todos.find((todo) => todo.id === existing.id);
    const requestedStatus = payload.status ?? existing.status;
    const projectionRejected =
      Boolean(existing.kanbanBoardId && existing.kanbanTaskId) &&
      projected?.status !== requestedStatus;
    const warning = result.warnings[0];
    sendResult(
      ctx,
      ws,
      !projectionRejected,
      projectionRejected
        ? (warning ??
            `Kanban kept "${existing.content}" at ${projected?.status ?? 'its current state'}.`)
        : warning
          ? `Todo "${existing.content}" updated. ${warning}`
          : `Todo "${existing.content}" updated`,
    );
    ctx.broadcast({
      type: 'todos.updated',
      payload: sessionPayload(ctx, { todos: result.todos }),
    });
  } catch (error) {
    sendResult(ctx, ws, false, error instanceof Error ? error.message : String(error));
  }
}

export async function handleTasksGet(ctx: WorklistContext, ws: WebSocket): Promise<void> {
  const taskPath = taskPathOf(ctx);
  if (!taskPath) {
    ctx.send(ws, {
      type: 'tasks.updated',
      payload: sessionPayload(ctx, { tasks: [], error: 'Task storage not configured.' }),
    });
    return;
  }
  try {
    const file = await loadTasks(taskPath);
    ctx.send(ws, {
      type: 'tasks.updated',
      payload: sessionPayload(ctx, { tasks: file?.tasks ?? [] }),
    });
  } catch {
    ctx.send(ws, { type: 'tasks.updated', payload: sessionPayload(ctx, { tasks: [] }) });
  }
}

export async function handleTaskUpdate(
  ctx: WorklistContext,
  ws: WebSocket,
  payload: {
    id: string;
    status: 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed';
  },
): Promise<void> {
  const taskPath = taskPathOf(ctx);
  if (!taskPath) {
    sendResult(ctx, ws, false, 'Task storage not configured.');
    return;
  }
  try {
    let file;
    if (ctx.mutateTaskStatus) {
      const result = await ctx.mutateTaskStatus(payload.id, payload.status);
      if (!result.ok) {
        sendResult(ctx, ws, false, result.message);
        return;
      }
      file = await loadTasks(taskPath);
      if (!file) throw new Error('Task mutation succeeded but its persisted snapshot is missing.');
      sendResult(ctx, ws, true, result.message);
    } else {
      let matched = false;
      file = await mutateTasks(taskPath, currentSessionId(ctx), async (tasks) => {
        const task = tasks.tasks.find((candidate) => candidate.id === payload.id);
        if (!task) return tasks;
        matched = true;
        task.status = payload.status;
        task.updatedAt = new Date().toISOString();
        return tasks;
      });
      if (!matched) {
        sendResult(ctx, ws, false, `Task "${payload.id}" not found.`);
        return;
      }
      sendResult(ctx, ws, true, `Task status updated to "${payload.status}".`);
    }
    ctx.broadcast({
      type: 'tasks.updated',
      payload: sessionPayload(ctx, { tasks: file.tasks }),
    });
  } catch (error) {
    sendResult(ctx, ws, false, error instanceof Error ? error.message : String(error));
  }
}

export async function handlePlanGet(ctx: WorklistContext, ws: WebSocket): Promise<void> {
  const planPath = planPathOf(ctx);
  if (!planPath) {
    ctx.send(ws, {
      type: 'plan.updated',
      payload: sessionPayload(ctx, {
        plan: null,
        error: 'Plan storage is not configured for this session.',
      }),
    });
    return;
  }
  try {
    let plan = await loadPlan(planPath);
    if (!plan) {
      // A PLAN is session state, not a shared UI placeholder. Create the
      // session's sidecar on first access so subsequent tab switches, agent
      // runs, and status mutations all observe the same durable empty list.
      // mutatePlan takes the file lock and re-loads inside it, so a concurrent
      // writer cannot be overwritten by this lazy initialization.
      plan = await mutatePlan(planPath, currentSessionId(ctx), (current) => current);
    }
    ctx.send(ws, {
      type: 'plan.updated',
      payload: sessionPayload(ctx, { plan }),
    });
  } catch {
    ctx.send(ws, {
      type: 'plan.updated',
      payload: sessionPayload(ctx, { plan: emptyPlan(currentSessionId(ctx)) }),
    });
  }
}

export async function handlePlanTemplateUse(
  ctx: WorklistContext,
  ws: WebSocket,
  template: string,
): Promise<void> {
  const planPath = planPathOf(ctx);
  if (!planPath) {
    sendResult(ctx, ws, false, 'Plan storage is not configured for this session.');
    return;
  }
  try {
    if (ctx.mutatePlan) {
      const result = await ctx.mutatePlan({ action: 'template_use', template });
      if (!result.ok) {
        sendResult(ctx, ws, false, result.message);
        return;
      }
      const plan = await loadPlan(planPath);
      if (!plan) throw new Error('Plan mutation succeeded but its persisted snapshot is missing.');
      sendResult(ctx, ws, true, result.message);
      ctx.broadcast({ type: 'plan.updated', payload: sessionPayload(ctx, { plan }) });
      return;
    }
    const templateDefinition = getPlanTemplate(template);
    if (!templateDefinition) {
      sendResult(ctx, ws, false, `Unknown template "${template}".`);
      return;
    }
    let plan = (await loadPlan(planPath)) ?? emptyPlan(currentSessionId(ctx));
    for (const item of templateDefinition.items) {
      ({ plan } = addPlanItem(plan, item.title, item.details));
    }
    await savePlan(planPath, plan);
    sendResult(
      ctx,
      ws,
      true,
      `Applied template "${templateDefinition.name}" — ${templateDefinition.items.length} items added.`,
    );
    ctx.broadcast({ type: 'plan.updated', payload: sessionPayload(ctx, { plan }) });
  } catch (error) {
    sendResult(ctx, ws, false, error instanceof Error ? error.message : String(error));
  }
}

export async function handlePlanItemUpdate(
  ctx: WorklistContext,
  ws: WebSocket,
  payload: { target: string; status: 'open' | 'in_progress' | 'done' },
): Promise<void> {
  const planPath = planPathOf(ctx);
  if (!planPath) {
    sendResult(ctx, ws, false, 'Plan storage is not configured for this session.');
    return;
  }
  try {
    if (ctx.mutatePlan) {
      const result = await ctx.mutatePlan({
        action: 'status',
        target: payload.target,
        status: payload.status,
      });
      if (!result.ok) {
        sendResult(ctx, ws, false, result.message);
        return;
      }
      const plan = await loadPlan(planPath);
      if (!plan) throw new Error('Plan mutation succeeded but its persisted snapshot is missing.');
      sendResult(ctx, ws, true, result.message);
      ctx.broadcast({ type: 'plan.updated', payload: sessionPayload(ctx, { plan }) });
      return;
    }
    let changed = false;
    const plan = await mutatePlan(planPath, currentSessionId(ctx), async (currentPlan) => {
      const before = currentPlan.updatedAt;
      const next = setPlanItemStatus(currentPlan, payload.target, payload.status);
      changed = next.updatedAt !== before;
      return next;
    });
    if (!changed) {
      sendResult(ctx, ws, false, `No plan item matched "${payload.target}".`);
      return;
    }
    sendResult(ctx, ws, true, `Plan item status updated to "${payload.status}".`);
    ctx.broadcast({ type: 'plan.updated', payload: sessionPayload(ctx, { plan }) });
  } catch (error) {
    sendResult(ctx, ws, false, error instanceof Error ? error.message : String(error));
  }
}

export async function handleWorklistMessage(
  ctx: WorklistContext,
  ws: WebSocket,
  message: WorklistMessage,
): Promise<void> {
  switch (message.type) {
    case 'todos.get':
      handleTodosGet(ctx, ws);
      return;
    case 'todos.clear':
      await handleTodosClear(ctx, ws);
      return;
    case 'todos.remove':
      await handleTodosRemove(
        ctx,
        ws,
        message.payload as { id?: string; index?: number } | undefined,
      );
      return;
    case 'todo.update':
      await handleTodoUpdate(
        ctx,
        ws,
        message.payload as
          | {
              id?: string;
              status?: TodoItem['status'];
              activeForm?: string;
            }
          | undefined,
      );
      return;
    case 'tasks.get':
      await handleTasksGet(ctx, ws);
      return;
    case 'task.update':
      await handleTaskUpdate(
        ctx,
        ws,
        message.payload as {
          id: string;
          status: 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed';
        },
      );
      return;
    case 'plan.get':
      await handlePlanGet(ctx, ws);
      return;
    case 'plan.template_use': {
      const parsed = validatePlanTemplateUsePayload(message.payload);
      if (!parsed.ok) {
        sendResult(ctx, ws, false, parsed.message);
        return;
      }
      await handlePlanTemplateUse(ctx, ws, parsed.value.template);
      return;
    }
    case 'plan.item.update':
      await handlePlanItemUpdate(
        ctx,
        ws,
        message.payload as { target: string; status: 'open' | 'in_progress' | 'done' },
      );
  }
}
