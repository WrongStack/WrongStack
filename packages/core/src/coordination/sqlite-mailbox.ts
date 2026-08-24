import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { EventBus } from '../kernel/events.js';
import { isMessageCompletedForActor } from './global-mailbox-completion.js';
import {
  AGENT_STALE_MS,
  AUTO_COMPACT_INTERVAL_MS,
  CLIENT_STALE_MS,
  HEARTBEAT_THROTTLE_MS,
} from './mailbox-constants.js';
import type {
  CredentialValidation,
  IssueCredentialOptions,
  MailboxCredential,
} from './mailbox-credential-store.js';
import type { MailboxEventEmitter } from './mailbox-events.js';
import { normalizeMailboxMessageType } from './mailbox-message-codec.js';
import { isFanOutRecipient } from './mailbox-receipt-folding.js';
import { projectMailboxCompletion } from './mailbox-retention-state.js';
import {
  mapRegisteredAgentsToStatuses,
  mapRegisteredClientsToStatuses,
} from './mailbox-status-mappers.js';
import type {
  AgentHeartbeatInput,
  AgentRegistrationInput,
  AutoCompactOptions,
  AutoCompactResult,
  ClientHeartbeatInput,
  ClientRegistrationInput,
  ClientStatus,
  Mailbox,
  MailboxAckBatchInput,
  MailboxAckInput,
  MailboxAgentStatus,
  MailboxMessage,
  MailboxMessageProjection,
  MailboxQuery,
  MailboxRecipientState,
  MailboxSendInput,
  PurgeOptions,
  PurgeResult,
  RegisteredAgent,
  RegisteredClient,
} from './mailbox-types.js';
import {
  acceptMailboxMessageForSession,
  isMailboxLeader,
  isMailboxMessageVisibleTo,
  normalizeRecipient,
  sessionRecipient,
  validateSendType,
  type MailboxSessionAffinityContext,
} from './mailbox-types.js';
import { autoCompact, type CompactionContext, purgeStale } from './sqlite-mailbox-compaction.js';
import {
  credentialGet,
  credentialIssue,
  credentialList,
  credentialRevoke,
  credentialRotate,
  credentialStatusCounts,
  credentialVerify,
} from './sqlite-mailbox-credentials.js';
import {
  deleteMessages,
  type MessageRow,
  materializeMessageRows,
  persistAgent,
  persistClient,
  persistMessage,
  persistReceipt,
  pruneAgents,
  pruneClients,
  readAgents,
  readClients,
  type SqliteStatement,
  withoutAggregateCompletion,
} from './sqlite-mailbox-rows.js';
import {
  initializeSchema,
  loadDatabaseSync,
  migrateLegacyFiles,
  type SchemaContext,
} from './sqlite-mailbox-schema.js';
export const SQLITE_MAILBOX_FILE = '_mailbox.sqlite';
/**
 * Server-owned project mailbox persistence.
 *
 * Production callers must reach this store through RemoteMailbox. The detached
 * project server is the only process that opens the database connection.
 */
/**
 * Bounds for the in-memory heartbeat throttle maps. The sweep only runs once a
 * map is over the entry cap, so the steady state costs nothing.
 */
const HEARTBEAT_TRACKING_MAX_ENTRIES = 512;
const HEARTBEAT_TRACKING_TTL_MS = 30 * 60_000;

export class SqliteMailbox implements Mailbox {
  readonly databasePath: string;
  /** Compatibility alias used by project-server health/status consumers. */
  readonly messagePath: string;
  readonly eventEmitter?: MailboxEventEmitter | undefined;

  private readonly db: DatabaseSync;
  private readonly events?: EventBus | undefined;
  private readonly lastHeartbeat = new Map<string, number>();
  private readonly lastClientHeartbeat = new Map<string, number>();
  private autoCompactTimer: NodeJS.Timeout | null = null;
  private autoCompactInFlight: Promise<AutoCompactResult> | undefined;
  private closed = false;

