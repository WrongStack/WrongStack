import {
  filterMailboxMessagesByTimestamp,
  type MailboxCheckInput,
} from './mailbox-http-validation.js';
import type {
  ActorMailboxMessage,
  Mailbox,
  MailboxActorContext,
  MailboxCapability,
  MailboxMessage,
  MailboxMessageProjection,
  MailboxMessageType,
} from './mailbox-types.js';
import {
  isActionRequiredForActor,
  isMailboxMessageVisibleTo,
  sessionRecipient,
} from './mailbox-types.js';

export function stripAggregateReceiptState(
  message: MailboxMessage,
  actorId: string,
): ActorMailboxMessage {
  const projection = message as Partial<MailboxMessageProjection>;
  const actorState = projection.recipientState?.[actorId];
  const readByMe = actorState?.readAt !== undefined || actorId in message.readBy;
  const completedByMe = actorState?.completedAt !== undefined;
  const legacyGlobalCompletion = projection.legacyGlobalCompletion === true;
  const visible = { ...message } as Record<string, unknown>;
  delete visible['readBy'];
  delete visible['completed'];
  delete visible['completedBy'];
  delete visible['completedAt'];
  delete visible['outcome'];
  delete visible['recipientState'];
  delete visible['legacyGlobalCompletion'];

  return {
    ...visible,
    readByMe,
    completedByMe,
    actionRequiredForMe: isActionRequiredForActor(message, {
      completedByMe,
      legacyGlobalCompletion,
    }),
    ...(actorState?.outcome !== undefined ? { myOutcome: actorState.outcome } : {}),
    ...(legacyGlobalCompletion ? { legacyGlobalCompletion: true } : {}),
  } as ActorMailboxMessage;
}

export function eligibleRecipientsForActor(actor: MailboxActorContext): string[] {
  return [
    ...new Set([
      actor.actorId,
      ...actor.recipientAliases,
      ...(actor.sessionId === undefined ? [] : [sessionRecipient(actor.sessionId)]),
    ]),
  ];
}

export async function queryMessagesForActor(
  mailbox: Mailbox,
  actor: MailboxActorContext,
  query: Parameters<Mailbox['query']>[0],
): Promise<MailboxMessage[]> {
  const eligibleRecipients = new Set(eligibleRecipientsForActor(actor));
  const requestedRecipient = query.to;
  if (requestedRecipient !== undefined && !eligibleRecipients.has(requestedRecipient)) return [];

  const recipients =
    requestedRecipient === undefined ? [...eligibleRecipients] : [requestedRecipient];
  const batches = await Promise.all(recipients.map((to) => mailbox.query({ ...query, to })));
  const seen = new Set<string>();
  const visible = batches.flat().filter((message) => {
    if (seen.has(message.id)) return false;
    if (!isMailboxMessageVisibleTo(message, actor.actorId, actor.role)) return false;
    seen.add(message.id);
    return true;
  });
  visible.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return visible.slice(0, query.limit ?? 50);
}

export async function visibleMessageIdsForActor(
  mailbox: Mailbox,
  actor: MailboxActorContext,
  messageIds: readonly string[],
): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const requested = new Set(messageIds);
  const ids = [...requested];
  const messages = await queryMessagesForActor(mailbox, actor, {
    ids,
    readerRole: actor.role,
    includeReceiptState: true,
    limit: ids.length,
  });
  return new Set(messages.filter((message) => requested.has(message.id)).map((m) => m.id));
}

export async function unreadCountForActor(
  mailbox: Mailbox,
  actor: MailboxActorContext,
): Promise<number> {
  const messages = await queryMessagesForActor(mailbox, actor, {
    unreadBy: actor.actorId,
    readerRole: actor.role,
    includeReceiptState: true,
    limit: Number.MAX_SAFE_INTEGER,
  });
  return messages.filter((message) => !isMessageCompletedForActor(message, actor.actorId)).length;
}

export function isMessageCompletedForActor(message: MailboxMessage, actorId: string): boolean {
  const projection = message as Partial<MailboxMessageProjection>;
  if (projection.legacyGlobalCompletion === true) return true;
  const recipientState = projection.recipientState;
  const actorState = recipientState?.[actorId];
  if (actorState !== undefined) return actorState.completedAt !== undefined;
  if (recipientState !== undefined && Object.keys(recipientState).length > 0) return false;
  return message.completed === true;
}

export async function isMessageVisibleToActor(
  mailbox: Mailbox,
  messageId: string,
  actor: MailboxActorContext,
): Promise<boolean> {
  return (await visibleMessageIdsForActor(mailbox, actor, [messageId])).has(messageId);
}

export function requiredSendCapability(type: MailboxMessageType): MailboxCapability | undefined {
  if (type === 'control') return undefined;
  if (type === 'steer') return 'mail.send.directive';
  if (type === 'ask' || type === 'assign' || type === 'review') {
    return 'mail.send.actionable';
  }
  return 'mail.send.informational';
}

export function requiredCredentialCapability(
  method: string,
  path: string,
): MailboxCapability | undefined {
  if (method === 'POST' && path === '/mailbox/send') return 'mail.send.informational';
  if (method === 'POST' && (path === '/mailbox/query' || path === '/mailbox/check')) {
    return 'mail.read.self';
  }
  if (method === 'POST' && (path === '/mailbox/ack' || path === '/mailbox/ack-many')) {
    return 'mail.ack.self';
  }
  if (method === 'POST' && path === '/mailbox/unread-count') return 'mail.read.self';
  if (method === 'POST' && path === '/mailbox/agents/register') {
    return 'mail.presence.register.self';
  }
  if (method === 'POST' && path === '/mailbox/agents/heartbeat') {
    return 'mail.presence.heartbeat.self';
  }
  if (method === 'GET' && (path === '/mailbox/agents' || path === '/mailbox/agents/online')) {
    return 'mail.presence.read';
  }
  if (method === 'GET' && path === '/mailbox/events') return 'mail.events.self';
  return undefined;
}

export async function checkMailbox(
  mailbox: Mailbox,
  input: MailboxCheckInput,
  minTimestampIso: string | undefined,
  includeReceiptState = false,
  eligibleRecipients?: readonly string[],
  readerRole?: string,
): Promise<{ data: MailboxMessage[]; count: number }> {
  const limit = input.limit ?? 20;
  const markRead = input.markRead ?? true;
  const completed = input.completed ?? false;
  const targets =
    eligibleRecipients ??
    (input.baseId !== undefined && input.baseId !== input.agentId
      ? [input.agentId, input.baseId]
      : [input.agentId]);
  const batches = await Promise.all(
    targets.map((to) =>
      mailbox.query({
        to,
        unreadBy: input.agentId,
        readerRole,
        limit,
        includeReceiptState,
      }),
    ),
  );
  const withinWindow = filterMailboxMessagesByTimestamp(batches.flat(), minTimestampIso);
  const seen = new Set<string>();
  const messages = withinWindow
    .filter((message) => {
      if (seen.has(message.id) || message.from === input.agentId) return false;
      if (!isMailboxMessageVisibleTo(message, input.agentId, readerRole)) return false;
      seen.add(message.id);
      return true;
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
  const data =
    markRead || completed
      ? await mailbox.ackMany({
          acks: messages.map((message) => ({
            messageId: message.id,
            readerId: input.agentId,
            read: markRead,
            completed,
            outcome: completed ? input.outcome : undefined,
          })),
        })
      : messages;
  return { data, count: data.length };
}
