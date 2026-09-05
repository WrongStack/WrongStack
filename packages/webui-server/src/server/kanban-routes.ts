import type { Context } from '@wrongstack/core/agent';
import type { WebSocket } from 'ws';
import { handleKanbanBoardRoute } from './kanban-board-routes.js';
import { handleKanbanContractRoute } from './kanban-contract-routes.js';
import { handleKanbanDecompositionRoute } from './kanban-decomposition-routes.js';
import { handleKanbanTaskDispatch, type KanbanTaskDispatcher } from './kanban-dispatch.js';
import { handleKanbanItemRoute } from './kanban-item-routes.js';
import { handleKanbanOrchestrationRoute } from './kanban-orchestration-routes.js';
import { fail, ok } from './kanban-route-helpers.js';
import type { KanbanSupervisor } from './kanban-supervisor.js';
import { handleKanbanTaskLifecycleRoute } from './kanban-task-lifecycle-routes.js';
import { handleKanbanTaskRoute } from './kanban-task-routes.js';
import type { WSClientMessage, WSServerMessage } from './types.js';
import { messageSessionId } from './ws-utils.js';

export { type KanbanBoardPage, paginateKanbanBoards } from './kanban-route-pagination.js';
export { KANBAN_CLIENT_MESSAGE_TYPES } from './kanban-route-protocol.js';

export interface KanbanRouteContext {
  projectRoot: string;
  context?: Context | undefined;
  /**
   * Every session a tab is currently displaying.
   *
   * `context.session` is only the one the runtime last switched to. With four
   * tabs open, guarding `kanban.delete` on that alone protected ONE live board
   * and left the other three deletable out from under the tabs showing them.
   * Hosts that track displayed tabs pass this; single-session hosts omit it
   * and the runtime session remains the whole set.
   */
  getDisplayedSessionIds?: (() => string[]) | undefined;
  broadcast?: ((msg: WSServerMessage) => void) | undefined;
  dispatchTask?: KanbanTaskDispatcher | undefined;
  /**
   * Background supervisor (if enabled). When present, the `kanban.supervisor.audit`
   * and `kanban.supervisor.status` routes delegate to its in-process audit cycle
   * instead of running a second reconcile/health/recover chain — preventing the
   * double-audit that happens when both paths refresh the same board concurrently.
   */
  supervisor?: KanbanSupervisor | undefined;
  /** Set per message by `handleKanbanRoute` — see `KanbanRouteHelperContext`. */
  requestSessionId?: string | undefined;
}

export async function handleKanbanRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  rawCtx: KanbanRouteContext,
): Promise<boolean> {
  if (!msg.type.startsWith('kanban.')) return false;
  const payload = msg.payload as Record<string, unknown> | undefined;
  const type = msg.type;
  // Attribute this message to the tab that sent it. Everything downstream
  // (`activityContext`, `touchTaskPresence`) reads it through
  // `actingSessionId`, so one stamp here covers every route below.
  const requestSessionId = messageSessionId(msg);
  const ctx: KanbanRouteContext = requestSessionId ? { ...rawCtx, requestSessionId } : rawCtx;

  try {
    if (await handleKanbanDecompositionRoute(ws, type, payload, ctx)) return true;
    if (await handleKanbanContractRoute(ws, type, payload, ctx)) return true;
    if (await handleKanbanTaskRoute(ws, type, payload, ctx)) return true;
    if (await handleKanbanBoardRoute(ws, type, payload, ctx)) return true;
    if (await handleKanbanOrchestrationRoute(ws, type, payload, ctx)) return true;
    if (await handleKanbanTaskLifecycleRoute(ws, type, payload, ctx)) return true;
    if (await handleKanbanItemRoute(ws, type, payload, ctx)) return true;

    switch (type) {
      case 'kanban.task.dispatch':
        await handleKanbanTaskDispatch(ws, payload, ctx);
        return true;
      case 'kanban.capabilities':
        ok(ws, type, { dispatchSupported: Boolean(ctx.dispatchTask) });
        return true;
      default:
        fail(ws, type, `Unknown kanban message type: ${type}`);
        return true;
    }
  } catch (err) {
    fail(ws, type, err instanceof Error ? err.message : String(err));
    return true;
  }
}
