import type { MailboxMessage } from './mailbox-types.js';

export type MailboxMessageIndexes = {
  recipientIndex: Map<string, Set<number>>;
  senderIndex: Map<string, Set<number>>;
};

function addIndexEntry(index: Map<string, Set<number>>, key: string, position: number): void {
  let set = index.get(key);
  if (set === undefined) {
    set = new Set();
    index.set(key, set);
  }
  set.add(position);
}

export function buildMailboxMessageIndexes(messages: readonly MailboxMessage[]): MailboxMessageIndexes {
  const recipientIndex = new Map<string, Set<number>>();
  const senderIndex = new Map<string, Set<number>>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    addIndexEntry(recipientIndex, msg.to, i);
    addIndexEntry(senderIndex, msg.from, i);
  }
  return { recipientIndex, senderIndex };
}

export function addMailboxMessageToIndexes(
  indexes: {
    recipientIndex: Map<string, Set<number>> | null;
    senderIndex: Map<string, Set<number>> | null;
  },
  msg: MailboxMessage,
  position: number,
): void {
  if (indexes.recipientIndex !== null) {
    addIndexEntry(indexes.recipientIndex, msg.to, position);
  }
  if (indexes.senderIndex !== null) {
    addIndexEntry(indexes.senderIndex, msg.from, position);
  }
}