  constructor(
    readonly projectDir: string,
    events?: EventBus,
    eventEmitter?: MailboxEventEmitter,
  ) {
    fs.mkdirSync(projectDir, { recursive: true });
    this.databasePath = path.join(projectDir, SQLITE_MAILBOX_FILE);
    this.messagePath = this.databasePath;
    this.events = events;
    this.eventEmitter = eventEmitter;
    const Database = loadDatabaseSync();
    this.db = new Database(this.databasePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    initializeSchema(this.schemaCtx());
    migrateLegacyFiles(this.schemaCtx());
  }

  private stmt(sql: string): SqliteStatement {
    return this.db.prepare(sql);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Bundle of store state the schema/migration module operates on. */
  private schemaCtx(): SchemaContext {
    return {
      db: this.db,
      projectDir: this.projectDir,
      transaction: (run) => this.transaction(run),
    };
  }

  private persistMessage(message: MailboxMessage, legacyGlobalCompletion = false): void {
    persistMessage(this.db, message, legacyGlobalCompletion);
  }

  private persistReceipt(messageId: string, state: MailboxRecipientState): void {
    persistReceipt(this.db, messageId, state);
  }

  private materializeMessageRows(rows: readonly MessageRow[]): MailboxMessageProjection[] {
    return materializeMessageRows(this.db, rows);
  }

  private readMessages(): MailboxMessageProjection[] {
    const rows = this.stmt(
      'SELECT id, data, legacy_global_completion FROM messages',
    ).all() as unknown as MessageRow[];
    return this.materializeMessageRows(rows);
  }

  private findMessage(messageId: string): MailboxMessageProjection | undefined {
    const row = this.stmt(
      'SELECT id, data, legacy_global_completion FROM messages WHERE id = ?',
    ).get(messageId) as MessageRow | undefined;
    return row === undefined ? undefined : this.materializeMessageRows([row])[0];
  }

  async send(input: MailboxSendInput): Promise<MailboxMessage> {
    return this.sendMessage(input, false);
  }

  async sendRuntimeControl(
    input: Omit<MailboxSendInput, 'type'> & { type?: 'control' },
  ): Promise<MailboxMessage> {
    return this.sendMessage({ ...input, type: 'control' }, true);
  }

  private async sendMessage(
    input: MailboxSendInput,
    allowRuntimeControl: boolean,
  ): Promise<MailboxMessage> {
    const type = normalizeMailboxMessageType(input.type);
    const to = normalizeRecipient(input.to, input.senderSessionId);
    if (!(allowRuntimeControl && type === 'control')) validateSendType(type, to);
    const timestamp = new Date().toISOString();
    const message: MailboxMessage = {
      id: randomUUID(),
      from: input.from,
      to,
      type,
      ...(input.audience !== undefined && input.audience !== 'all'
        ? { audience: input.audience }
        : {}),
      subject: input.subject,
      body: input.body,
      priority: input.priority ?? 'normal',
      readBy: {},
      completed: false,
      timestamp,
      ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
      ...(input.taskContext !== undefined ? { taskContext: input.taskContext } : {}),
      ...(input.senderSessionId !== undefined ? { senderSessionId: input.senderSessionId } : {}),
      ...(input.sessionAffinity !== undefined ? { sessionAffinity: input.sessionAffinity } : {}),
      ...(input.ttlMs !== undefined
        ? { expiresAt: new Date(Date.now() + input.ttlMs).toISOString() }
        : {}),
    };
    this.persistMessage(message);
    this.events?.emitCustom('mailbox.message_sent', {
      messageId: message.id,
      from: message.from,
      to: message.to,
      type: message.type,
      subject: message.subject,
    });
    this.eventEmitter?.emit({
      type: 'message.sent',
      messageId: message.id,
      from: message.from,
      to: message.to,
      audience: message.audience,
      timestamp,
    });
    return message;
  }

  async query(query: MailboxQuery): Promise<MailboxMessage[]> {
    const type = query.type === undefined ? undefined : normalizeMailboxMessageType(query.type);
    const priorityRank = { low: 0, normal: 1, high: 2 } as const;
    const minimumRank = query.minPriority === undefined ? 0 : priorityRank[query.minPriority];
    // An explicit empty id set matches nothing — and `IN ()` is not valid
    // SQL, so this has to short-circuit before the statement is built.
    if (query.ids !== undefined && query.ids.length === 0) return [];
    const statuses = query.unreadBy === undefined ? await this.getAgentStatuses() : undefined;
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
    if (query.since !== undefined) {
      where.push('timestamp > ?');
      params.push(query.since);
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
          SELECT 1 FROM json_each(json_extract(data, '$.readBy')) AS legacy_read
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
    const canPreLimit = !query.incompleteOnly || query.unreadBy !== undefined;
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
      params.push(query.limit ?? 50);
    }
    const rows = this.stmt(sql).all(...params) as unknown as MessageRow[];
    const idFilter = query.ids === undefined ? undefined : new Set(query.ids);
    const filtered = this.materializeMessageRows(rows).filter((message) => {
      if (idFilter !== undefined && !idFilter.has(message.id)) return false;
      if (query.to !== undefined && message.to !== query.to && message.to !== '*') return false;
      if (query.from !== undefined && message.from !== query.from) return false;
      if (query.sessionId !== undefined && message.senderSessionId !== query.sessionId)
        return false;
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
      if (query.since !== undefined && message.timestamp <= query.since) return false;
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
    return messages.slice(0, query.limit ?? 50).map((message) => {
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

  async ack(input: MailboxAckInput): Promise<MailboxMessage | null> {
    const results = await this.ackMany({ acks: [input] });
    return results[0] ?? null;
  }

  async ackMany(input: MailboxAckBatchInput): Promise<MailboxMessage[]> {
    if (input.acks.length === 0) return [];
    const timestamp = new Date().toISOString();
    const changed = new Set<string>();
    const updated = this.transaction(() => {
      const results: MailboxMessage[] = [];
      for (const ack of input.acks) {
        const message = this.findMessage(ack.messageId);
        if (message === undefined) continue;
        const current = message.recipientState[ack.readerId] ?? { actorId: ack.readerId };
        const state: MailboxRecipientState = { ...current };
        let didChange = false;

        if (ack.read !== false && state.readAt === undefined) {
          state.readAt = timestamp;
          message.readBy[ack.readerId] = timestamp;
          didChange = true;
        }
        if (
          ack.completed === true &&
          state.completedAt === undefined &&
          message.legacyGlobalCompletion !== true
        ) {
          state.completedAt = timestamp;
          state.completedBy = ack.readerId;
          didChange = true;
        }
        if (ack.read === false && ack.completed === false && state.completedAt !== undefined) {
          delete state.completedAt;
          delete state.completedBy;
          didChange = true;
        }
        if (ack.outcome !== undefined && state.outcome !== ack.outcome) {
          state.outcome = ack.outcome;
          didChange = true;
        }

        message.recipientState = {
          ...message.recipientState,
          [ack.readerId]: state,
        };
        const actorCompleted = state.completedAt !== undefined;
        message.completed = message.legacyGlobalCompletion === true || actorCompleted;
        if (actorCompleted) {
          message.completedBy = state.completedBy ?? ack.readerId;
          message.completedAt = state.completedAt;
        } else if (message.legacyGlobalCompletion !== true) {
          delete message.completedBy;
          delete message.completedAt;
        }
        message.outcome = state.outcome;

        if (didChange) {
          this.persistReceipt(message.id, state);
          // Aggregate completion is STORED only for a message with a single
          // addressee. One actor finishing a fan-out (`*`, `@session:`, a bare
          // role alias) must not mark it done for everyone else — that is what
          // the per-actor receipt model exists to prevent, and
          // `legacyGlobalCompletion` marks the historical v1 messages that
          // predate it. The value returned to the caller below still reports
          // that actor's own completion.
          this.persistMessage(
            isFanOutRecipient(message.to) ? withoutAggregateCompletion(message) : message,
            message.legacyGlobalCompletion === true,
          );
          changed.add(message.id);
        }
        results.push({ ...message, readBy: { ...message.readBy } });
      }
      return results;
    });

    for (const message of updated) {
      if (!changed.has(message.id)) continue;
      this.eventEmitter?.emit({
        type: 'message.acked',
        messageId: message.id,
        from: message.from,
        to: message.to,
        audience: message.audience,
        timestamp,
      });
    }
    return updated;
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
  async unreadCount(
    forAgentId: string,
    sessionId?: string,
    ctx?: MailboxSessionAffinityContext,
  ): Promise<number> {
    const sessionAddress = sessionId === undefined ? undefined : sessionRecipient(sessionId);
    const where: string[] = [];
    const params: string[] = [];

    const recipients = ["to_id = ?", "to_id = '*'"];
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
      SELECT 1 FROM json_each(json_extract(data, '$.readBy')) AS legacy_read
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
      const row = this.stmt(
        `SELECT COUNT(*) AS total FROM messages WHERE ${where.join(' AND ')}`,
      ).get(...params) as { total?: number } | undefined;
      return Number(row?.total ?? 0);
    }
    // Reader session (or affinity ctx) supplied: count only messages that pass
    // the same session-affinity predicate the inbox checker applies, so the
    // badge agrees with the messages the inbox actually shows. Fail-closed —
    // a message whose affinity token targets a different session (or is
    // malformed / unresolvable without allowUnscoped) is not counted.
    const rows = this.stmt(
      `SELECT id, data, legacy_global_completion FROM messages WHERE ${where.join(' AND ')}`,
    ).all(...params) as unknown as MessageRow[];
    let total = 0;
    for (const message of this.materializeMessageRows(rows)) {
      if (await acceptMailboxMessageForSession(message, sessionId, ctx)) total += 1;
    }
    return total;
  }

  async softDelete(mailId: string, by: string): Promise<MailboxMessage | null> {
    const message = this.findMessage(mailId);
    if (message === undefined) return null;
    if (message.deletedAt !== undefined) return { ...message, readBy: { ...message.readBy } };
    const timestamp = new Date().toISOString();
    message.deletedAt = timestamp;
    message.deletedBy = by;
    const previousState = message.recipientState[by] ?? { actorId: by };
    const state = {
      ...previousState,
      readAt: previousState.readAt ?? timestamp,
    };
    message.readBy[by] = state.readAt;
    message.recipientState = { ...message.recipientState, [by]: state };
    this.transaction(() => {
      this.persistReceipt(message.id, state);
      this.persistMessage(message, message.legacyGlobalCompletion === true);
    });
    this.eventEmitter?.emit({
      type: 'message.deleted',
      messageId: message.id,
      from: message.from,
      to: message.to,
      audience: message.audience,
      timestamp,
    });
    return { ...message, readBy: { ...message.readBy } };
  }

  async restore(mailId: string): Promise<MailboxMessage | null> {
    const message = this.findMessage(mailId);
    if (message === undefined) return null;
    if (message.deletedAt === undefined && message.deletedBy === undefined) {
      return { ...message, readBy: { ...message.readBy } };
    }
    delete message.deletedAt;
    delete message.deletedBy;
    this.persistMessage(message, message.legacyGlobalCompletion === true);
    const timestamp = new Date().toISOString();
    this.eventEmitter?.emit({
      type: 'message.restored',
      messageId: message.id,
      from: message.from,
      to: message.to,
      audience: message.audience,
      timestamp,
    });
    return { ...message, readBy: { ...message.readBy } };
  }

  private persistAgent(agent: RegisteredAgent): void {
    persistAgent(this.db, agent);
  }

  private readAgents(): Map<string, RegisteredAgent> {
    return readAgents(this.db);
  }

  private pruneAgents(maxAgeMs = AGENT_STALE_MS): number {
    return pruneAgents(this.db, maxAgeMs);
  }

  async registerAgent(input: AgentRegistrationInput): Promise<void> {
    this.pruneAgents();
    const now = new Date().toISOString();
    this.persistAgent({
      agentId: input.agentId,
      sessionId: input.sessionId,
      name: input.name,
      ...(input.role !== undefined ? { role: input.role } : {}),
      status: 'idle',
      iterations: 0,
      toolCalls: 0,
      registeredAt: now,
      lastSeenAt: now,
      pid: input.pid ?? process.pid,
      ...(input.source !== undefined ? { source: input.source } : {}),
    });
    this.events?.emitCustom('mailbox.agent_registered', {
      agentId: input.agentId,
      sessionId: input.sessionId,
      name: input.name,
      role: input.role,
      source: input.source,
    });
  }

  /**
   * Throttle bookkeeping only: `agentId`/`clientId` -> last accepted heartbeat.
   *
   * Entries are deleted on a clean deregister, but a crashed or forcibly killed
   * peer never deregisters, so over a long-lived daemon's life these maps grew
   * with every distinct id ever seen. Dropping a stale entry is free: the next
   * heartbeat from that id simply is not throttled and writes once more.
   */
  private pruneHeartbeats(map: Map<string, number>, nowMs: number): void {
    for (const [id, at] of map) {
      if (nowMs - at > HEARTBEAT_TRACKING_TTL_MS) map.delete(id);
    }
    while (map.size > HEARTBEAT_TRACKING_MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  async deregisterAgent(agentId: string): Promise<void> {
    this.stmt('DELETE FROM agents WHERE agent_id = ?').run(agentId);
    this.lastHeartbeat.delete(agentId);
    this.events?.emitCustom('mailbox.agent_deregistered', { agentId });
  }

  async heartbeat(input: AgentHeartbeatInput): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - (this.lastHeartbeat.get(input.agentId) ?? 0) < HEARTBEAT_THROTTLE_MS) return;
    this.lastHeartbeat.set(input.agentId, nowMs);
    this.pruneHeartbeats(this.lastHeartbeat, nowMs);
    this.pruneAgents();
    const agent = this.readAgents().get(input.agentId);
    if (agent !== undefined) {
      agent.lastSeenAt = new Date(nowMs).toISOString();
      if (input.status !== undefined) agent.status = input.status;
      if (input.currentTool !== undefined) agent.currentTool = input.currentTool;
      if (input.currentTask !== undefined) agent.currentTask = input.currentTask;
      if (input.iterations !== undefined) agent.iterations = input.iterations;
      if (input.toolCalls !== undefined) agent.toolCalls = input.toolCalls;
      this.persistAgent(agent);
    }
    this.events?.emitCustom('mailbox.agent_heartbeat', {
      agentId: input.agentId,
      status: input.status,
      currentTool: input.currentTool,
      currentTask: input.currentTask,
    });
  }

  async getAgentStatuses(): Promise<MailboxAgentStatus[]> {
    this.pruneAgents();
    return mapRegisteredAgentsToStatuses(this.readAgents(), Date.now(), AGENT_STALE_MS);
  }

  async purgeAgents(maxAgeMs = AGENT_STALE_MS): Promise<number> {
    return this.pruneAgents(maxAgeMs);
  }

  async getOnlineAgents(): Promise<MailboxAgentStatus[]> {
    return (await this.getAgentStatuses()).filter((agent) => agent.online);
  }

  private persistClient(client: RegisteredClient): void {
    persistClient(this.db, client);
  }

  private readClients(): Map<string, RegisteredClient> {
    return readClients(this.db);
  }

  private pruneClientsInPlace(): number {
    return pruneClients(this.db);
  }

  async registerClient(input: ClientRegistrationInput): Promise<void> {
    this.pruneClientsInPlace();
    const now = new Date().toISOString();
    this.persistClient({
      clientId: input.clientId,
      sessionId: input.sessionId,
      name: input.name,
      source: input.source,
      registeredAt: now,
      lastSeenAt: now,
      pid: input.pid ?? process.pid,
    });
    this.events?.emitCustom('mailbox.client_registered', {
      clientId: input.clientId,
      sessionId: input.sessionId,
      name: input.name,
      source: input.source,
    });
  }

  async deregisterClient(clientId: string): Promise<void> {
    this.stmt('DELETE FROM clients WHERE client_id = ?').run(clientId);
    this.lastClientHeartbeat.delete(clientId);
    this.events?.emitCustom('mailbox.client_deregistered', { clientId });
  }

  async clientHeartbeat(input: ClientHeartbeatInput): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - (this.lastClientHeartbeat.get(input.clientId) ?? 0) < HEARTBEAT_THROTTLE_MS) return;
    this.lastClientHeartbeat.set(input.clientId, nowMs);
    this.pruneHeartbeats(this.lastClientHeartbeat, nowMs);
    this.pruneClientsInPlace();
    const client = this.readClients().get(input.clientId);
    if (client !== undefined) {
      client.lastSeenAt = new Date(nowMs).toISOString();
      if (input.sessionId) client.sessionId = input.sessionId;
      this.persistClient(client);
    }
    this.events?.emitCustom('mailbox.client_heartbeat', {
      clientId: input.clientId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
  }

  async getClientStatuses(): Promise<ClientStatus[]> {
    this.pruneClientsInPlace();
    return mapRegisteredClientsToStatuses(this.readClients(), Date.now(), CLIENT_STALE_MS);
  }

  async purgeClients(): Promise<number> {
    return this.pruneClientsInPlace();
  }

  async clearAll(): Promise<void> {
    this.stmt('DELETE FROM messages').run();
  }

  async purgeStale(options?: PurgeOptions): Promise<PurgeResult> {
    return purgeStale(this.compactionCtx(), options);
  }

  async autoCompact(options?: AutoCompactOptions): Promise<AutoCompactResult> {
    if (this.autoCompactInFlight !== undefined) return this.autoCompactInFlight;
    const inFlight = autoCompact(this.compactionCtx(), options);
    this.autoCompactInFlight = inFlight;
    try {
      return await inFlight;
    } finally {
      if (this.autoCompactInFlight === inFlight) this.autoCompactInFlight = undefined;
    }
  }

  /** Bundle of store operations the retention sweeps drive. */
  private compactionCtx(): CompactionContext {
    return {
      getAgentStatuses: () => this.getAgentStatuses(),
      readMessages: () => this.readMessages(),
      deleteMessages: (ids) => this.deleteMessages(ids),
    };
  }

  private deleteMessages(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.transaction(() => deleteMessages(this.db, ids));
  }

  credentialGet(credentialId: string): MailboxCredential | null {
    return credentialGet(this.db, credentialId);
  }

  credentialList(): MailboxCredential[] {
    return credentialList(this.db);
  }

  credentialStatusCounts(): Record<string, number> {
    return credentialStatusCounts(this.db);
  }

  credentialIssue(options: IssueCredentialOptions): {
    credential: MailboxCredential;
    secret: string;
  } {
    return credentialIssue(this.db, (run) => this.transaction(run), options);
  }

  credentialVerify(credentialId: string, secret: string): CredentialValidation {
    return credentialVerify(this.db, credentialId, secret);
  }

  credentialRevoke(credentialId: string, reason?: string, by?: string): boolean {
    return credentialRevoke(this.db, credentialId, reason, by);
  }

  credentialRotate(
    credentialId: string,
    options?: Partial<IssueCredentialOptions>,
  ): { credential: MailboxCredential; secret: string } | null {
    return credentialRotate(this.db, (run) => this.transaction(run), credentialId, options);
  }

  startAutoCompactTimer(options?: AutoCompactOptions): () => void {
    if (this.autoCompactTimer !== null) clearInterval(this.autoCompactTimer);
    const timer = setInterval(() => {
      void this.autoCompact(options).catch(() => {});
    }, options?.intervalMs ?? AUTO_COMPACT_INTERVAL_MS);
    timer.unref?.();
    this.autoCompactTimer = timer;
    return () => {
      clearInterval(timer);
      if (this.autoCompactTimer === timer) this.autoCompactTimer = null;
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.autoCompactTimer !== null) clearInterval(this.autoCompactTimer);
    this.autoCompactTimer = null;
    this.db.close();
  }
}
