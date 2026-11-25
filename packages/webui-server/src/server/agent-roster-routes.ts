import type { WebSocket } from 'ws';
import type { AgentRosterWSHandler } from './agent-roster-handlers.js';
import type { WSClientMessage } from './types.js';
import { errMessage, send } from './ws-utils.js';

export interface AgentRosterRouteHandlers {
  rosterHandler: AgentRosterWSHandler;
}

export async function handleAgentRosterRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: AgentRosterRouteHandlers,
): Promise<boolean> {
  if (!msg.type.startsWith('agent-roster.')) return false;
  const rawRequestId =
    msg.payload &&
    typeof msg.payload === 'object' &&
    typeof (msg.payload as { requestId?: unknown }).requestId === 'string'
      ? (msg.payload as { requestId: string }).requestId.trim()
      : '';
  const requestId = rawRequestId.length > 0 ? rawRequestId : undefined;
  try {
    const response = await handlers.rosterHandler.handleMessage(
      ws,
      msg.type,
      msg.payload as Record<string, unknown> | undefined,
    );
    send(
      ws,
      requestId
        ? {
            ...response,
            payload: {
              ...(response.payload &&
              typeof response.payload === 'object' &&
              !Array.isArray(response.payload)
                ? response.payload
                : {}),
              requestId,
            },
          }
        : response,
    );
  } catch (error) {
    send(ws, {
      type: msg.type,
      payload: { error: errMessage(error), ...(requestId ? { requestId } : {}) },
    });
  }
  return true;
}
