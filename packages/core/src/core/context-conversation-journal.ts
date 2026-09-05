import type { Message } from '../types/messages.js';
import type { SessionEvent, SessionWriter } from '../types/session.js';

export function isAppendableSessionWriter(writer: unknown): writer is SessionWriter {
  return Boolean(
    writer &&
      typeof writer === 'object' &&
      typeof (writer as { append?: unknown }).append === 'function',
  );
}

export interface QueuedJournalEvent {
  event: SessionEvent;
  bytes: number;
  writer: SessionWriter;
  attempts?: number;
}

export interface ConversationJournalOptions {
  sessionIdGetter: () => string | undefined;
  messagesGetter: () => Message[];
}

export class ConversationJournalQueue {
  static readonly CONVERSATION_JOURNAL_MAX_EVENTS = 256;
  static readonly CONVERSATION_JOURNAL_MAX_BYTES = 4 * 1024 * 1024;

  readonly queue: QueuedJournalEvent[] = [];
  bytes = 0;
  drain: Promise<void> | null = null;
  lastError: Error | null = null;
  dropCount = 0;
  dropWarnAt = 0;

  constructor(private readonly options: ConversationJournalOptions) {}

  conversationJournalBytes(event: SessionEvent): number {
    try {
      return Buffer.byteLength(JSON.stringify(event), 'utf8');
    } catch {
      return ConversationJournalQueue.CONVERSATION_JOURNAL_MAX_BYTES + 1;
    }
  }

  /** Throttled notice that a conversation event never reached the journal. */
  warnConversationJournalDrop(eventType: SessionEvent['type']): void {
    this.dropCount++;
    const now = Date.now();
    if (now - this.dropWarnAt < 5_000) return;
    this.dropWarnAt = now;
    const dropped = this.dropCount;
    this.dropCount = 0;
    console.warn(
      JSON.stringify({
        level: 'error',
        event: 'session.conversation_journal_drop',
        sessionId: this.options.sessionIdGetter(),
        eventType,
        droppedEvents: dropped,
        message: 'Session writer is not draining; replay of this session will be incomplete.',
        timestamp: new Date().toISOString(),
      }),
    );
  }

  enqueueConversationJournal(event: SessionEvent, writer: SessionWriter): void {
    if (!isAppendableSessionWriter(writer)) {
      this.warnConversationJournalDrop(event.type);
      return;
    }
    this.lastError = null;
    const bytes = this.conversationJournalBytes(event);
    const shouldSnapshot =
      event.type === 'messages_replaced' ||
      this.queue.length >= ConversationJournalQueue.CONVERSATION_JOURNAL_MAX_EVENTS ||
      this.bytes + bytes > ConversationJournalQueue.CONVERSATION_JOURNAL_MAX_BYTES;

    if (shouldSnapshot) {
      const snapshot: SessionEvent =
        event.type === 'messages_replaced'
          ? event
          : {
              type: 'messages_replaced',
              ts: new Date().toISOString(),
              version: 1,
              messages: [...this.options.messagesGetter()],
            };
      const snapshotBytes = this.conversationJournalBytes(snapshot);
      for (let index = this.queue.length - 1; index >= 0; index -= 1) {
        const queued = this.queue[index];
        if (queued?.writer !== writer) continue;
        this.bytes = Math.max(0, this.bytes - queued.bytes);
        this.queue.splice(index, 1);
      }
      this.queue.push({ event: snapshot, bytes: snapshotBytes, writer });
      this.bytes += snapshotBytes;
    } else {
      this.queue.push({ event, bytes, writer });
      this.bytes += bytes;
    }

    while (
      this.queue.length > ConversationJournalQueue.CONVERSATION_JOURNAL_MAX_EVENTS ||
      this.bytes > ConversationJournalQueue.CONVERSATION_JOURNAL_MAX_BYTES
    ) {
      const index = this.queue.findIndex((queued) => queued.event.type !== 'messages_replaced');
      if (index === -1) break;
      const [dropped] = this.queue.splice(index, 1);
      if (!dropped) break;
      this.bytes = Math.max(0, this.bytes - dropped.bytes);
      this.warnConversationJournalDrop(dropped.event.type);
    }
    this.startConversationJournalDrain();
  }

  startConversationJournalDrain(): void {
    if (this.drain) return;
    const drain = (async () => {
      while (this.queue.length > 0) {
        const queued = this.queue.shift();
        if (!queued) continue;
        this.bytes = Math.max(0, this.bytes - queued.bytes);
        if (!isAppendableSessionWriter(queued.writer)) {
          this.warnConversationJournalDrop(queued.event.type);
          continue;
        }
        try {
          await queued.writer.append(queued.event);
          this.lastError = null;
        } catch (err) {
          const attempts = (queued.attempts ?? 0) + 1;
          this.queue.unshift({ ...queued, attempts });
          this.bytes += queued.bytes;
          const error = err instanceof Error ? err : new Error(String(err));
          this.lastError = error;
          if (attempts < 3) {
            await new Promise((resolve) => setTimeout(resolve, attempts * 25));
            continue;
          }
          console.warn(
            JSON.stringify({
              level: 'error',
              event: 'session.conversation_journal_write_failed',
              sessionId: this.options.sessionIdGetter(),
              eventType: queued.event.type,
              attempts,
              message: error.message,
              timestamp: new Date().toISOString(),
            }),
          );
          break;
        }
      }
    })().finally(() => {
      if (this.drain === drain) this.drain = null;
      if (this.queue.length > 0 && !this.lastError) {
        this.startConversationJournalDrain();
      }
    });
    this.drain = drain;
  }

  async flushConversationJournal(): Promise<void> {
    for (;;) {
      if (this.queue.length > 0) this.startConversationJournalDrain();
      const drain = this.drain;
      if (!drain) break;
      await drain;
      if (this.queue.length > 0 && this.lastError) {
        throw this.lastError;
      }
    }
    this.queue.length = 0;
    this.bytes = 0;
    this.lastError = null;
  }
}
