import * as fsp from 'node:fs/promises';
import type { HqPublisher } from '../hq/publisher.js';
import { withFileLock } from '../utils/atomic-write.js';
import type { MailboxEventEmitter } from './mailbox-events.js';
import type { MailboxMessageCache, MailboxMessageFileStat } from './mailbox-message-cache.js';
import {
  buildReceiptRecordV2,
  isFanOutRecipient,
  serializeReceiptRecordV2,
  type MailboxMessageProjection,
} from './mailbox-receipt-folding.js';
import { isMailboxMessageProjection } from './global-mailbox-completion.js';
import { serializeAckRecord } from './mailbox-message-codec.js';
import { assertMailboxNotFenced, ensureVersionSentinel } from './mailbox-version-fence.js';
import type {
  AckRecord,
  MailboxAckBatchInput,
  MailboxAckInput,
  MailboxMessage,
} from './mailbox-types.js';

export interface GlobalMailboxAckContext {
  messagePath: string;
  diag: {
    ackManyPreLockMtime: number;
    ackManyPostLockMtime: number;
    ackManyPreLockSize: number;
    ackManyPostLockSize: number;
    ackManyMessageCount: number;
    ackManyAckCount: number;
  };
  eventEmitter?: MailboxEventEmitter | undefined;
  hqMailboxId: string;
  messageCache: MailboxMessageCache;
  publishHqMailboxEvent(input: Parameters<HqPublisher['publishMailboxEvent']>[0]): void;
  publishHqMailboxSnapshot(): void;
  readMessages(): Promise<MailboxMessage[]>;
  readMessagesCached(): Promise<MailboxMessage[]>;
  refreshMessageCacheUnderLock(): Promise<boolean>;
  statMessageFile(): Promise<MailboxMessageFileStat>;
}

