// ── Shared Worklist Handlers ─────────────────────────────────────────────────
// Extracted from standalone server (packages/webui/src/server/index.ts) and CLI
// embedded server (packages/cli/src/webui-server/). Both servers use these
// handlers for todos, tasks, and plan operations. Keep them in sync.
//
// Message types handled here:
//   todos.get | todos.clear | todos.remove | todo.update
//   tasks.get | task.update
//   plan.get | plan.template_use | plan.item.update
// ─────────────────────────────────────────────────────────────────────────────

import type { WebSocket } from 'ws';
import type { TodoItem } from '@wrongstack/core';
import { validatePlanTemplateUsePayload } from '../ws-payload-validation.js';

// ── Shared result helper ───────────────────────────────────────────────────────

function sendResult(
  ws: WebSocket,
  ctx: WorklistContext,
  ok: boolean,
  message: string,
): void {
  ctx.send(ws, { type: ok ? 'ok' : 'error', message });
}

function sessionPayload<T extends Record<string, unknown>>(
  ctx: WorklistContext,
  payload: T,
): T & { sessionId: string } {
  const provided = payload['sessionId'];
  const fallback = ctx.context.session?.id ?? '';
  const sessionId = typeof provided === 'string' && provided.length > 0 ? provided : fallback;
  return { ...payload, sessionId };
}

// ── Context interface ─────────────────────────────────────────────────────────
// Both servers satisfy this with their own local state.

export interface WorklistContext {
  context: {
    todos: TodoItem[];
    meta: Record<string, unknown>;
    session: { id: string } | null;
    state?: unknown;
  };
  send: (ws: WebSocket, msg: object) => void;
  broadcast: (msg: object) => void;
  /**
   * Optional mutator for in-memory todo state. Servers that manage live
   * agent state (e.g. the CLI embedded server) provide this so handlers
   * can update the agent's todo list directly. Standalone server may omit.
   */
  replaceTodos?: (todos: TodoItem[]) => void;
}

// ── Todos ─────────────────────────────────────────────────────────────────────

export function handleTodosGet(ctx: WorklistContext, ws: WebSocket): void {
  ctx.send(ws, { type: 'todos.updated', payload: sessionPayload(ctx, { todos: ctx.context.todos }) });
}

export function handleTodosClear(ctx: WorklistContext, ws: WebSocket): void {
  ctx.replaceTodos?.([]);
  ctx.broadcast({ type: 'todos.cleared', payload: sessionPayload(ctx, {}) });
  sendResult(ws, ctx, true, 'Todo board cleared.');
}

export function handleTodosRemove(
  ctx: WorklistContext,
  ws: WebSocket,
  payload: { id?: string; index?: number } | undefined,
): void {
  if (!payload || (payload.id === undefined && payload.index === undefined)) {
    sendResult(ws, ctx, false, 'todos.remove requires id or index.');
    return;
  }
  const next =
    payload.id !== undefined
      ? ctx.context.todos.filter((t) => t.id !== payload.id)
      : ctx.context.todos.filter((_, i) => i !== (payload.index as number));
  ctx.replaceTodos?.(next);
  ctx.broadcast({ type: 'todos.updated', payload: sessionPayload(ctx, { todos: next }) });
  sendResult(ws, ctx, true, 'Todo item removed.');
}

