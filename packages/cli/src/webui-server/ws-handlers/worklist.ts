import {
  type Agent,
  addPlanItem,
  emptyPlan,
  getPlanTemplate,
  loadPlan,
  loadTasks,
  mutatePlan,
  mutateTasks,
  savePlan,
  setPlanItemStatus,
  type TodoItem,
} from '@wrongstack/core';
import type { WebSocket } from 'ws';
import { expectDefined } from '../../provider-config-utils.js';
import type { WsCommon } from './index.js';

/**
 * PR 5d of Issue #30: work-list WebSocket handlers — the agent's todos
 * (`todos.get`/`clear`/`remove`, `todo.update`), the persisted task file
 * (`tasks.get`, `task.update`), and the persisted plan (`plan.get`,
 * `plan.template_use`, `plan.item.update`).
 *
 * Todos are kept inline because the CLI embedded server must update live
 * agent state (`ctx.agent.ctx.state.replaceTodos`) and uses a different
 * result message format (`key.operation_result`) than the shared handlers
 * (`ok`/`error`). Tasks and plan are also kept inline for the same reason:
 * CLI sends `key.operation_result` for task/plan operations while the shared
 * module uses `ok`/`error` — structural unification awaits a decision on
 * which format is canonical.
 *
 * The shared handlers live at `@wrongstack/webui/server/handlers` and are
 * used by the standalone WebUI server (`startWebUI`).
 */

export interface WorklistContext extends WsCommon {
  /** The running agent — todos live on its ctx; plan/task paths in ctx.meta. */
  agent: Agent;
  /** Active session id — used to stamp fresh plans/tasks. */
  sessionId: string;
}

function sendResult(ctx: WsCommon, ws: WebSocket, success: boolean, message: string): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

function currentSessionId(ctx: WorklistContext): string {
  return ctx.agent.ctx.session?.id ?? ctx.sessionId;
}

function sessionPayload<T extends Record<string, unknown>>(
  ctx: WorklistContext,
  payload: T,
): T & { sessionId: string } {
  const provided = payload['sessionId'];
  const sessionId = typeof provided === 'string' && provided.length > 0 ? provided : currentSessionId(ctx);
  return { ...payload, sessionId };
}

const planPathOf = (ctx: WorklistContext): string | undefined => {
  const p = (ctx.agent.ctx.meta as Record<string, unknown>)['plan.path'];
  return typeof p === 'string' && p ? p : undefined;
};

const taskPathOf = (ctx: WorklistContext): string | undefined => {
  const p = (ctx.agent.ctx.meta as Record<string, unknown>)['task.path'];
  return typeof p === 'string' && p ? p : undefined;
};

// ── Todos (inline — must update live agent state) ─────────────────────

export function handleTodosGet(ctx: WorklistContext, ws: WebSocket): void {
  ctx.send(ws, { type: 'todos.updated', payload: sessionPayload(ctx, { todos: [...ctx.agent.ctx.todos] }) });
}

export function handleTodosClear(ctx: WorklistContext, ws: WebSocket): void {
  ctx.agent.ctx.state.replaceTodos([]);
  sendResult(ctx, ws, true, 'Todos cleared');
  ctx.broadcast({ type: 'todos.updated', payload: sessionPayload(ctx, { todos: [] }) });
}

export function handleTodosRemove(
  ctx: WorklistContext,
  ws: WebSocket,
  payload: { id?: string | undefined; index?: number | undefined } | undefined,
): void {
  if (!payload) {
    sendResult(ctx, ws, false, 'Missing id or index');
    return;
  }
  const { id, index } = payload;
  const todos = ctx.agent.ctx.todos;
  let targetIdx = -1;
  if (typeof id === 'string') {
    targetIdx = todos.findIndex((t) => t.id === id);
  } else if (typeof index === 'number' && index > 0) {
    targetIdx = index - 1;
  }
  if (targetIdx < 0 || !todos[targetIdx]) {
    sendResult(ctx, ws, false, 'Todo not found');
    return;
  }
  const removed = expectDefined(todos[targetIdx]);
  const next = [...todos.slice(0, targetIdx), ...todos.slice(targetIdx + 1)];
  ctx.agent.ctx.state.replaceTodos(next);
  sendResult(ctx, ws, true, `Removed: ${removed.content}`);
  ctx.broadcast({ type: 'todos.updated', payload: sessionPayload(ctx, { todos: next }) });
}