export async function ackMailboxMany(
  input: MailboxAckBatchInput,
  ctx: GlobalMailboxAckContext,
): Promise<MailboxMessage[]> {
  if (input.acks.length === 0) return [];

  const now = new Date().toISOString();
  const ackRecords: AckRecord[] = [];
  const updated: MailboxMessage[] = [];
  const targetIds = new Set<string>();
  const byId = new Map<string, MailboxAckInput>();

  for (const a of input.acks) {
    byId.set(a.messageId, a);
    targetIds.add(a.messageId);
  }

  const all = await ctx.readMessagesCached();
  ctx.diag.ackManyPreLockMtime = ctx.messageCache.mtimeMs;
  ctx.diag.ackManyPreLockSize = ctx.messageCache.sizeBytes;
  for (const msg of all) {
    const a = byId.get(msg.id);
    if (!a) continue;

    const needsRead = a.read !== false && !(a.readerId in msg.readBy);
    const projection = isMailboxMessageProjection(msg) ? msg : undefined;
    const actorState = projection?.recipientState[a.readerId];
    const isActorCompleted =
      actorState?.completedAt !== undefined ||
      (projection === undefined && msg.completed && msg.completedBy === a.readerId);
    const needsComplete = a.completed && !isActorCompleted && !projection?.legacyGlobalCompletion;
    const actorOutcome = actorState?.outcome ?? (projection === undefined ? msg.outcome : undefined);
    const needsOutcome = a.outcome !== undefined && actorOutcome !== a.outcome;
    const needsReopen =
      a.read === false &&
      a.completed === false &&
      isActorCompleted &&
      projection?.legacyGlobalCompletion !== true;
    const completedChange = a.completed === true ? true : needsReopen ? false : undefined;

    const copy = { ...msg, readBy: { ...msg.readBy } };
    if (projection !== undefined && !projection.legacyGlobalCompletion) {
      copy.completed = isActorCompleted;
      if (isActorCompleted) {
        copy.completedBy = actorState?.completedBy ?? a.readerId;
        copy.completedAt = actorState?.completedAt;
      } else {
        delete (copy as Record<string, unknown>)['completedBy'];
        delete (copy as Record<string, unknown>)['completedAt'];
      }
      copy.outcome = actorOutcome;
    }

    if (!needsRead && !needsComplete && !needsOutcome && !needsReopen) {
      updated.push(copy);
      continue;
    }

    if (needsRead) copy.readBy[a.readerId] = now;
    if (needsComplete) {
      copy.completed = true;
      copy.completedBy = a.readerId;
      copy.completedAt = now;
    }
    if (needsOutcome) copy.outcome = a.outcome;
    if (needsReopen) {
      copy.completed = false;
      delete (copy as Record<string, unknown>)['completedBy'];
      delete (copy as Record<string, unknown>)['completedAt'];
    }
    updated.push(copy);

    ackRecords.push({
      __ack: true,
      messageId: msg.id,
      readerId: a.readerId,
      timestamp: now,
      read: a.read !== false,
      completed: completedChange,
      completedBy: completedChange === true ? a.readerId : undefined,
      outcome: a.outcome,
    });
  }

  if (ackRecords.length === 0) return updated;

  const persistedAckIds = new Set<string>();
  await withFileLock(ctx.messagePath, async () => {
    await ctx.refreshMessageCacheUnderLock();
    const current = await ctx.readMessagesCached();
    const messageById = new Map(current.map((message) => [message.id, message]));
    for (let index = ackRecords.length - 1; index >= 0; index--) {
      const ack = ackRecords[index];
      if (ack === undefined) continue;
      const projection = messageById.get(ack.messageId) as MailboxMessageProjection | undefined;
      if (projection === undefined) continue;
      const actorState = projection.recipientState?.[ack.readerId];
      const keepRead = ack.read === true && actorState?.readAt === undefined;
      const keepOutcome = ack.outcome !== undefined && actorState?.outcome !== ack.outcome;
      const keepCompletion =
        ack.completed === true
          ? actorState?.completedAt === undefined && projection.legacyGlobalCompletion !== true
          : ack.completed === false
            ? actorState?.completedAt !== undefined
            : false;
      if (!keepRead && !keepOutcome && !keepCompletion) {
        ackRecords.splice(index, 1);
        continue;
      }
      ackRecords[index] = {
        ...ack,
        read: keepRead,
        completed: keepCompletion ? ack.completed : undefined,
        completedBy: keepCompletion && ack.completed === true ? ack.readerId : undefined,
        outcome: keepOutcome ? ack.outcome : undefined,
      };
    }
    if (ackRecords.length === 0) return;
    for (const ack of ackRecords) persistedAckIds.add(ack.messageId);

    const serialized = ackRecords
      .map((ack) => {
        const message = messageById.get(ack.messageId);
        if (message === undefined) return '';
        if (!isFanOutRecipient(message.to)) return serializeAckRecord(ack);
        return serializeAckRecord({
          __ack: true,
          messageId: ack.messageId,
          readerId: ack.readerId,
          timestamp: ack.timestamp,
          read: ack.read,
        });
      })
      .join('');
    const v2Receipts = ackRecords
      .map((ack) =>
        serializeReceiptRecordV2(
          buildReceiptRecordV2(ack.messageId, ack.readerId, ack.timestamp, {
            read: ack.read !== false,
            ...(ack.completed !== undefined ? { completed: ack.completed } : {}),
            ...(ack.outcome !== undefined ? { outcome: ack.outcome } : {}),
          }),
        ),
      )
      .join('');
    await assertMailboxNotFenced(ctx.messagePath);
    await ensureVersionSentinel(ctx.messagePath);
    await fsp.appendFile(ctx.messagePath, serialized + v2Receipts, 'utf8');
    const { mtimeMs, size } = await ctx.statMessageFile();
    ctx.messageCache.set(await ctx.readMessages(), { mtimeMs, size });
    ctx.diag.ackManyPostLockMtime = mtimeMs;
    ctx.diag.ackManyPostLockSize = size;
    ctx.diag.ackManyMessageCount = ctx.messageCache.messageCount;
    ctx.diag.ackManyAckCount = ackRecords.length;
  });

  const foldedById = new Map(
    (await ctx.readMessagesCached())
      .filter((message) => targetIds.has(message.id))
      .map((message) => [message.id, { ...message, readBy: { ...message.readBy } }]),
  );
  const foldedUpdated = updated.map((message) => {
    const folded = foldedById.get(message.id);
    if (folded === undefined) return message;
    return {
      ...folded,
      completed: message.completed,
      completedBy: message.completedBy,
      completedAt: message.completedAt,
      outcome: message.outcome,
    };
  });

  for (const message of foldedUpdated) {
    if (!persistedAckIds.has(message.id)) continue;
    ctx.publishHqMailboxEvent({
      mailboxId: ctx.hqMailboxId,
      action: message.completed ? 'message.completed' : 'message.read',
      message,
    });
    ctx.eventEmitter?.emit({
      type: 'message.acked' as const,
      messageId: message.id,
      from: message.from,
      to: message.to,
      audience: message.audience,
      timestamp: new Date().toISOString(),
    });
  }
  if (foldedUpdated.length > 0) ctx.publishHqMailboxSnapshot();
  return foldedUpdated;
}
