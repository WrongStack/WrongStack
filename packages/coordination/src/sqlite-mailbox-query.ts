import { isMessageCompletedForActor } from './global-mailbox-completion.js';

import { normalizeMailboxMessageType } from './mailbox-message-codec.js';

import { projectMailboxCompletion } from './mailbox-retention-state.js';

import type {
  MailboxAgentStatus,
  MailboxMessage,
  MailboxMessageProjection,
  MailboxQuery,
} from './mailbox-types.js';

import {
  acceptMailboxMessageForSession,
  isMailboxLeader,
  isMailboxMessageVisibleTo,
  type MailboxSessionAffinityContext,
  sessionRecipient,
} from './mailbox-types.js';

import type { MessageRow, SqliteStatement } from './sqlite-mailbox-rows.js';

export interface SqliteMailboxQueryHost {
  getAgentStatuses: () => Promise<MailboxAgentStatus[]>;
  stmt: (sql: string) => SqliteStatement;
  materializeMessageRows: (rows: readonly MessageRow[]) => MailboxMessageProjection[];
}
export async function query(
  host: SqliteMailboxQueryHost,
  query: MailboxQuery,
): Promise<MailboxMessage[]> {
  const type = query.type === undefined ? undefined : normalizeMailboxMessageType(query.type);
  const priorityRank = { low: 0, normal: 1, high: 2 } as const;
  const minimumRank = query.minPriority === undefined ? 0 : priorityRank[query.minPriority];
  // Stored timestamps are toISOString() text and are compared as text, so an
  // ISO instant written with an offset ("…+03:00") must be put in that same
  // form first or it orders by its local clock and drops later messages.
  const sinceMs = query.since === undefined ? Number.NaN : Date.parse(query.since);
  const since = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : query.since;
  const untilMs = query.until === undefined ? Number.NaN : Date.parse(query.until);
  const until = Number.isFinite(untilMs) ? new Date(untilMs).toISOString() : query.until;
  // An explicit empty id set matches nothing — and `IN ()` is not valid
  // SQL, so this has to short-circuit before the statement is built.
  if (query.ids !== undefined && query.ids.length === 0) return [];
  const limit =
    typeof query.limit === 'number' && Number.isFinite(query.limit) && query.limit >= 1
      ? Math.floor(query.limit)
      : 50;
  const statuses = query.unreadBy === undefined ? await host.getAgentStatuses() : undefined;
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (query.ids !== undefined) {
    where.push(`id IN (${query.ids.map(() => '?').join(', ')})`);
    params.push(...query.ids);
  }
  if (query.to !== undefined) {
    where.push('(to_id = ? OR to_id = ?)');
    params.push(query.to, '*');
  }
  if (query.from !== undefined) {
    where.push('from_id = ?');
    params.push(query.from);
  }
  if (query.sessionId !== undefined) {
    where.push('sender_session_id = ?');
    params.push(query.sessionId);
  }
  if (type !== undefined) {
    where.push('type = ?');
    params.push(type);
  }
  if (query.minPriority !== undefined) {
    // Unrecognized priorities rank as `normal`, matching the JSONL reader
    // this store replaced: an unknown value must not silently drop a
    // message out of a `minPriority: 'normal'` query. Only an explicit
    // 'low' ranks below normal.
    where.push(`CASE priority WHEN 'high' THEN 2 WHEN 'low' THEN 0 ELSE 1 END >= ?`);
    params.push(minimumRank);
  }
  if (since !== undefined) {
    where.push('timestamp > ?');
    params.push(since);
  }
  if (until !== undefined) {
    where.push('timestamp <= ?');
    params.push(until);
  }
  if (!query.includeDeleted) where.push('deleted_at IS NULL');
  if (query.replyTo !== undefined) {
    where.push('reply_to = ?');
    params.push(query.replyTo);
  }
  if (query.unreadBy !== undefined) {
    if (!isMailboxLeader(query.unreadBy, query.readerRole)) {
      where.push("COALESCE(json_extract(data, '$.audience'), 'all') <> 'leaders'");
    }
    if (!query.incompleteOnly) {
      where.push(`NOT EXISTS (
          SELECT 1 FROM message_receipts AS unread_receipt
          WHERE unread_receipt.message_id = messages.id
            AND unread_receipt.actor_id = ?
            AND unread_receipt.read_at IS NOT NULL
        )`);
      params.push(query.unreadBy);
      where.push(`NOT EXISTS (
          SELECT 1 FROM json_each(
            CASE WHEN json_type(data, '$.readBy') = 'object'
                 THEN json_extract(data, '$.readBy')
                 ELSE NULL
            END
          ) AS legacy_read
          WHERE legacy_read.key = ?
        )`);
      params.push(query.unreadBy);
    } else {
      where.push('legacy_global_completion = 0');
      where.push(`NOT EXISTS (
          SELECT 1 FROM message_receipts AS completed_receipt
          WHERE completed_receipt.message_id = messages.id
            AND completed_receipt.actor_id = ?
            AND completed_receipt.completed_at IS NOT NULL
        )`);
      params.push(query.unreadBy);
      where.push(`(
          completed = 0 OR EXISTS (
            SELECT 1 FROM message_receipts AS any_receipt
            WHERE any_receipt.message_id = messages.id
          )
        )`);
    }
  }
  const canPreLimit =
    (!query.incompleteOnly || query.unreadBy !== undefined) &&
    query.currentSessionId === undefined &&
    query.sessionAffinityCtx === undefined;
  let sql = 'SELECT id, data, legacy_global_completion FROM messages';
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
  // `rowid DESC` breaks ties: two sends can land in the same millisecond and
  // ISO timestamps have no finer resolution. Without it SQLite is free to
  // return same-millisecond messages in any order, and "newest first"
  // becomes a coin flip. Insertion order is stable — `persistMessage`
  // upserts, so an ack never moves a message's rowid.
  sql += ' ORDER BY timestamp DESC, rowid DESC';
  if (canPreLimit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }
  const rows = host.stmt(sql).all(...params) as unknown as MessageRow[];
  const idFilter = query.ids === undefined ? undefined : new Set(query.ids);
  const filtered = host.materializeMessageRows(rows).filter((message) => {
    if (idFilter !== undefined && !idFilter.has(message.id)) return false;
    if (query.to !== undefined && message.to !== query.to && message.to !== '*') return false;
    if (query.from !== undefined && message.from !== query.from) return false;
    if (query.sessionId !== undefined && message.senderSessionId !== query.sessionId) return false;
    if (
      query.unreadBy !== undefined &&
      !isMailboxMessageVisibleTo(message, query.unreadBy, query.readerRole)
    )
      return false;
    if (!query.incompleteOnly && query.unreadBy !== undefined && query.unreadBy in message.readBy)
      return false;
    if (
      query.incompleteOnly &&
      (query.unreadBy === undefined
        ? projectMailboxCompletion(message, undefined, statuses).completed
        : isMessageCompletedForActor(message, query.unreadBy))
    )
      return false;
    if (type !== undefined && message.type !== type) return false;
    if (priorityRank[message.priority] < minimumRank) return false;
    if (since !== undefined && message.timestamp <= since) return false;
    if (until !== undefined && message.timestamp > until) return false;
    if (!query.includeDeleted && message.deletedAt !== undefined) return false;
    if (query.replyTo !== undefined && message.replyTo !== query.replyTo) return false;
    return true;
  });
  // Session-affinity receive-side filter (matches the inbox checker's
  // applySessionAffinityFilter in mailbox-attach.ts): when the reader's
  // current session is provided, drop messages whose affinity token
  // targets a different session. This keeps the badge/query paths in
  // agreement with what the inbox actually shows.
  let messages = filtered;
  if (query.currentSessionId !== undefined || query.sessionAffinityCtx !== undefined) {
    const kept: MailboxMessageProjection[] = [];
    for (const message of filtered) {
      if (
        await acceptMailboxMessageForSession(
          message,
          query.currentSessionId,
          query.sessionAffinityCtx,
        )
      ) {
        kept.push(message);
      }
    }
    messages = kept;
  }
  messages.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  return messages.slice(0, limit).map((message) => {
    const copy = {
      ...projectMailboxCompletion(message, query.unreadBy, statuses),
      readBy: { ...message.readBy },
    };
    if (!query.includeReceiptState) {
      delete (copy as Partial<MailboxMessageProjection>).recipientState;
      delete (copy as Partial<MailboxMessageProjection>).legacyGlobalCompletion;
    }
    return copy;
  });
}

