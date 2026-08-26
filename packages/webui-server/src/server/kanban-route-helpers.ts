import type { Context } from '@wrongstack/core/agent';
import type { KanbanBoard, KanbanEventContext, KanbanTask } from '@wrongstack/kanban';
import { touchKanbanPresence } from '@wrongstack/kanban';
import { applySessionKanbanTaskToSource } from '@wrongstack/tools/session-kanban';
import type { WebSocket } from 'ws';
import type { WSServerMessage } from './types.js';
import { send } from './ws-utils.js';

export interface KanbanRouteHelperContext {
  projectRoot: string;
  context?: Context | undefined;
  broadcast?: ((msg: WSServerMessage) => void) | undefined;
  /**
   * The session of the tab that sent THIS message.
   *
   * Board contents are addressed by `boardId`, so they never crossed tabs —
   * but every activity entry and presence ping was stamped with
   * `context.session`, the session the runtime last switched to. With four
   * tabs open, tab 3 moving a card was recorded as tab 1's work. Set per
   * message by `handleKanbanRoute`; absent on single-session hosts, where the
   * runtime session is the only answer there is.
   */
  requestSessionId?: string | undefined;
}

/** Who is acting: the tab that asked, falling back to the runtime session. */
export function actingSessionId(ctx: KanbanRouteHelperContext): string | undefined {
  return ctx.requestSessionId ?? ctx.context?.session?.id;
}

export async function syncSessionSource(
  ctx: KanbanRouteHelperContext,
  task: KanbanTask,
  remove = false,
): Promise<void> {
  if (!ctx.context) return;
  const update = await applySessionKanbanTaskToSource(ctx.context, task, { remove });
  const sessionId = ctx.context.session?.id ?? '';
  if (update.todos)
    ctx.broadcast?.({ type: 'todos.updated', payload: { sessionId, todos: update.todos } });
  if (update.tasks)
    ctx.broadcast?.({ type: 'tasks.updated', payload: { sessionId, tasks: update.tasks.tasks } });
  if (update.plan)
    ctx.broadcast?.({ type: 'plan.updated', payload: { sessionId, plan: update.plan } });
}

export function ok(ws: WebSocket, type: string, data?: unknown): void {
  send(ws, { type, payload: { success: true, data: data ?? null } });
}

export function fail(ws: WebSocket, type: string, message: string): void {
  send(ws, { type, payload: { success: false, error: message } });
}

export function has(payload: Record<string, unknown> | undefined, key: string): boolean {
  return payload !== undefined && Object.hasOwn(payload, key);
}

export function activityContext(
  ctx: KanbanRouteHelperContext,
  actor?: string,
  note?: string,
): KanbanEventContext {
  const sessionId = actingSessionId(ctx);
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(actor ? { actor } : {}),
    ...(note?.trim() ? { note: note.trim() } : {}),
  };
}

export async function touchTaskPresence(
  ctx: KanbanRouteHelperContext,
  boardId: string,
  taskId: string,
): Promise<KanbanBoard | null> {
  const context = ctx.context;
  const sessionId = actingSessionId(ctx);
  if (!context || !sessionId) return null;
  try {
    return await touchKanbanPresence(ctx.projectRoot, boardId, {
      sessionId,
      agentId: context.agentId || 'webui',
      agentName: context.agentName || context.agentId || 'WebUI',
      taskId,
    });
  } catch {
    return null;
  }
}

export function findTask(tasks: KanbanTask[], taskId: string): KanbanTask | undefined {
  return tasks.find((task) => task.id === taskId || task.id.startsWith(taskId));
}
