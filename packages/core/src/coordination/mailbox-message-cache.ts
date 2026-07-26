import * as fsp from 'node:fs/promises';
import {
  addMailboxMessageToIndexes,
  buildMailboxMessageIndexes,
} from './mailbox-cache-index.js';
import { MESSAGE_CACHE_MAX_ENTRIES } from './mailbox-constants.js';
import { applyAckToMessage } from './mailbox-message-codec.js';
import type { AckRecord, MailboxMessage } from './mailbox-types.js';

export interface MailboxMessageFileStat {
  mtimeMs: number;
  size: number;
}

export class MailboxMessageCache {
  private messages: MailboxMessage[] | null = null;
  private mtime = -1;
  private size = -1;
  private readChain: Promise<MailboxMessage[]> = Promise.resolve([] as MailboxMessage[]);
  private recipientIndexMap: Map<string, Set<number>> | null = null;
  private senderIndexMap: Map<string, Set<number>> | null = null;

  get recipientIndex(): Map<string, Set<number>> | null {
    return this.recipientIndexMap;
  }

  get senderIndex(): Map<string, Set<number>> | null {
    return this.senderIndexMap;
  }

  get mtimeMs(): number {
    return this.mtime;
  }

  get sizeBytes(): number {
    return this.size;
  }

  get messageCount(): number {
    return this.messages?.length ?? -1;
  }

  clear(): void {
    this.messages = null;
    this.mtime = -1;
    this.size = -1;
    this.recipientIndexMap = null;
    this.senderIndexMap = null;
  }

  set(messages: MailboxMessage[], stat: MailboxMessageFileStat): void {
    if (messages.length > MESSAGE_CACHE_MAX_ENTRIES) {
      this.clear();
      return;
    }
    this.messages = messages;
    this.mtime = stat.mtimeMs;
    this.size = stat.size;
    this.rebuildIndexes();
  }

  updateStat(stat: MailboxMessageFileStat): void {
    this.mtime = stat.mtimeMs;
    this.size = stat.size;
  }

  applyAck(ack: AckRecord): void {
    const cache = this.messages;
    if (cache === null) return;
    const target = cache.find((message) => message.id === ack.messageId);
    if (target !== undefined) applyAckToMessage(target, ack);
  }

  push(message: MailboxMessage, stat: MailboxMessageFileStat): void {
    if (this.messages === null) return;
    if (this.messages.length >= MESSAGE_CACHE_MAX_ENTRIES) {
      this.clear();
      return;
    }
    this.messages.push(message);
    addMailboxMessageToIndexes(
      { recipientIndex: this.recipientIndexMap, senderIndex: this.senderIndexMap },
      message,
      this.messages.length - 1,
    );
    this.updateStat(stat);
  }

  async readFresh(
    readMessages: () => Promise<MailboxMessage[]>,
    statMessageFile: () => Promise<MailboxMessageFileStat>,
  ): Promise<MailboxMessage[]> {
    const all = await readMessages();
    this.set(all, await statMessageFile());
    return all;
  }

  async refreshUnderLock(
    readMessages: () => Promise<MailboxMessage[]>,
    statMessageFile: () => Promise<MailboxMessageFileStat>,
  ): Promise<boolean> {
    if (this.messages === null) return false;
    const stat = await statMessageFile();
    if (this.mtime === stat.mtimeMs && this.size === stat.size) return false;
    this.set(await readMessages(), stat);
    return true;
  }

  readCached(
    messagePath: string,
    readMessages: () => Promise<MailboxMessage[]>,
  ): Promise<MailboxMessage[]> {
    const run = this.readChain
      .catch(() => undefined as unknown as MailboxMessage[])
      .then(() => this.readCachedWork(messagePath, readMessages));
    this.readChain = run.catch(() => [] as MailboxMessage[]);
    return run;
  }

  private async readCachedWork(
    messagePath: string,
    readMessages: () => Promise<MailboxMessage[]>,
  ): Promise<MailboxMessage[]> {
    try {
      const stat = await fsp.stat(messagePath);
      if (
        this.messages !== null &&
        this.mtime === stat.mtimeMs &&
        this.size === stat.size
      ) {
        return this.messages;
      }
      const all = await readMessages();
      this.set(all, { mtimeMs: stat.mtimeMs, size: stat.size });
      return all;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.set([], { mtimeMs: -1, size: -1 });
        return [];
      }
      throw err;
    }
  }

  private rebuildIndexes(): void {
    const cache = this.messages;
    if (cache === null) {
      this.recipientIndexMap = null;
      this.senderIndexMap = null;
      return;
    }
    const { recipientIndex, senderIndex } = buildMailboxMessageIndexes(cache);
    this.recipientIndexMap = recipientIndex;
    this.senderIndexMap = senderIndex;
  }
}
