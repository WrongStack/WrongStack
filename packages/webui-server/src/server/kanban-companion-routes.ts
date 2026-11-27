import { getKanbanCompanionEnabled, setKanbanCompanionEnabled } from '@wrongstack/kanban';
import type { WebSocket } from 'ws';
import { correlatedReply } from './correlated-reply.js';
import { fail, ok } from './kanban-route-helpers.js';
import type { KanbanSupervisor } from './kanban-supervisor.js';
import type { WSServerMessage } from './types.js';
import { errMessage } from './ws-utils.js';

/**
 * Reply (and change-broadcast) type for both companion requests. Unlike the
 * other kanban routes, the answer does not reuse the request's type, so the
 * client correlates by `requestId` rather than by frame type.
 */
export const KANBAN_COMPANION_STATUS_TYPE = 'kanban.companion.status';

interface KanbanCompanionRouteContext {
  projectRoot: string;
  broadcast?: ((msg: WSServerMessage) => void) | undefined;
  /**
   * Present on hosts that run the background supervisor. A disable that
   * reaches this process stops its in-flight agentic management immediately;
   * hosts without the handle converge on the supervisor's next pass, which
   * reads the same workspace flag before scheduling.
   */
  supervisor?: KanbanSupervisor | undefined;
}

/**
 * `kanban.companion.get` / `kanban.companion.set` — the project-wide switch
 * for the agentic Kanban companion. Both answer with
 * `kanban.companion.status`; the flag itself lives in the workspace under the
 * domain's authoritative lease and write fences, and the workspace is always
 * the server-selected root — no client path is accepted or read.
 */
export async function handleKanbanCompanionRoute(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanCompanionRouteContext,
): Promise<boolean> {
  if (type !== 'kanban.companion.get' && type !== 'kanban.companion.set') return false;
  // `handleKanbanRoute` keys its requestId proxy on the request type, which
  // the status reply never uses — re-correlate on the reply type so the direct
  // answer (success or failure) echoes the asker's requestId. Broadcasts go
  // through `ctx.broadcast` and deliberately carry no requestId.
  ws = correlatedReply(ws, payload, [KANBAN_COMPANION_STATUS_TYPE]).socket;
  try {
    if (type === 'kanban.companion.get') {
      ok(ws, KANBAN_COMPANION_STATUS_TYPE, {
        enabled: await getKanbanCompanionEnabled(ctx.projectRoot),
      });
      return true;
    }
    await setCompanionEnabled(ws, payload, ctx);
    return true;
  } catch (error) {
    fail(ws, KANBAN_COMPANION_STATUS_TYPE, errMessage(error));
    return true;
  }
}

async function setCompanionEnabled(
  ws: WebSocket,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanCompanionRouteContext,
): Promise<void> {
  if (typeof payload?.['enabled'] !== 'boolean') {
    fail(ws, KANBAN_COMPANION_STATUS_TYPE, 'enabled must be a boolean');
    return;
  }
  const after = await setKanbanCompanionEnabled(ctx.projectRoot, payload['enabled']);
  ok(ws, KANBAN_COMPANION_STATUS_TYPE, { enabled: after });
  // Always broadcast after the authoritative result — including when the value
  // did not change. A read-before-write suppression races concurrent opposite
  // writes: both read the same stale "before", the winning write then
  // suppresses its broadcast, and every other menu stays stale. Re-broadcasting
  // an idempotent set is cheap and pulls every client onto the authoritative
  // state. Scope: this host serves exactly one workspace, so a process-wide
  // broadcast IS the project scope — there is no per-connection project filter
  // to apply, and no client-supplied path is accepted for the flag.
  ctx.broadcast?.({
    type: KANBAN_COMPANION_STATUS_TYPE,
    payload: { success: true, data: { enabled: after } },
  });
  if (!after) ctx.supervisor?.cancelManagement();
}