export function handleTodoUpdate(
  ctx: WorklistContext,
  ws: WebSocket,
  payload: { id: string; status?: TodoItem['status'] | undefined; activeForm?: string | undefined },
): void {
  const todos = ctx.agent.ctx.todos;
  const idx = todos.findIndex((t) => t.id === payload.id);
  if (idx === -1) {
    sendResult(ctx, ws, false, 'Todo not found');
    return;
  }
  const next = [...todos];
  const existing = expectDefined(next[idx]);
  next[idx] = {
    ...existing,
    status: payload.status ?? existing.status,
    activeForm: payload.activeForm !== undefined ? payload.activeForm : existing.activeForm,
  };
  ctx.agent.ctx.state.replaceTodos(next);
  sendResult(ctx, ws, true, `Todo "${existing.content}" updated`);
  ctx.broadcast({ type: 'todos.updated', payload: sessionPayload(ctx, { todos: next }) });
}

// ── Tasks (delegate to shared — file-backed, identical logic) ──────────

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
    ctx.send(ws, { type: 'tasks.updated', payload: sessionPayload(ctx, { tasks: file?.tasks ?? [] }) });
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
    const file = await mutateTasks(taskPath, currentSessionId(ctx), async (f) => {
      const task = f.tasks.find((t) => t.id === payload.id);
      if (!task) return f;
      task.status = payload.status;
      task.updatedAt = new Date().toISOString();
      return f;
    });
    sendResult(ctx, ws, true, `Task status updated to "${payload.status}".`);
    ctx.broadcast({ type: 'tasks.updated', payload: sessionPayload(ctx, { tasks: file.tasks }) });
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}

// ── Plan (delegate to shared — file-backed, identical logic) ────────────

export async function handlePlanGet(ctx: WorklistContext, ws: WebSocket): Promise<void> {
  const planPath = planPathOf(ctx);
  const emptySnapshot = () => ({
    version: 1,
    sessionId: currentSessionId(ctx),
    updatedAt: new Date().toISOString(),
    items: [],
  });
  if (!planPath) {
    ctx.send(ws, {
      type: 'plan.updated',
      payload: sessionPayload(ctx, { plan: null, error: 'Plan storage is not configured for this session.' }),
    });
    return;
  }
  try {
    const plan = await loadPlan(planPath);
    ctx.send(ws, { type: 'plan.updated', payload: sessionPayload(ctx, { plan: plan ?? emptySnapshot() }) });
  } catch {
    ctx.send(ws, { type: 'plan.updated', payload: sessionPayload(ctx, { plan: emptySnapshot() }) });
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
    const tpl = getPlanTemplate(template);
    if (!tpl) {
      sendResult(ctx, ws, false, `Unknown template "${template}".`);
      return;
    }
    let plan = (await loadPlan(planPath)) ?? emptyPlan(currentSessionId(ctx));
    for (const item of tpl.items) {
      ({ plan } = addPlanItem(plan, item.title, item.details));
    }
    await savePlan(planPath, plan);
    sendResult(ctx, ws, true, `Applied template "${tpl.name}" — ${tpl.items.length} items added.`);
    ctx.broadcast({ type: 'plan.updated', payload: sessionPayload(ctx, { plan }) });
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
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
    let changed = false;
    const plan = await mutatePlan(planPath, currentSessionId(ctx), async (p) => {
      const before = p.updatedAt;
      const next = setPlanItemStatus(p, payload.target, payload.status);
      changed = next.updatedAt !== before;
      return next;
    });
    if (!changed) {
      sendResult(ctx, ws, false, `No plan item matched "${payload.target}".`);
      return;
    }
    sendResult(ctx, ws, true, `Plan item status updated to "${payload.status}".`);
    ctx.broadcast({ type: 'plan.updated', payload: sessionPayload(ctx, { plan }) });
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}
