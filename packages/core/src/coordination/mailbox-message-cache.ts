import * as fsp from 'node:fs/promises';
import {
  addMailboxMessageToIndexes,
  buildMailboxMessageIndexes,
} from './mailbox-cache-index.js';
import { MESSAGE_CACHE_MAX_ENTRIES } from './mailbox-constants.js';
import { applyAckToMessage } from './mailbox-message-codec.js';
import {
  type MailboxParseState,
  createMailboxParseState,
  ingestMailboxChunk,
} from './mailbox-parse-state.js';
import { materializeMessage } from './mailbox-receipt-folding.js';
import type { AckRecord, MailboxMessage } from './mailbox-types.js';

export interface MailboxMessageFileStat {
  mtimeMs: number;
  size: number;
}

/**
 * Bytes of the cached prefix retained to prove an on-disk change was a pure
 * append before the incremental path trusts it.
 *
 * The mailbox file is shared across processes and mutated two ways: appends
 * (send / ack / receipt) and whole-file rewrites (auto-compaction). A grown
 * `size` alone cannot distinguish them — a rewrite that happens to be larger
 * would make us splice new lines onto a prefix that no longer exists. Before
 * ingesting a tail we re-read the last `TAIL_ANCHOR_BYTES` of the prefix and
 * require them to match byte-for-byte; anything else falls back to a full
 * re-read. 512 bytes comfortably spans a whole JSONL record, so a rewrite
 * cannot coincidentally reproduce it at the same offset.
 */
const TAIL_ANCHOR_BYTES = 512;

