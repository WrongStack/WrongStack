import type { WebSocket } from 'ws';
import { handleAutonomySwitch, type PrefsHandlerContext } from './prefs-handlers.js';
import type { WSClientMessage } from './types.js';
import { validateAutonomySwitchPayload } from './ws-payload-validation.js';
import { sendResult } from './ws-utils.js';

export interface AutonomyRouteHandlers {
  switchMode: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
}

/** The session a WS request originated from, when the client stamped one. */
function requestSessionId(msg: WSClientMessage): string | undefined {
  const payload = msg.payload;
  const value =
    payload && typeof payload === 'object'
      ? (payload as { sessionId?: unknown }).sessionId
      : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function createAutonomyRouteHandlers(ctx: PrefsHandlerContext): AutonomyRouteHandlers {
  return {
    switchMode: (ws, message) => {
      const parsed = validateAutonomySwitchPayload(message.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      handleAutonomySwitch(ctx, ws, parsed.value.mode, requestSessionId(message));
    },
  };
}

export async function handleAutonomyRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: AutonomyRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'autonomy.switch':
      await handlers.switchMode(ws, msg);
      return true;
    default:
      return false;
  }
}
