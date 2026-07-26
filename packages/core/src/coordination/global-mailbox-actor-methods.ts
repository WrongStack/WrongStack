import type {
  ActorMailboxMessage,
  AgentHeartbeatInput,
  AgentRegistrationInput,
  MailboxActorContext,
  MailboxAckInput,
  MailboxMessage,
  MailboxMessageProjection,
  MailboxQuery,
  MailboxSendInput,
} from './mailbox-types.js';
import {
  isActionRequiredForActor,
  isMailboxMessageVisibleTo,
  sessionRecipient,
} from './mailbox-types.js';

function isMessageAddressedToActor(
  message: Pick<MailboxMessage, 'to' | 'audience'>,
  actor: MailboxActorContext,
): boolean {
  if (!isMailboxMessageVisibleTo(message, actor.actorId, actor.role)) return false;
  if (message.to === '*' || message.to === actor.actorId) return true;
  if (actor.recipientAliases.has(message.to)) return true;
  return actor.sessionId !== undefined && message.to === sessionRecipient(actor.sessionId);
}

function projectMessageForActor(
  message: MailboxMessage,
  actor: MailboxActorContext,
): ActorMailboxMessage {
  const projection = message as Partial<MailboxMessageProjection>;
  const actorState = projection.recipientState?.[actor.actorId];
  const readByMe = actorState?.readAt !== undefined || actor.actorId in message.readBy;
  const completedByMe =
    actorState?.completedAt !== undefined ||
    (projection.recipientState === undefined &&
      message.completed === true &&
      message.completedBy === actor.actorId);
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
    ...(actorState?.outcome !== undefined
      ? { myOutcome: actorState.outcome }
      : projection.recipientState === undefined && message.completedBy === actor.actorId && message.outcome !== undefined
        ? { myOutcome: message.outcome }
        : {}),
    ...(legacyGlobalCompletion ? { legacyGlobalCompletion: true } : {}),
  } as ActorMailboxMessage;
}

export async function sendMailboxFor(
  actor: MailboxActorContext,
  input: Omit<MailboxSendInput, 'from' | 'senderSessionId'>,
  send: (input: MailboxSendInput) => Promise<MailboxMessage>,
): Promise<MailboxMessage> {
  return send({
    ...input,
    from: actor.actorId,
    senderSessionId: actor.sessionId,
  });
}

export async function registerMailboxActor(
  actor: MailboxActorContext,
  input: Omit<AgentRegistrationInput, 'agentId' | 'sessionId' | 'role'>,
  register: (input: AgentRegistrationInput) => Promise<void>,
): Promise<void> {
  if (actor.sessionId === undefined) {
    throw new TypeError('actor sessionId is required for mailbox presence registration');
  }
  await register({
    ...input,
    agentId: actor.actorId,
    sessionId: actor.sessionId,
    ...(actor.role !== undefined ? { role: actor.role } : {}),
  });
}

export async function heartbeatMailboxActor(
  actor: MailboxActorContext,
  input: Omit<AgentHeartbeatInput, 'agentId'>,
  heartbeat: (input: AgentHeartbeatInput) => Promise<void>,
): Promise<void> {
  await heartbeat({ ...input, agentId: actor.actorId });
}

export async function ackMailboxFor(
  actor: MailboxActorContext,
  input: { messageId: string; read?: boolean; completed?: boolean; outcome?: string },
  deps: {
    readMessages: () => Promise<MailboxMessage[]>;
    ack: (input: MailboxAckInput) => Promise<MailboxMessage | null>;
  },
): Promise<ActorMailboxMessage | null> {
  const all = await deps.readMessages();
  const target = all.find((m) => m.id === input.messageId);
  if (target === undefined) return null;
  if (!isMessageAddressedToActor(target, actor)) return null;
  const updated = await deps.ack({
    messageId: input.messageId,
    readerId: actor.actorId,
    read: input.read ?? true,
    ...(input.completed !== undefined ? { completed: input.completed } : {}),
    outcome: input.outcome,
  });
  return updated === null ? null : projectMessageForActor(updated, actor);
}

export async function queryMailboxFor(
  actor: MailboxActorContext,
  query: Partial<MailboxQuery> | undefined,
  runQuery: (query: MailboxQuery) => Promise<MailboxMessage[]>,
): Promise<ActorMailboxMessage[]> {
  const requestedRecipient = query?.to;
  if (
    requestedRecipient !== undefined &&
    requestedRecipient !== '*' &&
    requestedRecipient !== actor.actorId &&
    !actor.recipientAliases.has(requestedRecipient) &&
    (actor.sessionId === undefined || requestedRecipient !== sessionRecipient(actor.sessionId))
  ) {
    return [];
  }

  const actorQuery = { ...query };
  delete actorQuery.includeReceiptState;

  const messages = await runQuery({
    ...actorQuery,
    // Aggregate receipt state is internal only; actor-facing output is always
    // reduced to the requesting actor's projection below.
    includeReceiptState: true,
    readerRole: actor.role ?? actor.actorId.split('@', 1)[0]!,
    // The caller cannot select another actor's receipt/completion projection.
    unreadBy: actor.actorId,
  });
  return messages
    .filter((message) => isMessageAddressedToActor(message, actor))
    .map((message) => projectMessageForActor(message, actor));
}

export async function softDeleteMailboxFor(
  actor: MailboxActorContext,
  mailId: string,
  deps: {
    readMessages: () => Promise<MailboxMessage[]>;
    softDelete: (mailId: string, readerId: string) => Promise<MailboxMessage | null>;
  },
): Promise<ActorMailboxMessage | null> {
  const all = await deps.readMessages();
  const target = all.find((m) => m.id === mailId);
  if (target === undefined) return null;
  if (!isMessageAddressedToActor(target, actor)) return null;
  const updated = await deps.softDelete(mailId, actor.actorId);
  return updated === null ? null : projectMessageForActor(updated, actor);
}

export async function restoreMailboxFor(
  actor: MailboxActorContext,
  mailId: string,
  deps: {
    readMessages: () => Promise<MailboxMessage[]>;
    restore: (mailId: string) => Promise<MailboxMessage | null>;
  },
): Promise<ActorMailboxMessage | null> {
  const all = await deps.readMessages();
  const target = all.find((m) => m.id === mailId);
  if (target === undefined) return null;
  if (!isMessageAddressedToActor(target, actor)) return null;
  const updated = await deps.restore(mailId);
  return updated === null ? null : projectMessageForActor(updated, actor);
}
