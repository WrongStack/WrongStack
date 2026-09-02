/**
 * V2 receipt record folding and message materialization.
 *
 * GM-P0.4: This module implements the per-actor receipt state materialization
 * that replaces the message-global `completed` boolean with actor-scoped
 * delivery state. It also implements the v1→v2 migration classification rules.
 *
 * The key insight: v1 ack records (`__ack: true`) and v2 receipt records
 * (`__mailboxReceipt: 2`) coexist in the same JSONL file during migration.
 * This module folds BOTH into a unified `MailboxMessageProjection` that
 * carries per-actor `recipientState`.
 *
 * @module mailbox-receipt-folding
 */

import type {
  MailboxMessage,
  MailboxMessageProjection,
  MailboxRecipientState,
  MailboxReceiptRecordV2,
} from './mailbox-types.js';
import { isMailboxReceiptRecordV2 } from './mailbox-types.js';

export type { MailboxMessageProjection };

/**
 * Determine if a message's recipient is a fan-out form (broadcast, alias, or
 * session-scoped). Fan-out messages use `legacyGlobalCompletion` for v1 acks
 * because the original semantic was message-global.
 *
 * Heuristic: exact agent IDs are qualified with either `@` (session identity)
 * or `#` (process identity), matching `mailboxIdentityBase()`. A `to` value
 * without either delimiter is a bare base alias such as `leader` or `worker`
 * and therefore fans out. `*` and `@session:...` are explicit broadcasts.
 */
export function isFanOutRecipient(to: string): boolean {
  if (to === '*') return true;
  if (to.startsWith('@session:')) return true;
  // A bare base alias contains neither exact-recipient delimiter.
  return !to.includes('@') && !to.includes('#');
}

/**
 * Materialize messages with per-actor recipient state.
 *
 * Input: the raw parsed messages (already folded with v1 acks by
 * `parseMailboxLines()`), plus any v2 receipt records found in the file.
 *
 * Output: `MailboxMessageProjection[]` carrying:
 *   - `recipientState`: per-actor delivery/action state
 *   - `legacyGlobalCompletion`: true for historical v1 fan-out completions
 *
 * v1 completion classification:
 *   - Direct exact-recipient message + completed v1 ack → actor-scoped for
 *     that recipient. The `completed` boolean is projected from
 *     `recipientState[recipient].completedAt !== undefined`.
 *   - Fan-out message (broadcast/alias/session) + completed v1 ack →
 *     `legacyGlobalCompletion: true`. The message remains globally
 *     suppressed; NO actor-scoped completion is created.
 *
 * v2 receipt folding:
 *   - Keyed by `(messageId, actorId)`.
 *   - `read`: first-write-wins (earliest timestamp preserved).
 *   - `completed`: monotonic upward (once true, cannot revert unless an
 *     explicit `completed: false` record is appended).
 *   - `outcome`: last-write-wins.
 *   - Duplicate records (same messageId, actorId, timestamp): idempotent.
 */
export function materializeMessages(
  messages: readonly MailboxMessage[],
  v2Receipts: readonly MailboxReceiptRecordV2[],
): MailboxMessageProjection[] {
  // Index v2 receipts by messageId for efficient lookup.
  const receiptsByMessage = new Map<string, MailboxReceiptRecordV2[]>();
  for (const receipt of v2Receipts) {
    const list = receiptsByMessage.get(receipt.messageId);
    if (list) list.push(receipt);
    else receiptsByMessage.set(receipt.messageId, [receipt]);
  }

  return messages.map((msg) => materializeMessage(msg, receiptsByMessage.get(msg.id) ?? []));
}

/**
 * Materialize a single message against the receipts that target it.
 *
 * Split out of {@link materializeMessages} so the incremental read path
 * (see `mailbox-parse-state.ts`) can re-fold exactly the messages an appended
 * chunk touched instead of re-projecting the entire file. Callers MUST pass
 * the message's COMPLETE receipt list, not just the newly appended ones —
 * `foldRecipientState` sorts by timestamp and `classifyLegacyCompletion`
 * scans for any `completed: true`, so a partial list would diverge from a
 * full parse.
 */
export function materializeMessage(
  msg: MailboxMessage,
  msgReceipts: readonly MailboxReceiptRecordV2[],
): MailboxMessageProjection {
  const recipientState = foldRecipientState(msg, msgReceipts);
  const legacyGlobalCompletion = classifyLegacyCompletion(msg, msgReceipts);

  return {
    ...msg,
    recipientState,
    ...(legacyGlobalCompletion ? { legacyGlobalCompletion: true } : {}),
  };
}

