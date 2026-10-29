/**
 * Mailbox WebSocket handlers for the WebUI.
 *
 * Handles `mailbox.messages` and `mailbox.agents` message types.
 * The frontend sends these to populate the mailbox panel; the server
 * reads from the server-backed project mailbox and responds.
 */

import type { EventBus } from '@wrongstack/contracts/kernel';
import {
  isMailboxMessageUnread,
  type MailboxMessageProjection,
} from '@wrongstack/contracts/types/mailbox';
import {
  actionToAckInput,
  getSharedProjectMailbox,
  isMessageUnreadForActor,
  type MailboxActorReadScope,
  mailboxIdentityBase,
  queryMessagesForActor,
  type RemoteMailbox,
  resolveProjectDir,
  stripAggregateReceiptState,
} from '@wrongstack/coordination';
import type { WebSocket } from 'ws';
import type { MailboxActionPayload, MailboxSendPayload } from './ws-payload-validation.js';
import { clampLimit } from './ws-payload-validation.js';
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
    | {
        limit?: number;
        agentId?: string;
        unreadOnly?: boolean;
        incompleteOnly?: boolean;
        /** Inclusive upper timestamp bound, for reading older messages. */
        until?: string;
      }
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
    // S10: `limit` is model-controlled (a browser frame). Clamp before it
    // reaches the store — the unread branch below multiplies it, and
    // SqliteMailbox.query binds it as a raw SQL LIMIT.
    const limit = clampLimit(payload?.limit, 30, 200);
    const readerRole =
      payload?.agentId !== undefined
        ? (await mb.getAgentStatuses()).find(
            (agent) =>
              agent.agentId === payload.agentId ||
              mailboxIdentityBase(agent.agentId) === mailboxIdentityBase(payload.agentId as string),
          )?.role
        : undefined;
    // The actor-scoped read goes through the SHARED projection
    // (`queryMessagesForActor`) the HTTP bridge and the Mailbox MCP server
    // use. This handler used to re-derive the rule locally — it built
    // `to`/`unreadBy` from the payload and applied the audience filter by
    // hand — so the WebUI could drift from the canonical visibility rule
    // (and from the per-actor receipt state it reports).
    const actorScope: MailboxActorReadScope | undefined =
      payload?.agentId !== undefined
        ? {
            actorId: payload.agentId,
            role: readerRole,
            // The agent's own base alias (`worker` for `worker@session`) is
            // mail addressed to that agent as well.
            recipientAliases: new Set([mailboxIdentityBase(payload.agentId)]),
          }
        : undefined;
    // The actor-scoped unread read over-fetches like the aggregate path:
    // the store-side `unreadBy` filter does not exclude completed or
    // legacy-completed messages, so they can occupy the LIMIT window and
    // the post-filter (isMessageUnreadForActor) would under-report.
    const queryLimit = payload?.unreadOnly === true ? Math.max(limit * 5, 100) : limit;
    const until =
      typeof payload?.until === 'string' && Number.isFinite(Date.parse(payload.until))
        ? payload.until
        : undefined;
    const messages = actorScope
      ? await queryMessagesForActor(mb, actorScope, {
          limit: queryLimit,
          // `unreadBy` is bound to the actor the read is scoped to.
          unreadBy: payload?.unreadOnly === true ? actorScope.actorId : undefined,
          readerRole,
          incompleteOnly: payload?.incompleteOnly ?? false,
          until,
          // The per-actor receipt projection (`recipientState`) is what the
          // actor-scoped fields below are derived from. Without it the server
          // would have to fall back to the message-GLOBAL completion flag, which
          // is exactly the leak this projection exists to close.
          includeReceiptState: true,
        })
      : await mb.query({
          limit: queryLimit,
          to: undefined,
          unreadBy: undefined,
          readerRole: undefined,
          incompleteOnly: payload?.incompleteOnly ?? false,
          includeReceiptState: false,
          until,
        });
    // The canonical unread rule applies per PATH: the aggregate no-agent
    // view uses the global rule (read by nobody), while the actor-scoped
    // view is PER-ACTOR — a fan-out message read by another agent is still
    // unread for this one (and must stay listed: its per-actor inbox will
    // still inject it). The store-side `unreadBy` pre-filter does not
    // exclude messages completed by another actor, so the per-actor
    // completion check runs here.
    const visibleMessages =
      payload?.unreadOnly === true
        ? (actorScope
            ? messages.filter((m) => isMessageUnreadForActor(m, actorScope.actorId))
            : messages.filter(isMailboxMessageUnread)
          ).slice(0, limit)
        : messages;
    // The actor this read is scoped to. Captured once so the narrowing
    // survives into the payload mapping below: `payload?.agentId` is a
    // property access on an optional payload, which TypeScript does not
    // narrow inside a callback.
    const scopedAgentId = payload?.agentId;
    send(ws, {
      type: 'mailbox.messages',
      payload: {
        ...(payload?.unreadOnly === true ? { unreadOnly: true } : {}),
        messages: visibleMessages.map((m) => {
          // Actor-scoped receipt state, projected from the per-actor
          // `recipientState` map. The previous implementation derived
          // `completedByMe` from the message-GLOBAL `completedBy`, so a legacy
          // fan-out completion was reported as "completed by me" for the one
          // agent that acked it and NOT for the others — the global completion
          // state leaked through a per-actor field.
          const actorView =
            scopedAgentId !== undefined ? stripAggregateReceiptState(m, scopedAgentId) : undefined;
          const readByMe = actorView?.readByMe ?? false;
          const completedByMe = actorView?.completedByMe ?? false;
          const actionRequiredForMe = actorView?.actionRequiredForMe ?? false;
          // The receipt fields below are the ACTOR's receipts on an
          // actor-scoped read. Re-reading them from the raw message shipped
          // the message-GLOBAL receipt state next to the per-actor fields:
          // the whole `readBy` map (every other reader's identity and read
          // time), the global `completedBy` (whichever agent acked the
          // message), the global `completedAt` and the global `outcome`.
          // That is exactly the aggregate state the HTTP bridge withholds
          // from actors without the `mail.admin.receipts` capability
          // (`stripAggregateReceiptState`), so an actor-scoped payload must
          // not carry it either.
          const actorState =
            scopedAgentId !== undefined
              ? (m as Partial<MailboxMessageProjection>).recipientState?.[scopedAgentId]
              : undefined;
          const legacyOwnReadAt =
            scopedAgentId !== undefined && scopedAgentId in m.readBy
              ? m.readBy[scopedAgentId]
              : undefined;
          const ownReadAt = actorState?.readAt !== undefined ? actorState.readAt : legacyOwnReadAt;
          const actorReadBy: Record<string, string> =
            scopedAgentId !== undefined && ownReadAt !== undefined
              ? { [scopedAgentId]: ownReadAt }
              : {};
          const actorCompletedBy = completedByMe ? scopedAgentId : undefined;
          const scopedReadBy = actorView === undefined ? m.readBy : actorReadBy;
          const scopedReadByCount =
            actorView === undefined
              ? Object.keys(m.readBy).length
              : Object.keys(actorReadBy).length;
          // Legacy fan-out completions (a v1 ack on `*`/alias/`@session:`)
          // are recorded once, GLOBALLY, flagged with
          // `legacy_global_completion` and without a per-actor
          // `completedAt` — reporting them per-actor would show a resolved
          // message as open to every actor that did not do the acking. When
          // the projection flags that shape, `completed` stays true but the
          // aggregate `completedBy`/`completedAt`/`outcome` attributions
          // stay withheld: an actor-scoped payload carries no other actor's
          // receipt detail (the canonical ActorMailboxMessage shape), and
          // the `legacyGlobalCompletion` marker tells the client why.
          const legacyGlobalCompletion = actorView?.legacyGlobalCompletion === true;
          const scopedCompleted =
            actorView === undefined || legacyGlobalCompletion ? m.completed : completedByMe;
          const scopedCompletedBy =
            actorView === undefined && !legacyGlobalCompletion
              ? m.completedBy
              : legacyGlobalCompletion
                ? undefined
                : actorCompletedBy;
          const scopedCompletedAt =
            actorView === undefined
              ? m.completedAt
              : legacyGlobalCompletion
                ? undefined
                : actorState?.completedAt;
          const scopedOutcome = actorView === undefined ? m.outcome : actorView.myOutcome;
          return {
            id: m.id,
            from: m.from,
            to: m.to,
            type: m.type,
            audience: m.audience ?? 'all',
            subject: m.subject,
            body: m.body,
            priority: m.priority,
            readBy: scopedReadBy,
            readByCount: scopedReadByCount,
            completed: scopedCompleted,
            completedBy: scopedCompletedBy,
            completedAt: scopedCompletedAt,
            outcome: scopedOutcome,
            timestamp: m.timestamp,
            replyTo: m.replyTo,
            senderSessionId: m.senderSessionId,
            taskContext: m.taskContext,
            ...(actorView !== undefined ? { readByMe, completedByMe, actionRequiredForMe } : {}),
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