export function handleTodoUpdate(
  ctx: WorklistContext,
  ws: WebSocket,
  payload: { id: string; status?: TodoItem['status']; activeForm?: string },
): void {
  const todo = ctx.context.todos.find((t) => t.id === payload.id);
  if (!todo) {
    sendResult(ws, ctx, false, `No todo with id "${payload.id}".`);
    return;
  }
  const next = ctx.context.todos.map((t) =>
    t.id === payload.id
      ? { ...t, ...(payload.status !== undefined && { status: payload.status }), ...(payload.activeForm !== undefined && { activeForm: payload.activeForm }) }
      : t,
  );
  ctx.replaceTodos?.(next);
  ctx.broadcast({ type: 'todos.updated', payload: sessionPayload(ctx, { todos: next }) });
  sendResult(ws, ctx, true, `Todo "${todo.content}" updated.`);
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export async function handleTasksGet(ctx: WorklistContext, ws: WebSocket): Promise<void> {
  const taskPath = ctx.context.meta['task.path'];
  if (typeof taskPath === 'string' && taskPath) {
    try {
      const { loadTasks } = await import('@wrongstack/core');
      const file = await loadTasks(taskPath);
      ctx.send(ws, { type: 'tasks.updated', payload: sessionPayload(ctx, { tasks: file?.tasks ?? [] }) });
    } catch {
      ctx.send(ws, { type: 'tasks.updated', payload: sessionPayload(ctx, { tasks: [] }) });
    }
  } else {
    ctx.send(ws, {
      type: 'tasks.updated',
      payload: sessionPayload(ctx, { tasks: [], error: 'Task storage not configured.' }),
    });
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
  const taskPath = ctx.context.meta['task.path'];
  if (typeof taskPath !== 'string' || !taskPath) {
    sendResult(ws, ctx, false, 'Task storage is not configured for this session.');
    return;
  }
  try {
    const { loadTasks, saveTasks } = await import('@wrongstack/core');
    const file = await loadTasks(taskPath);
    if (!file) {
      sendResult(ws, ctx, false, 'No task file found.');
      return;
    }
    const idx = file.tasks.findIndex((t) => t.id === payload.id);
    if (idx === -1) {
      sendResult(ws, ctx, false, `Task "${payload.id}" not found.`);
      return;
    }
    file.tasks[idx] = { ...file.tasks[idx], status: payload.status };
    await saveTasks(taskPath, file);
    ctx.broadcast({ type: 'tasks.updated', payload: sessionPayload(ctx, { tasks: file.tasks }) });
    sendResult(ws, ctx, true, `Task "${payload.id}" marked ${payload.status}.`);
  } catch (err) {
    sendResult(ws, ctx, false, String(err));
  }
}

// ── Plan ───────────────────────────────────────────────────────────────────────

export async function handlePlanGet(ctx: WorklistContext, ws: WebSocket): Promise<void> {
  const planPath = ctx.context.meta['plan.path'];
  const sessionId = ctx.context.session?.id ?? '';
  if (typeof planPath === 'string' && planPath) {
    try {
      const { loadPlan } = await import('@wrongstack/core');
      const plan = await loadPlan(planPath);
      ctx.send(ws, {
        type: 'plan.updated',
        payload: sessionPayload(ctx, {
          plan: plan ?? {
            version: 1,
            sessionId,
            updatedAt: new Date().toISOString(),
            items: [],
          },
        }),
      });
    } catch {
      ctx.send(ws, {
        type: 'plan.updated',
        payload: sessionPayload(ctx, {
          plan: {
            version: 1,
            sessionId,
            updatedAt: new Date().toISOString(),
            items: [],
          },
        }),
      });
    }
  } else {
    ctx.send(ws, {
      type: 'plan.updated',
      payload: sessionPayload(ctx, { plan: null, error: 'Plan storage is not configured for this session.' }),
    });
  }
}

export async function handlePlanTemplateUse(ctx: WorklistContext, ws: WebSocket, template: string): Promise<void> {
  const planPath = ctx.context.meta['plan.path'];
  const sessionId = ctx.context.session?.id ?? '';
  if (typeof planPath !== 'string' || !planPath) {
    sendResult(ws, ctx, false, 'Plan storage is not configured for this session.');
    return;
  }
  try {
    const { getPlanTemplate, loadPlan, savePlan, emptyPlan, addPlanItem } = await import('@wrongstack/core');
    const tpl = getPlanTemplate(template);
    if (!tpl) {
      sendResult(ws, ctx, false, `Unknown template "${template}".`);
      return;
    }
    let plan = (await loadPlan(planPath)) ?? emptyPlan(sessionId);
    for (const item of tpl.items) {
      ({ plan } = addPlanItem(plan, item.title, item.details));
    }
    await savePlan(planPath, plan);
    sendResult(ws, ctx, true, `Applied template "${tpl.name}" — ${tpl.items.length} items added.`);
    ctx.broadcast({ type: 'plan.updated', payload: sessionPayload(ctx, { plan }) });
  } catch (err) {
    sendResult(ws, ctx, false, String(err));
  }
}

export async function handlePlanItemUpdate(
  ctx: WorklistContext,
  ws: WebSocket,
  payload: { target: string; status: 'open' | 'in_progress' | 'done' },
): Promise<void> {
  const planPath = ctx.context.meta['plan.path'];
  const sessionId = ctx.context.session?.id ?? '';
  if (typeof planPath !== 'string' || !planPath) {
    sendResult(ws, ctx, false, 'Plan storage is not configured for this session.');
    return;
  }
  try {
    const { mutatePlan, setPlanItemStatus } = await import('@wrongstack/core');
    let changed = false;
    const plan = await mutatePlan(planPath, sessionId, async (p) => {
      const before = p.updatedAt;
      const updated = setPlanItemStatus(p, payload.target, payload.status);
      changed = updated.updatedAt !== before;
      return updated;
    });
    if (!changed) {
      sendResult(ws, ctx, false, `No plan item matched "${payload.target}".`);
      return;
    }
    sendResult(ws, ctx, true, `Plan item status updated to "${payload.status}".`);
    ctx.broadcast({ type: 'plan.updated', payload: sessionPayload(ctx, { plan }) });
  } catch (err) {
    sendResult(ws, ctx, false, String(err));
  }
}

// ── Dispatcher ──────────────────────────────────────────────────────────────────
// Single entry point for the nine worklist message types, so the host server's
// switch delegates one grouped case here instead of repeating the per-type
// `makeWorklistContext()` boilerplate. Unknown types are a no-op (the caller
// only routes worklist types to this function).

/** Loosely-typed worklist WS message — payload shapes are narrowed per case. */
export interface WorklistMessage {
  type: string;
  payload?: unknown;
}

export async function handleWorklistMessage(
  ctx: WorklistContext,
  ws: WebSocket,
  msg: WorklistMessage,
): Promise<void> {
  switch (msg.type) {
    case 'todos.get':
      handleTodosGet(ctx, ws);
      return;
    case 'todos.clear':
      handleTodosClear(ctx, ws);
      return;
    case 'todos.remove':
      handleTodosRemove(ctx, ws, msg.payload as { id?: string; index?: number } | undefined);
      return;
    case 'todo.update':
      handleTodoUpdate(
        ctx,
        ws,
        msg.payload as { id: string; status?: TodoItem['status']; activeForm?: string },
      );
      return;
    case 'tasks.get':
      await handleTasksGet(ctx, ws);
      return;
    case 'task.update':
      await handleTaskUpdate(
        ctx,
        ws,
        msg.payload as {
          id: string;
          status: 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed';
        },
      );
      return;
    case 'plan.get':
      await handlePlanGet(ctx, ws);
      return;
    case 'plan.template_use': {
      const parsed = validatePlanTemplateUsePayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, ctx, false, parsed.message);
        return;
      }
      await handlePlanTemplateUse(ctx, ws, parsed.value.template);
      return;
    }
    case 'plan.item.update':
      await handlePlanItemUpdate(
        ctx,
        ws,
        msg.payload as { target: string; status: 'open' | 'in_progress' | 'done' },
      );
      return;
  }
}
