import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';

export interface ConversationRouteHandlers {
  userMessage: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  topicAdvice: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  abort: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  ping: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  confirmTool: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
}

export async function handleConversationRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: ConversationRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'user_message':
      await handlers.userMessage(ws, msg);
      return true;
    case 'topic.advice':
      await handlers.topicAdvice(ws, msg);
      return true;
    case 'abort':
      await handlers.abort(ws, msg);
      return true;
    case 'ping':
      await handlers.ping(ws, msg);
      return true;
    case 'tool.confirm_result':
      await handlers.confirmTool(ws, msg);
      return true;
    default:
      return false;
  }
}
