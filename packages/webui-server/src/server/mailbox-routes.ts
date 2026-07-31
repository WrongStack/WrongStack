import type { EventBus } from '@wrongstack/core/kernel';
import type { WebSocket } from 'ws';
import {
  handleMailboxAction,
  handleMailboxAgents,
  handleMailboxClear,
  handleMailboxCompact,
  handleMailboxMessages,
  handleMailboxPurge,
  handleMailboxSend,
  type MailboxHandlerDeps,
} from './mailbox-handlers.js';
import type { WSClientMessage } from './types.js';
import {
  validateMailboxActionPayload,
  validateMailboxAgentsPayload,
  validateMailboxMessagesPayload,
  validateMailboxPurgePayload,
  validateMailboxSendPayload,
} from './ws-payload-validation.js';
import { send, sendResult } from './ws-utils.js';

export interface MailboxRouteHandlers {
  action: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  send: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  messages: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  agents: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  clear: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  purge: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  compact: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
}

export interface MailboxRouteContext {
  getProjectRoot: () => string;
  getGlobalRoot: () => string;
  events?: EventBus | undefined;
}

export function createMailboxRouteHandlers(ctx: MailboxRouteContext): MailboxRouteHandlers {
  const deps: MailboxHandlerDeps = {
    projectRoot: ctx.getProjectRoot,
    globalRoot: ctx.getGlobalRoot,
    ...(ctx.events ? { events: ctx.events } : {}),
  };
  return {
    action: (ws, msg) => {
      const parsed = validateMailboxActionPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      return handleMailboxAction(ws, deps, parsed.value);
    },
    send: (ws, msg) => {
      const parsed = validateMailboxSendPayload(msg.payload);
      if (!parsed.ok) {
        const requestId =
          typeof msg.payload === 'object' &&
          msg.payload !== null &&
          typeof (msg.payload as { requestId?: unknown }).requestId === 'string'
            ? (msg.payload as { requestId: string }).requestId
            : undefined;
        if (requestId !== undefined) {
          send(ws, {
            type: 'mailbox.sent',
            payload: { requestId, success: false, error: parsed.message },
          });
          return;
        }
        sendResult(ws, false, parsed.message);
        return;
      }
      return handleMailboxSend(ws, deps, parsed.value);
    },
    messages: (ws, msg) => {
      const parsed = validateMailboxMessagesPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      return handleMailboxMessages(ws, deps, parsed.value);
    },
    agents: (ws, msg) => {
      const parsed = validateMailboxAgentsPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      return handleMailboxAgents(ws, deps, parsed.value);
    },
    clear: (ws) => handleMailboxClear(ws, deps),
    purge: (ws, msg) => {
      const parsed = validateMailboxPurgePayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      return handleMailboxPurge(ws, deps, parsed.value);
    },
    compact: (ws, msg) =>
      handleMailboxCompact(
        ws,
        deps,
        (msg.payload as {
          readMaxAgeMs?: number;
          defaultTtlMs?: number;
          completedMaxAgeMs?: number;
          incompleteMaxAgeMs?: number;
        }) ?? {},
      ),
  };
}

export async function handleMailboxRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: MailboxRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'mailbox.action':
      await handlers.action(ws, msg);
      return true;
    case 'mailbox.send':
      await handlers.send(ws, msg);
      return true;
    case 'mailbox.messages':
      await handlers.messages(ws, msg);
      return true;
    case 'mailbox.agents':
      await handlers.agents(ws, msg);
      return true;
    case 'mailbox.clear':
      await handlers.clear(ws, msg);
      return true;
    case 'mailbox.purge':
      await handlers.purge(ws, msg);
      return true;
    case 'mailbox.compact':
      await handlers.compact(ws, msg);
      return true;
    default:
      return false;
  }
}
