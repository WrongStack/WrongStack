import type { MailboxMessage, MailboxQuery } from './mailbox-types.js';

export function selectMailboxQueryCandidates(
  q: MailboxQuery,
  all: readonly MailboxMessage[],
  recipientIndex: ReadonlyMap<string, ReadonlySet<number>> | null,
  senderIndex: ReadonlyMap<string, ReadonlySet<number>> | null,
): Iterable<MailboxMessage> {
  if (
    q.to !== undefined &&
    recipientIndex !== null &&
    q.from === undefined &&
    q.type === undefined &&
    q.minPriority === undefined
  ) {
    const indices = new Set<number>();
    const direct = recipientIndex.get(q.to);
    if (direct !== undefined) for (const i of direct) indices.add(i);
    const broadcasts = recipientIndex.get('*');
    if (broadcasts !== undefined) for (const i of broadcasts) indices.add(i);
    return [...indices].sort((a, b) => a - b).map((i) => all[i]!);
  }

  if (
    q.from !== undefined &&
    q.to === undefined &&
    senderIndex !== null &&
    q.type === undefined &&
    q.minPriority === undefined
  ) {
    const indices = senderIndex.get(q.from);
    return indices !== undefined ? [...indices].sort((a, b) => a - b).map((i) => all[i]!) : [];
  }

  return all as MailboxMessage[];
}
