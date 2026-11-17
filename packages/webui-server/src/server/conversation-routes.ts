import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';

export interface ConversationRouteHandlers {
  userMessage: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  topicAdvice: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  abort: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  ping: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  confirmTool: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  submitUserInput: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  /** `queue.add` / `queue.remove` / `queue.clear` / `queue.get`: the host-owned prompt queue. */
  queue?: ((ws: WebSocket, msg: WSClientMessage) => Promise<void> | void) | undefined;
  btw?: ((ws: WebSocket, msg: WSClientMessage) => Promise<void> | void) | undefined;
  /** `composer.warm`: open the session's provider connection while the user types. */
  warmProvider?: ((ws: WebSocket, msg: WSClientMessage) => Promise<void> | void) | undefined;
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
    case 'user.input_submit':
      await handlers.submitUserInput(ws, msg);
      return true;
    case 'queue.add':
    case 'queue.remove':
    case 'queue.clear':
    case 'queue.get':
      if (!handlers.queue) return false;
      await handlers.queue(ws, msg);
      return true;
    case 'btw.add':
    case 'btw.get':
      if (!handlers.btw) return false;
      await handlers.btw(ws, msg);
      return true;
    case 'composer.warm':
      if (!handlers.warmProvider) return false;
      await handlers.warmProvider(ws, msg);
      return true;
    default:
      return false;
  }
}
