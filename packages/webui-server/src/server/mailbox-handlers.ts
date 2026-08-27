/**
 * Mailbox WebSocket handlers for the WebUI.
 *
 * Handles `mailbox.messages` and `mailbox.agents` message types.
 * The frontend sends these to populate the mailbox panel; the server
 * reads from the server-backed project mailbox and responds.
 */

import {
  actionToAckInput,
  getSharedProjectMailbox,
  isMailboxMessageVisibleTo,
  MAILBOX_TYPE_PROPERTIES,
  mailboxIdentityBase,
  type RemoteMailbox,
  resolveProjectDir,
} from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { WebSocket } from 'ws';
import type { MailboxActionPayload, MailboxSendPayload } from './ws-payload-validation.js';
import { errMessage, send } from './ws-utils.js';

export interface MailboxHandlerDeps {
  /** Absolute project root or a live getter for hosts that can switch projects. */
  projectRoot: string | (() => string);
  /** Global WrongStack root (~/.wrongstack), or a live getter. */
  globalRoot: string | (() => string);
  /** Host event bus used by mailbox mutation/activity notifications. */
  events?: EventBus | undefined;
}

function current(value: string | (() => string)): string {
  return typeof value === 'function' ? value() : value;
}

export function getMailboxForDeps(deps: MailboxHandlerDeps): RemoteMailbox | null {
  const projectRoot = current(deps.projectRoot);
  const globalRoot = current(deps.globalRoot);
  if (!projectRoot || !globalRoot) return null;
  const dir = resolveProjectDir(projectRoot, globalRoot);
  return getSharedProjectMailbox(dir, deps.events);
}

// ── Handlers ──────────────────────────────────────────────────────────

export async function handleMailboxAction(
  ws: WebSocket,
  deps: MailboxHandlerDeps,
  payload: MailboxActionPayload,
): Promise<void> {
  const mb = getMailboxForDeps(deps);
  if (!mb) {
    send(ws, {
      type: 'mailbox.action_result',
      payload: {
        requestId: payload.requestId,
        success: false,
        error: 'No project root available',
      },
    });
    return;
  }
  try {
    const message =
      payload.action === 'soft-delete'
        ? await mb.softDelete(payload.mailId, payload.readerId)
        : await mb.ack(actionToAckInput(payload.action, payload));
    send(ws, {
      type: 'mailbox.action_result',
      payload: {
        requestId: payload.requestId,
        success: message !== null,
        action: payload.action,
        mailId: payload.mailId,
      },
    });
  } catch (err) {
    send(ws, {
      type: 'mailbox.action_result',
      payload: {
        requestId: payload.requestId,
        success: false,
        action: payload.action,
        mailId: payload.mailId,
        error: errMessage(err),
      },
    });
  }
}

/**
 * Bind a browser-composed message to the tab that composed it.
 *
 * `to: 'leader'` is the alias for "this session's leader agent", and with one
 * session it is unambiguous. With four tabs it is not: every tab's agent is
 * registered as a leader, they all poll the same project mailbox, and a
 * message with no affinity token is accepted by ALL of them
 * (`acceptMailboxMessageForSession` treats "no affinity" as "for everyone").
 * A "btw" typed in tab 3 while tab 1 was running therefore steered tab 1 too.
 *
 * Deliberately narrow: only the ambiguous alias is scoped. A message addressed
 * to a NAMED agent already identifies exactly one recipient, and an explicit
 * broadcast means what it says — scoping either of those would change what the
 * user asked for rather than fix an ambiguity.
 */
function scopeToSenderSession(
  payload: MailboxSendPayload,
): { sessionAffinity: { sessionId: string } } | Record<string, never> {
  if (!payload.sessionId) return {};
  if (payload.to.trim().toLowerCase() !== 'leader') return {};
  return { sessionAffinity: { sessionId: payload.sessionId } };
}

