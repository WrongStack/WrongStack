import type {
  MailboxAgentStatus,
  MailboxMessage,
  MailboxMessageProjection,
  MailboxRecipientState,
} from './mailbox-types.js';
import { isMailboxMessageVisibleTo, mailboxIdentityBase } from './mailbox-types.js';

export interface MailboxRetentionState {
  completed: boolean;
  completedAt?: string | undefined;
}

/**
 * Resolve whether retention may treat a message as completed.
 *
 * Historical fan-out completion remains global. New v2 fan-out completion is
 * eligible for the short completed TTL only when every currently relevant
 * recipient has an actor-scoped completion receipt. Otherwise the message
 * stays on the incomplete retention path.
 */
export function resolveMailboxRetentionState(
  message: MailboxMessage,
  agentStatuses: readonly MailboxAgentStatus[] | undefined,
): MailboxRetentionState {
  const projection = message as MailboxMessageProjection;
  if (projection.legacyGlobalCompletion) {
    return { completed: true, completedAt: message.completedAt ?? message.timestamp };
  }

  const recipientState = projection.recipientState;
  if (recipientState === undefined) {
    return message.completed
      ? { completed: true, completedAt: message.completedAt ?? message.timestamp }
      : { completed: false };
  }

  const relevantRecipients = resolveRelevantRecipients(message, recipientState, agentStatuses);
  if (relevantRecipients.length === 0) return { completed: false };

  const completionTimes: string[] = [];
  for (const actorId of relevantRecipients) {
    const completedAt = recipientState[actorId]?.completedAt;
    if (completedAt === undefined) return { completed: false };
    completionTimes.push(completedAt);
  }

  return {
    completed: true,
    // Retention starts only after the last intended recipient completed.
    completedAt: completionTimes.reduce((latest, time) => (time > latest ? time : latest)),
  };
}

function resolveRelevantRecipients(
  message: MailboxMessage,
  recipientState: Readonly<Record<string, MailboxRecipientState>>,
  agentStatuses: readonly MailboxAgentStatus[] | undefined,
): string[] {
  const statuses = agentStatuses ?? [];
  const receiptActors = Object.keys(recipientState);
  if (message.to === '*') {
    if (statuses.length === 0) return [];
    const registeredRecipients = statuses
      .filter((status) => isMailboxMessageVisibleTo(message, status.agentId, status.role))
      .map((status) => status.agentId);
    // Include receipt actors even after they fall out of the live registry;
    // otherwise a later registry snapshot can forget an incomplete recipient
    // and move a fan-out message onto the short completed TTL.
    return [...new Set([...registeredRecipients, ...receiptActors])];
  }

  if (message.to.startsWith('@session:')) {
    if (statuses.length === 0) return [];
    const sessionId = message.to.slice('@session:'.length);
    const registeredRecipients = statuses
      .filter(
        (status) =>
          status.sessionId === sessionId &&
          isMailboxMessageVisibleTo(message, status.agentId, status.role),
      )
      .map((status) => status.agentId);
    return [...new Set([...registeredRecipients, ...receiptActors])];
  }

  if (message.to.includes('@')) return [message.to];

  if (statuses.length === 0) return [];

  const aliasRecipients = statuses
    .filter(
      (status) =>
        (status.role?.toLowerCase() === message.to.toLowerCase() ||
          mailboxIdentityBase(status.agentId) === message.to.toLowerCase()) &&
        isMailboxMessageVisibleTo(message, status.agentId, status.role),
    )
    .map((status) => status.agentId);
  return [...new Set([...aliasRecipients, ...receiptActors])];
}
