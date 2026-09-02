import type { MailboxMessage } from './mailbox-types.js';
import type { MailboxMessageProjection } from './mailbox-receipt-folding.js';

export function isMailboxMessageProjection(msg: MailboxMessage): msg is MailboxMessageProjection {
  if (!('recipientState' in msg)) return false;
  const recipientState: unknown = msg.recipientState;
  return (
    typeof recipientState === 'object' && recipientState !== null && !Array.isArray(recipientState)
  );
}

export function isMessageCompletedForActor(msg: MailboxMessage, actorId?: string): boolean {
  if (!isMailboxMessageProjection(msg)) return msg.completed === true;
  if (msg.legacyGlobalCompletion) return true;
  if (actorId !== undefined) {
    const state = msg.recipientState[actorId];
    if (state !== undefined) return state.completedAt !== undefined;
    if (Object.keys(msg.recipientState).length > 0) return false;
  }
  return msg.completed === true;
}