/**
 * Fold v2 receipt records into a per-actor `recipientState` map for a
 * single message. Also seeds from v1 `readBy` entries (which are
 * per-recipient read timestamps from the existing schema).
 *
 * Fold algebra:
 *   - `readAt`: first-write-wins (earliest read timestamp is preserved).
 *   - `completedAt`: monotonic upward (once set, cannot be cleared by
 *     a new receipt unless `completed: false` is explicitly set, which
 *     acts as a reopen).
 *   - `outcome`: last-write-wins.
 */
function foldRecipientState(
  msg: MailboxMessage,
  v2Receipts: readonly MailboxReceiptRecordV2[],
): Record<string, MailboxRecipientState> {
  const state: Record<string, MailboxRecipientState> = {};

  // Seed from v1 readBy entries (these are already per-recipient read timestamps).
  for (const [actorId, readAt] of Object.entries(msg.readBy)) {
    state[actorId] = { actorId, readAt };
  }

  // Seed from v1 completion (only for direct messages — fan-out uses legacyGlobalCompletion).
  if (msg.completed && msg.completedBy && !isFanOutRecipient(msg.to)) {
    const existing = state[msg.completedBy] ?? { actorId: msg.completedBy };
    state[msg.completedBy] = {
      ...existing,
      completedAt: msg.completedAt ?? msg.timestamp,
      completedBy: msg.completedBy,
      ...(msg.outcome !== undefined ? { outcome: msg.outcome } : {}),
    };
  }

  // Fold v2 receipt records.
  // Sort by timestamp to ensure deterministic fold order. ECMAScript's stable
  // sort preserves persisted file order when timestamps compare equal.
  const sorted = [...v2Receipts].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  for (const receipt of sorted) {
    const actorId = receipt.actorId;
    const existing = state[actorId] ?? { actorId };

    // readAt: first-write-wins.
    const readAt = existing.readAt ?? (receipt.read === true ? receipt.timestamp : undefined);

    // completedAt: monotonic upward. Can be cleared by explicit completed: false (reopen).
    let completedAt = existing.completedAt;
    let completedBy = existing.completedBy;
    if (receipt.completed === true) {
      completedAt = receipt.timestamp;
      completedBy = actorId;
    } else if (receipt.completed === false) {
      completedAt = undefined;
      completedBy = undefined;
    }

    // outcome: last-write-wins.
    const outcome = receipt.outcome !== undefined ? receipt.outcome : existing.outcome;

    state[actorId] = { actorId, readAt, completedAt, completedBy, outcome };
  }

  return state;
}

/**
 * Classify whether a v1 message's completion should be treated as
 * `legacyGlobalCompletion`.
 *
 * Rules (from SDD R3):
 *   - Fan-out message (broadcast/alias/session) with `completed: true`
 *     → `legacyGlobalCompletion: true` regardless of `readerId`.
 *   - Direct exact-recipient message with `completed: true`
 *     → NOT legacy (it's actor-scoped, handled in foldRecipientState).
 */
function classifyLegacyCompletion(
  msg: MailboxMessage,
  v2Receipts: readonly MailboxReceiptRecordV2[],
): boolean {
  if (!msg.completed) return false;
  // Suppress legacy-global classification only when v2 data carries
  // unambiguous actor-scoped completion provenance — at least one v2
  // receipt with completed:true. A read-only v2 receipt must NOT
  // suppress legacy completion (GM-P0.4 R3).
  if (v2Receipts.some((r) => r.completed === true)) return false;
  return isFanOutRecipient(msg.to);
}

/**
 * Serialize a v2 receipt record to a JSONL line.
 */
export function serializeReceiptRecordV2(record: MailboxReceiptRecordV2): string {
  return JSON.stringify(record) + '\n';
}

/**
 * Extract v2 receipt records from a set of parsed JSONL lines.
 * Messages and v1 ack records are ignored.
 *
 * This is used by the read path to separate receipts from messages
 * before materialization.
 *
 * @param parsed - Array of parsed JSON values from the JSONL file.
 * @returns Only the values that pass `isMailboxReceiptRecordV2`.
 */
export function extractV2Receipts(parsed: readonly unknown[]): MailboxReceiptRecordV2[] {
  const receipts: MailboxReceiptRecordV2[] = [];
  for (const item of parsed) {
    if (isMailboxReceiptRecordV2(item)) {
      receipts.push(item);
    }
  }
  return receipts;
}

/**
 * Build a v2 receipt record from an ack operation.
 * Used when folding legacy v1 ack records during the one-shot import.
 */
export function buildReceiptRecordV2(
  messageId: string,
  actorId: string,
  timestamp: string,
  opts: { read?: boolean; completed?: boolean; outcome?: string },
): MailboxReceiptRecordV2 {
  const record: MailboxReceiptRecordV2 = {
    __mailboxReceipt: 2,
    messageId,
    actorId,
    timestamp,
  };
  if (opts.read !== undefined) record.read = opts.read;
  if (opts.completed !== undefined) record.completed = opts.completed;
  if (opts.outcome !== undefined) record.outcome = opts.outcome;
  return record;
}
