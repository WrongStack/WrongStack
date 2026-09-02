/**
 * Parse state for the legacy mailbox JSONL file.
 *
 * ## Where this runs today
 *
 * ONE caller: `SqliteMailbox.migrateLegacyFiles()` via `parseMailboxFile()`,
 * i.e. the one-shot import of a pre-SQLite `_mailbox.jsonl` that runs at most
 * once per project and is then fenced off by the `legacy_files_imported`
 * marker. Nothing reads JSONL on the live path any more: the detached owner
 * holds the only handle and every query is SQL.
 *
 * The incremental half of this module — `createMailboxParseState` +
 * `ingestMailboxChunk` called with an appended chunk — has NO production
 * caller. `parseMailboxFile()` is implemented on top of it (one fold, not
 * two), so the code runs, but the append path and its invariants (stale-index
 * tracking, `firstNewIndex`, duplicate-id fan-out) are exercised only by
 * tests. Treat a change there as unvalidated by production traffic.
 *
 * ## Why it was built this way
 *
 * Historical, and worth keeping because the fold logic is still the thing
 * that has to be exact: when the mailbox WAS a JSONL file, the read path was
 * anything but one-shot — `unreadCount()`/`query()` consulted a cache on every
 * tool call and any append by another session invalidated it. On a mailbox
 * holding a day of fleet traffic (~3 MB / ~2.8k lines) a full re-parse per
 * read became the single largest allocation source in the TUI process: ~78% of
 * all bytes allocated while idle, piling up as garbage until a major GC — read
 * as "RAM keeps growing and /clear doesn't help". That pressure is gone with
 * the store; the exactness requirement is not.
 *
 * The module keeps enough state alongside the projections that an APPEND can
 * be folded in without touching the bytes that were already parsed:
 *
 *   - `messages`          — base messages in file order, v1 acks already folded
 *   - `receiptsByMessage` — every v2 receipt, keyed by target message id
 *   - `indexById`         — message id → indices (plural: duplicate ids are
 *                           pathological but must fold exactly as a full parse
 *                           would — acks hit the last, receipts hit them all)
 *   - `projections`       — the materialized result, parallel to `messages`
 *
 * The fold is *exact*, not approximate: appended receipts are accumulated into
 * the full per-message list and the affected messages are re-materialized from
 * that complete list, so the output is byte-for-byte what `parseMailboxFile()`
 * would have produced over the whole file. `parseMailboxFile()` itself is now
 * implemented on top of this module, so there is one fold, not two.
 *
 * @module mailbox-parse-state
 */

import { LINE_SEPARATOR } from './mailbox-constants.js';
import { applyAckToMessage, isAckRecord, parseMailboxMessage } from './mailbox-message-codec.js';
import { materializeMessage } from './mailbox-receipt-folding.js';
import type {
  AckRecord,
  MailboxMessage,
  MailboxMessageProjection,
  MailboxReceiptRecordV2,
} from './mailbox-types.js';
import { isMailboxReceiptRecordV2 } from './mailbox-types.js';

export interface MailboxParseState {
  /** Base messages in file order, with v1 ack records already applied. */
  messages: MailboxMessage[];
  /** Materialized projections, index-parallel to {@link messages}. */
  projections: MailboxMessageProjection[];
  /** Message id → every index in {@link messages} carrying that id. */
  indexById: Map<string, number[]>;
  /** Message id → every v2 receipt targeting it, in file order. */
  receiptsByMessage: Map<string, MailboxReceiptRecordV2[]>;
}

/**
 * Parse the raw JSONL content of a mailbox file into MailboxMessageProjection[].
 *
 * This is the canonical read-path entry point: it parses each line once,
 * classifies v1 messages, v1 ack records, and v2 receipt records, then folds
 * them into a unified MailboxMessageProjection carrying per-actor state.
 *
 * Malformed lines are silently skipped (same tolerance as parseMailboxLines).
 *
 * Lives here rather than in `mailbox-receipt-folding.ts` so the whole-file and
 * incremental paths share one fold; the dependency stays one-directional
 * (parse-state → receipt-folding) instead of forming an import cycle.
 */
export function parseMailboxFile(raw: string): MailboxMessageProjection[] {
  return createMailboxParseState(raw).projections;
}

/** Build parse state from the complete raw contents of a mailbox file. */
export function createMailboxParseState(raw: string): MailboxParseState {
  const state: MailboxParseState = {
    messages: [],
    projections: [],
    indexById: new Map(),
    receiptsByMessage: new Map(),
  };
  ingestMailboxChunk(state, raw);
  return state;
}

/**
 * Fold an appended chunk of JSONL into existing parse state, in place.
 *
 * `chunk` must be a run of WHOLE lines starting exactly where the previously
 * ingested content ended — the caller is responsible for trimming a partially
 * written trailing line (see `MailboxMessageCache`). Malformed lines are
 * skipped with the same tolerance as a full parse.
 *
 * Ordering matches a full parse: within the chunk, messages are collected
 * first and ack records applied afterwards, so an ack may target a message
 * that appears later in the same chunk. Ack records whose target is in
 * neither the chunk nor the existing state are dropped, exactly as the
 * whole-file fold drops them.
 */
export function ingestMailboxChunk(state: MailboxParseState, chunk: string): void {
  const firstNewIndex = state.messages.length;
  const ackRecords: AckRecord[] = [];
  // Indices of PRE-EXISTING messages whose projection is now stale. Newly
  // appended messages are materialized unconditionally below, so they are
  // deliberately not tracked here.
  const staleExisting = new Set<number>();

  for (const line of chunk.split(LINE_SEPARATOR)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }

    if (isMailboxReceiptRecordV2(parsed)) {
      const list = state.receiptsByMessage.get(parsed.messageId);
      if (list) list.push(parsed);
      else state.receiptsByMessage.set(parsed.messageId, [parsed]);
      // A receipt re-folds EVERY message carrying that id, matching
      // `materializeMessages`, which looks receipts up per message.
      for (const index of state.indexById.get(parsed.messageId) ?? []) {
        if (index < firstNewIndex) staleExisting.add(index);
      }
      continue;
    }

    if (isAckRecord(parsed)) {
      ackRecords.push(parsed);
      continue;
    }

    let message: MailboxMessage;
    try {
      message = parseMailboxMessage(parsed);
    } catch {
      continue; // codec rejected the record — same tolerance as a full parse
    }
    const index = state.messages.length;
    state.messages.push(message);
    const indices = state.indexById.get(message.id);
    if (indices) indices.push(index);
    else state.indexById.set(message.id, [index]);
  }

  // v1 acks resolve against the last message carrying the id, mirroring the
  // whole-file fold's `new Map(messages.map(m => [m.id, m]))` (last wins).
  for (const ack of ackRecords) {
    const indices = state.indexById.get(ack.messageId);
    if (indices === undefined || indices.length === 0) continue;
    const index = indices[indices.length - 1] as number;
    applyAckToMessage(state.messages[index] as MailboxMessage, ack);
    if (index < firstNewIndex) staleExisting.add(index);
  }

  for (const index of staleExisting) {
    const message = state.messages[index] as MailboxMessage;
    state.projections[index] = materializeMessage(
      message,
      state.receiptsByMessage.get(message.id) ?? [],
    );
  }
  for (let index = firstNewIndex; index < state.messages.length; index++) {
    const message = state.messages[index] as MailboxMessage;
    state.projections.push(
      materializeMessage(message, state.receiptsByMessage.get(message.id) ?? []),
    );
  }
}
