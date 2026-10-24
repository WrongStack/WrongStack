import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
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
import { applyAckToMessage, isFanOutRecipient } from './mailbox-receipt-folding.js';
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
  type MailboxSessionAffinityContext,
  normalizeRecipient,
  validateSendType,
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
  query as delegateQuery,
  unreadCount as delegateUnreadCount,
  type SqliteMailboxQueryHost,
} from './sqlite-mailbox-query.js';
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

  private transactionDepth = 0;

  private transaction<T>(run: () => T): T {
    if (this.transactionDepth > 0) {
      const savepoint = `sp_${this.transactionDepth++}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = run();
        this.db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        try {
          this.db.exec(`ROLLBACK TO ${savepoint}`);
          this.db.exec(`RELEASE ${savepoint}`);
        } catch {
          // Suppress rollback failures if the transaction was already aborted
        }
        throw error;
      } finally {
        this.transactionDepth--;
      }
    }

    this.transactionDepth++;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Suppress rollback failures if the transaction was already aborted
      }
      throw error;
    } finally {
      this.transactionDepth--;
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
    this.emitMessageEvent('message.sent', message, timestamp);
    return message;
  }

  async query(query: MailboxQuery): Promise<MailboxMessage[]> {
    return delegateQuery(this.sqliteMailboxQueryHost(), query);
  }

  /**
   * Persist a message after a receipt change. Aggregate completion is STORED
   * only for a message with a single addressee. One actor finishing a fan-out
   * (`*`, `@session:`, a bare role alias) must not mark it done for everyone
   * else — that is what the per-actor receipt model exists to prevent, and
   * `legacyGlobalCompletion` marks the historical v1 messages that predate it.
   */
  private persistMessageView(message: MailboxMessageProjection): void {
    this.persistMessage(
      isFanOutRecipient(message.to) ? withoutAggregateCompletion(message) : message,
      message.legacyGlobalCompletion === true,
    );
  }

  private emitMessageEvent(
    type: 'message.sent' | 'message.acked' | 'message.deleted' | 'message.restored',
    message: MailboxMessage,
    timestamp: string,
  ): void {
    this.eventEmitter?.emit({
      type,
      messageId: message.id,
      from: message.from,
      to: message.to,
      audience: message.audience,
      timestamp,
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
        const { state, didChange } = applyAckToMessage(message, ack, timestamp);

        if (didChange) {
          this.persistReceipt(message.id, state);
          // The value returned below still reports this actor's own completion.
          this.persistMessageView(message);
          changed.add(message.id);
        }
        results.push({ ...message, readBy: { ...message.readBy } });
      }
      return results;
    });

    for (const message of updated) {
      if (!changed.has(message.id)) continue;
      this.emitMessageEvent('message.acked', message, timestamp);
    }
    return updated;
  }

  /** Unread-and-incomplete count for an actor — see `unreadCount` in sqlite-mailbox-query. */
  async unreadCount(
    forAgentId: string,
    sessionId?: string,
    ctx?: MailboxSessionAffinityContext,
  ): Promise<number> {
    return delegateUnreadCount(this.sqliteMailboxQueryHost(), forAgentId, sessionId, ctx);
  }

  async softDelete(mailId: string, by: string): Promise<MailboxMessage | null> {
    const timestamp = new Date().toISOString();
    let alreadyDeleted = false;
    const message = this.transaction(() => {
      const found = this.findMessage(mailId);
      if (found === undefined) return undefined;
      if (found.deletedAt !== undefined) {
        alreadyDeleted = true;
        return found;
      }
      found.deletedAt = timestamp;
      found.deletedBy = by;
      const previousState = found.recipientState[by] ?? { actorId: by };
      const state = {
        ...previousState,
        readAt: previousState.readAt ?? timestamp,
      };
      found.readBy[by] = state.readAt;
      found.recipientState = { ...found.recipientState, [by]: state };
      this.persistReceipt(found.id, state);
      this.persistMessageView(found);
      return found;
    });
    if (message === undefined) return null;
    if (alreadyDeleted) return { ...message, readBy: { ...message.readBy } };
    this.emitMessageEvent('message.deleted', message, timestamp);
    return { ...message, readBy: { ...message.readBy } };
  }

  async restore(mailId: string): Promise<MailboxMessage | null> {
    let wasNotDeleted = false;
    const message = this.transaction(() => {
      const found = this.findMessage(mailId);
      if (found === undefined) return undefined;
      if (found.deletedAt === undefined && found.deletedBy === undefined) {
        wasNotDeleted = true;
        return found;
      }
      delete found.deletedAt;
      delete found.deletedBy;
      this.persistMessageView(found);
      return found;
    });
    if (message === undefined) return null;
    if (wasNotDeleted) return { ...message, readBy: { ...message.readBy } };
    const timestamp = new Date().toISOString();
    this.emitMessageEvent('message.restored', message, timestamp);
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
    } else if (input.sessionId !== undefined && input.name !== undefined) {
      // The row is gone but the agent is demonstrably alive — it is heartbeating
      // right now. Rows are deleted once stale (AGENT_STALE_MS) by this method's
      // own prune above, by registerAgent, or by ANY observer calling
      // getAgentStatuses(). Without this branch the agent stays invisible for
      // the rest of its life: it never calls registerAgent again, so nothing
      // would ever recreate the row.
      //
      // Requires identity from the caller; heartbeats that omit sessionId/name
      // cannot rebuild a truthful row, and inventing one would report a wrong
      // name/pid to HQ. Those callers keep the old refresh-only behavior.
      const nowIso = new Date(nowMs).toISOString();
      this.persistAgent({
        agentId: input.agentId,
        sessionId: input.sessionId,
        name: input.name,
        ...(input.role !== undefined ? { role: input.role } : {}),
        status: input.status ?? 'idle',
        ...(input.currentTool !== undefined ? { currentTool: input.currentTool } : {}),
        ...(input.currentTask !== undefined ? { currentTask: input.currentTask } : {}),
        iterations: input.iterations ?? 0,
        toolCalls: input.toolCalls ?? 0,
        registeredAt: nowIso,
        lastSeenAt: nowIso,
        pid: input.pid ?? process.pid,
        ...(input.source !== undefined ? { source: input.source } : {}),
      });
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
    return this.transaction(() => credentialRevoke(this.db, credentialId, reason, by));
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

  private sqliteMailboxQueryHost(): SqliteMailboxQueryHost {
    return {
      getAgentStatuses: (...args) => this.getAgentStatuses(...args),
      stmt: (...args) => this.stmt(...args),
      materializeMessageRows: (...args) => this.materializeMessageRows(...args),
    };
  }
}