/** Persist a human-authored WebUI message in the shared project mailbox. */
export async function handleMailboxSend(
  ws: WebSocket,
  deps: MailboxHandlerDeps,
  payload: MailboxSendPayload,
): Promise<void> {
  const mb = getMailboxForDeps(deps);
  if (!mb) {
    send(ws, {
      type: 'mailbox.sent',
      payload: {
        requestId: payload.requestId,
        success: false,
        error: 'No project root available',
      },
    });
    return;
  }
  try {
    const message = await mb.send({
      from: payload.from ?? 'webui',
      to: payload.to,
      type: payload.type,
      audience: payload.audience,
      subject: payload.subject,
      body: payload.body,
      priority: payload.priority,
      replyTo: payload.replyTo,
      ...(payload.sessionId ? { senderSessionId: payload.sessionId } : {}),
      ...scopeToSenderSession(payload),
    });
    send(ws, {
      type: 'mailbox.sent',
      payload: {
        requestId: payload.requestId,
        success: true,
        messageId: message.id,
        from: message.from,
        to: message.to,
        audience: message.audience ?? 'all',
      },
    });
  } catch (err) {
    send(ws, {
      type: 'mailbox.sent',
      payload: {
        requestId: payload.requestId,
        success: false,
        error: errMessage(err),
      },
    });
  }
}

/**
 * List recent mailbox messages. Frontend sends:
 *   { type: 'mailbox.messages', limit?: number, incompleteOnly?: boolean }
 *
 * Uses `incompleteOnly` so the server filters to active/unread messages,
 * making readByCount === 0 a reliable "unread to all agents" signal for
 * the ActivityBar badge count.
 */
export async function handleMailboxMessages(
  ws: WebSocket,
  deps: MailboxHandlerDeps,
  payload:
    | { limit?: number; agentId?: string; unreadOnly?: boolean; incompleteOnly?: boolean }
    | undefined,
): Promise<void> {
  const mb = getMailboxForDeps(deps);
  if (!mb) {
    send(ws, {
      type: 'mailbox.messages',
      payload: { messages: [], error: 'No project root available' },
    });
    return;
  }
  try {
    const limit = payload?.limit ?? 30;
    const unreadForAgent = payload?.unreadOnly === true && payload.agentId !== undefined;
    const readerRole =
      payload?.agentId !== undefined
        ? (await mb.getAgentStatuses()).find(
            (agent) =>
              agent.agentId === payload.agentId ||
              mailboxIdentityBase(agent.agentId) === mailboxIdentityBase(payload.agentId as string),
          )?.role
        : undefined;
    const messages = await mb.query({
      limit:
        payload?.unreadOnly === true && payload.agentId === undefined
          ? Math.max(limit * 5, 100)
          : limit,
      to: payload?.agentId,
      unreadBy: unreadForAgent ? payload.agentId : undefined,
      readerRole,
      incompleteOnly: payload?.incompleteOnly ?? false,
    });
    const audienceVisible =
      payload?.agentId !== undefined
        ? messages.filter((message) =>
            isMailboxMessageVisibleTo(message, payload.agentId as string, readerRole),
          )
        : messages;
    const visibleMessages =
      payload?.unreadOnly === true && payload.agentId === undefined
        ? audienceVisible.filter((m) => Object.keys(m.readBy).length === 0).slice(0, limit)
        : audienceVisible;
    send(ws, {
      type: 'mailbox.messages',
      payload: {
        ...(payload?.unreadOnly === true ? { unreadOnly: true } : {}),
        messages: visibleMessages.map((m) => {
          const readByMe =
            payload?.agentId !== undefined ? (payload.agentId as string) in m.readBy : false;
          const completedByMe =
            payload?.agentId !== undefined ? m.completedBy === payload.agentId : false;
          const actionRequiredForMe =
            payload?.agentId !== undefined
              ? MAILBOX_TYPE_PROPERTIES[m.type]?.requiresAction === true &&
                !completedByMe &&
                m.deletedAt === undefined
              : false;
          return {
            id: m.id,
            from: m.from,
            to: m.to,
            type: m.type,
            audience: m.audience ?? 'all',
            subject: m.subject,
            body: m.body,
            priority: m.priority,
            readBy: m.readBy,
            readByCount: Object.keys(m.readBy).length,
            completed: m.completed,
            completedBy: m.completedBy,
            completedAt: m.completedAt,
            outcome: m.outcome,
            timestamp: m.timestamp,
            replyTo: m.replyTo,
            senderSessionId: m.senderSessionId,
            taskContext: m.taskContext,
            ...(payload?.agentId !== undefined
              ? { readByMe, completedByMe, actionRequiredForMe }
              : {}),
          };
        }),
      },
    });
  } catch (err) {
    send(ws, { type: 'mailbox.messages', payload: { messages: [], error: errMessage(err) } });
  }
}