/**
 * Count the messages this actor has neither read nor completed.
 *
 * Pushed into SQL rather than filtering `readMessages()`. The pre-tool hook
 * asks for this repeatedly — `mailbox-hooks.ts` throttles it to once a
 * second, which bounds the frequency but not the cost — and the JS form
 * materialized EVERY row in `messages`, joined the whole `message_receipts`
 * table, and folded per-actor receipt state across all of them just to
 * return an integer.
 *
 * The predicate is deliberately the same one {@link query} builds for
 * `{ unreadBy, incompleteOnly }`, because it has to agree exactly with
 * `isMessageCompletedForActor` and `isMailboxMessageVisibleTo`:
 *
 * - **unread** — no per-actor receipt carrying `read_at`, and no legacy
 *   `readBy` key. Both are checked: `ackMany` writes the receipt row AND
 *   mirrors the timestamp into the message's `readBy` JSON.
 * - **incomplete** — not `legacy_global_completion`, no per-actor receipt
 *   carrying `completed_at`, and the aggregate `completed` flag counts only
 *   when the message has no receipts at all (once any actor has a receipt,
 *   completion is per-actor and the aggregate flag is not authoritative).
 * - **audience** — `leaders` mail is invisible unless the actor's base
 *   identity is `leader`. This call path carries no role, matching the
 *   `isMailboxMessageVisibleTo(message, forAgentId)` it replaces.
 */
