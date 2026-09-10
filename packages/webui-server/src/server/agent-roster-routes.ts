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
  try {
    const response = await handlers.rosterHandler.handleMessage(
      ws,
      msg.type,
      msg.payload as Record<string, unknown> | undefined,
    );
    send(ws, response);
  } catch (error) {
    send(ws, {
      type: msg.type,
      payload: { error: errMessage(error) },
    });
  }
  return true;
}