/**
 * List registered agents. Frontend sends:
 *   { type: 'mailbox.agents', onlineOnly?: boolean }
 */
export async function handleMailboxAgents(
  ws: WebSocket,
  deps: MailboxHandlerDeps,
  payload: { onlineOnly?: boolean } | undefined,
): Promise<void> {
  const mb = getMailboxForDeps(deps);
  if (!mb) {
    send(ws, {
      type: 'mailbox.agents',
      payload: { agents: [], error: 'No project root available' },
    });
    return;
  }
  try {
    const agents = payload?.onlineOnly ? await mb.getOnlineAgents() : await mb.getAgentStatuses();
    send(ws, {
      type: 'mailbox.agents',
      payload: {
        agents: agents.map((a) => ({
          agentId: a.agentId,
          name: a.name,
          role: a.role,
          sessionId: a.sessionId,
          status: a.status,
          currentTool: a.currentTool,
          currentTask: a.currentTask,
          iterations: a.iterations,
          toolCalls: a.toolCalls,
          lastSeenAt: a.lastSeenAt,
          online: a.online,
          pid: a.pid,
          source: a.source,
        })),
      },
    });
  } catch (err) {
    send(ws, { type: 'mailbox.agents', payload: { agents: [], error: errMessage(err) } });
  }
}

/**
 * Delete all messages from the mailbox. Frontend sends:
 *   { type: 'mailbox.clear' }
 * Server responds with 'mailbox.cleared'.
 */
export async function handleMailboxClear(ws: WebSocket, deps: MailboxHandlerDeps): Promise<void> {
  const mb = getMailboxForDeps(deps);
  if (!mb) {
    send(ws, { type: 'mailbox.cleared', payload: { error: 'No project root available' } });
    return;
  }
  try {
    await mb.clearAll();
    send(ws, { type: 'mailbox.cleared', payload: {} });
  } catch (err) {
    send(ws, { type: 'mailbox.cleared', payload: { error: errMessage(err) } });
  }
}

/**
 * Purge stale/orphaned messages from the mailbox. Frontend sends:
 *   { type: 'mailbox.purge', payload?: { completedMaxAgeMs?: number; incompleteMaxAgeMs?: number } }
 * Server responds with 'mailbox.purged'.
 */
export async function handleMailboxPurge(
  ws: WebSocket,
  deps: MailboxHandlerDeps,
  opts?: { completedMaxAgeMs?: number; incompleteMaxAgeMs?: number },
): Promise<void> {
  const mb = getMailboxForDeps(deps);
  if (!mb) {
    send(ws, { type: 'mailbox.purged', payload: { error: 'No project root available' } });
    return;
  }
  try {
    const result = await mb.purgeStale(opts);
    send(ws, { type: 'mailbox.purged', payload: result });
  } catch (err) {
    send(ws, { type: 'mailbox.purged', payload: { error: errMessage(err) } });
  }
}

/**
 * Auto-compact the mailbox: removes expired (TTL) messages, messages read
 * by all online agents, and stale messages — all in one pass. Frontend sends:
 *   { type: 'mailbox.compact', payload?: { readMaxAgeMs?, defaultTtlMs?, ... } }
 * Server responds with 'mailbox.compacted' containing the result.
 */
export async function handleMailboxCompact(
  ws: WebSocket,
  deps: MailboxHandlerDeps,
  opts?: {
    readMaxAgeMs?: number;
    defaultTtlMs?: number;
    completedMaxAgeMs?: number;
    incompleteMaxAgeMs?: number;
  },
): Promise<void> {
  const mb = getMailboxForDeps(deps);
  if (!mb) {
    send(ws, { type: 'mailbox.compacted', payload: { error: 'No project root available' } });
    return;
  }
  try {
    const result = await mb.autoCompact(opts);
    send(ws, { type: 'mailbox.compacted', payload: result });
  } catch (err) {
    send(ws, { type: 'mailbox.compacted', payload: { error: errMessage(err) } });
  }
}