export class MailboxMessageCache {
  private messages: MailboxMessage[] | null = null;
  private mtime = -1;
  private size = -1;
  private readChain: Promise<MailboxMessage[]> = Promise.resolve([] as MailboxMessage[]);
  private recipientIndexMap: Map<string, Set<number>> | null = null;
  private senderIndexMap: Map<string, Set<number>> | null = null;
  /**
   * Fold state backing {@link messages}, kept only while this cache owns the
   * whole read path. `null` disables the incremental tail read (the next full
   * read re-arms it) — see {@link set}, which adopts arrays produced elsewhere
   * and therefore has no receipt/base-message state to append onto.
   */
  private parseState: MailboxParseState | null = null;
  /**
   * Byte offset up to which WHOLE lines have been folded into {@link parseState}.
   *
   * Distinct from {@link size}, which tracks the file length last observed by
   * `stat`. They diverge while a concurrent writer is mid-append: the trailing
   * partial line counts toward the file's length but cannot be parsed yet.
   * Folding must resume at `consumed` (or the half-written record is lost),
   * while the unchanged-check must compare against `size` (or a file whose
   * last line never got a newline would be re-read on every single query).
   */
  private consumed = -1;
  /** Trailing bytes of the prefix ending at {@link consumed}. See TAIL_ANCHOR_BYTES. */
  private anchor: Buffer | null = null;

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
    this.parseState = null;
    this.consumed = -1;
    this.anchor = null;
  }

  set(messages: MailboxMessage[], stat: MailboxMessageFileStat): void {
    if (messages.length > MESSAGE_CACHE_MAX_ENTRIES) {
      this.clear();
      return;
    }
    this.messages = messages;
    this.mtime = stat.mtimeMs;
    this.size = stat.size;
    // An externally-produced array carries no fold state, so incremental
    // appends can't be folded onto it. Disable the fast path until the next
    // full read through this cache rebuilds both.
    this.parseState = null;
    this.consumed = -1;
    this.anchor = null;
    this.rebuildIndexes();
  }

  updateStat(stat: MailboxMessageFileStat): void {
    this.mtime = stat.mtimeMs;
    this.size = stat.size;
    // The anchor described the previous byte range and the caller wrote bytes
    // we never saw, so neither it nor `consumed` can vouch for this one.
    this.consumed = -1;
    this.anchor = null;
  }

  applyAck(ack: AckRecord): void {
    const cache = this.messages;
    if (cache === null) return;
    const state = this.parseState;
    if (state !== null) {
      const indices = state.indexById.get(ack.messageId);
      const index = indices?.[indices.length - 1];
      if (index === undefined) return;
      const message = state.messages[index] as MailboxMessage;
      applyAckToMessage(message, ack);
      state.projections[index] = materializeMessage(
        message,
        state.receiptsByMessage.get(message.id) ?? [],
      );
      return;
    }
    const target = cache.find((message) => message.id === ack.messageId);
    if (target !== undefined) applyAckToMessage(target, ack);
  }

  push(message: MailboxMessage, stat: MailboxMessageFileStat): void {
    if (this.messages === null) return;
    if (this.messages.length >= MESSAGE_CACHE_MAX_ENTRIES) {
      this.clear();
      return;
    }
    const state = this.parseState;
    if (state !== null) {
      const index = state.messages.length;
      state.messages.push(message);
      const indices = state.indexById.get(message.id);
      if (indices) indices.push(index);
      else state.indexById.set(message.id, [index]);
      // `projections` IS `this.messages`; pushing here appends to both, and
      // materializing keeps the projection invariant the fold path relies on.
      state.projections.push(
        materializeMessage(message, state.receiptsByMessage.get(message.id) ?? []),
      );
    } else {
      this.messages.push(message);
    }
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

  /**
   * Read the mailbox, serving the in-memory fold when the file is unchanged
   * and folding only the appended bytes when it merely grew.
   *
   * SERIALIZATION: the work is chained onto `readChain` so two overlapping
   * calls can't both pass the same staleness check against the same tracker
   * and each splice the same tail onto the cache (duplicating every appended
   * message). Readers don't conflict on file content — only on the cache
   * mutation that follows — so they run one at a time in issue order. Errors
   * are swallowed by the chain so a failed read never poisons subsequent
   * reads; each caller observes and re-throws its own error.
   */
  readCached(messagePath: string): Promise<MailboxMessage[]> {
    const run = this.readChain
      .catch(() => undefined as unknown as MailboxMessage[])
      .then(() => this.readCachedWork(messagePath));
    this.readChain = run.catch(() => [] as MailboxMessage[]);
    return run;
  }

  private async readCachedWork(messagePath: string): Promise<MailboxMessage[]> {
    try {
      const stat = await fsp.stat(messagePath);
      if (this.messages !== null && this.mtime === stat.mtimeMs && this.size === stat.size) {
        return this.messages;
      }

      const appended = await this.tryIngestAppendedTail(messagePath, stat);
      if (appended !== null) return appended;

      return await this.fullRead(messagePath, stat);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.set([], { mtimeMs: -1, size: -1 });
        return [];
      }
      throw err;
    }
  }

  /** Whole-file read: parse everything and arm the incremental fast path. */
  private async fullRead(
    messagePath: string,
    stat: { mtimeMs: number; size: number },
  ): Promise<MailboxMessage[]> {
    const buffer = await fsp.readFile(messagePath);
    const state = createMailboxParseState(buffer.toString('utf8'));
    // A trailing partial line parses to nothing here, so `consumed` must stop
    // before it — otherwise the next append would be spliced on AFTER the
    // half-written record and that record would never be folded at all.
    const consumed = buffer.lastIndexOf(0x0a) + 1;
    this.adopt(
      state,
      { mtimeMs: stat.mtimeMs, size: buffer.length },
      consumed,
      sliceAnchor(buffer.subarray(0, consumed)),
    );
    return state.projections;
  }

  /**
   * Fold only the bytes appended since the cached prefix.
   *
   * Returns `null` when the fast path does not apply — no fold state, the file
   * shrank or was rewritten (anchor mismatch), or nothing but a partially
   * written line was added — and the caller should fall back to a full read.
   */
  private async tryIngestAppendedTail(
    messagePath: string,
    stat: { mtimeMs: number; size: number },
  ): Promise<MailboxMessage[] | null> {
    const state = this.parseState;
    const anchor = this.anchor;
    if (state === null || anchor === null || this.messages === null) return null;
    if (this.size < 0 || this.consumed < 0 || stat.size <= this.size) return null;

    const anchorStart = this.consumed - anchor.length;
    const handle = await fsp.open(messagePath, 'r');
    let anchorBuf: Buffer;
    let tailBuf: Buffer;
    try {
      anchorBuf = Buffer.allocUnsafe(anchor.length);
      const anchorRead = await handle.read(anchorBuf, 0, anchor.length, anchorStart);
      if (anchorRead.bytesRead !== anchor.length) return null;
      if (!anchorBuf.equals(anchor)) return null; // rewritten, not appended

      const tailLength = stat.size - this.consumed;
      tailBuf = Buffer.allocUnsafe(tailLength);
      const tailRead = await handle.read(tailBuf, 0, tailLength, this.consumed);
      if (tailRead.bytesRead < tailLength) tailBuf = tailBuf.subarray(0, tailRead.bytesRead);
    } finally {
      await handle.close();
    }

    // Only whole lines can be folded. A trailing partial line (a concurrent
    // writer mid-append) is left for the next read: `consumed` stops before it
    // while `size` records the full length, so the cache still reports itself
    // current until the file changes again, then resumes from the right offset.
    const lastNewline = tailBuf.lastIndexOf(0x0a);
    const chunk = lastNewline < 0 ? null : tailBuf.subarray(0, lastNewline + 1);
    if (chunk === null) {
      this.mtime = stat.mtimeMs;
      this.size = stat.size;
      return this.messages;
    }

    const firstNewIndex = state.projections.length;
    ingestMailboxChunk(state, chunk.toString('utf8'));
    if (state.projections.length > MESSAGE_CACHE_MAX_ENTRIES) {
      const projections = state.projections;
      this.clear();
      return projections;
    }

    this.adopt(
      state,
      { mtimeMs: stat.mtimeMs, size: stat.size },
      this.consumed + chunk.length,
      sliceAnchor(Buffer.concat([anchor, chunk])),
      firstNewIndex,
    );
    return state.projections;
  }

  /**
   * Install fold state as the cache.
   *
   * `firstNewIndex` marks how much of `state.projections` the query indexes
   * already describe: on the incremental path only the appended messages are
   * indexed, keeping the read O(appended) end to end. Re-folded existing
   * messages need no index work — a receipt or ack changes delivery state, not
   * `to`/`from`. Omit it to rebuild from scratch (whole-file reads).
   */
  private adopt(
    state: MailboxParseState,
    stat: MailboxMessageFileStat,
    consumed: number,
    anchor: Buffer,
    firstNewIndex?: number,
  ): void {
    if (state.projections.length > MESSAGE_CACHE_MAX_ENTRIES) {
      this.clear();
      return;
    }
    const incremental =
      firstNewIndex !== undefined &&
      this.recipientIndexMap !== null &&
      this.senderIndexMap !== null;
    this.messages = state.projections;
    this.mtime = stat.mtimeMs;
    this.size = stat.size;
    this.consumed = consumed;
    this.parseState = state;
    this.anchor = anchor;
    if (incremental) {
      const indexes = { recipientIndex: this.recipientIndexMap, senderIndex: this.senderIndexMap };
      for (let index = firstNewIndex; index < state.projections.length; index++) {
        addMailboxMessageToIndexes(indexes, state.projections[index] as MailboxMessage, index);
      }
    } else {
      this.rebuildIndexes();
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

/**
 * Copy the trailing anchor bytes out of `buffer`.
 *
 * The copy is deliberate: `subarray` would share the backing store and pin the
 * entire file contents in memory for as long as the cache lives — the exact
 * class of retention this cache exists to avoid.
 */
function sliceAnchor(buffer: Buffer): Buffer {
  const start = Math.max(0, buffer.length - TAIL_ANCHOR_BYTES);
  return Buffer.from(buffer.subarray(start));
}