export async function unreadCount(
  host: SqliteMailboxQueryHost,
  forAgentId: string,
  sessionId?: string,
  ctx?: MailboxSessionAffinityContext,
): Promise<number> {
  const sessionAddress = sessionId === undefined ? undefined : sessionRecipient(sessionId);
  const where: string[] = [];
  const params: string[] = [];

  const recipients = ['to_id = ?', "to_id = '*'"];
  params.push(forAgentId);
  if (sessionAddress !== undefined) {
    recipients.push('to_id = ?');
    params.push(sessionAddress);
  }
  where.push(`(${recipients.join(' OR ')})`);
  where.push('deleted_at IS NULL');

  if (!isMailboxLeader(forAgentId)) {
    where.push("COALESCE(json_extract(data, '$.audience'), 'all') <> 'leaders'");
  }

  where.push(`NOT EXISTS (
      SELECT 1 FROM message_receipts AS read_receipt
      WHERE read_receipt.message_id = messages.id
        AND read_receipt.actor_id = ?
        AND read_receipt.read_at IS NOT NULL
    )`);
  params.push(forAgentId);
  where.push(`NOT EXISTS (
      SELECT 1 FROM json_each(
        CASE WHEN json_type(data, '$.readBy') = 'object'
             THEN json_extract(data, '$.readBy')
             ELSE NULL
        END
      ) AS legacy_read
      WHERE legacy_read.key = ?
    )`);
  params.push(forAgentId);

  where.push('legacy_global_completion = 0');
  where.push(`NOT EXISTS (
      SELECT 1 FROM message_receipts AS completed_receipt
      WHERE completed_receipt.message_id = messages.id
        AND completed_receipt.actor_id = ?
        AND completed_receipt.completed_at IS NOT NULL
    )`);
  params.push(forAgentId);
  where.push(`(
      completed = 0 OR EXISTS (
        SELECT 1 FROM message_receipts AS any_receipt
        WHERE any_receipt.message_id = messages.id
      )
    )`);

  // No reader-session context → nothing to filter against: keep the pure SQL
  // COUNT (e.g. the generic HTTP unread-count endpoint).
  if (sessionId === undefined && ctx === undefined) {
    const row = host
      .stmt(`SELECT COUNT(*) AS total FROM messages WHERE ${where.join(' AND ')}`)
      .get(...params) as { total?: number } | undefined;
    return Number(row?.total ?? 0);
  }
  // Reader session (or affinity ctx) supplied: count only messages that pass
  // the same session-affinity predicate the inbox checker applies, so the
  // badge agrees with the messages the inbox actually shows. Fail-closed —
  // a message whose affinity token targets a different session (or is
  // malformed / unresolvable without allowUnscoped) is not counted.
  const rows = host
    .stmt(`SELECT id, data, legacy_global_completion FROM messages WHERE ${where.join(' AND ')}`)
    .all(...params) as unknown as MessageRow[];
  let total = 0;
  for (const message of host.materializeMessageRows(rows)) {
    if (await acceptMailboxMessageForSession(message, sessionId, ctx)) total += 1;
  }
  return total;
}
