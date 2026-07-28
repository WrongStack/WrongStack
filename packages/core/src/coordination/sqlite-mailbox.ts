import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { EventBus } from '../kernel/events.js';
import { withSqliteExperimentalWarningSuppressed } from '../utils/sqlite-warning.js';
import {
  AGENT_STALE_MS,
  AUTO_COMPACT_DEFAULT_TTL_MS,
  AUTO_COMPACT_INTERVAL_MS,
  AUTO_COMPACT_READ_MAX_AGE_MS,
  AUTO_COMPACT_TYPE_TTL_MS,
  CLIENT_STALE_MS,
  HEARTBEAT_THROTTLE_MS,
} from './mailbox-constants.js';
import {
  CREDENTIAL_STORE_FILE,
  createMailboxCredential,
  type CredentialValidation,
  type IssueCredentialOptions,
  MAX_CREDENTIAL_TTL,
  type MailboxCredential,
  ROTATION_OVERLAP_MS,
  verifyMailboxCredential,
} from './mailbox-credential-store.js';
import type { MailboxEventEmitter } from './mailbox-events.js';
import {
  GLOBAL_MAILBOX_CLIENT_REGISTRY_FILE,
  GLOBAL_MAILBOX_FILE,
} from './global-mailbox-paths.js';
import { isMessageCompletedForActor } from './global-mailbox-completion.js';
import { parseMailboxFile } from './mailbox-parse-state.js';
import { parseAgentRegistryEntry, parseClientRegistryEntry } from './mailbox-registry-codec.js';
import {
  projectMailboxCompletion,
  resolveMailboxRetentionState,
} from './mailbox-retention-state.js';
import { mapRegisteredAgentsToStatuses, mapRegisteredClientsToStatuses } from './mailbox-status-mappers.js';
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
  isMailboxMessageVisibleTo,
  normalizeRecipient,
  sessionRecipient,
  validateSendType,
} from './mailbox-types.js';
import { normalizeMailboxMessageType } from './mailbox-message-codec.js';

export const SQLITE_MAILBOX_FILE = '_mailbox.sqlite';
const SQLITE_MAILBOX_SCHEMA_VERSION = 2;

let DatabaseSyncCtor: typeof DatabaseSync | undefined;

function loadDatabaseSync(): typeof DatabaseSync {
  if (DatabaseSyncCtor) return DatabaseSyncCtor;
  return withSqliteExperimentalWarningSuppressed(() => {
    const require = createRequire(import.meta.url);
    DatabaseSyncCtor = (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
    return DatabaseSyncCtor;
  });
}

type SqliteStatement = ReturnType<DatabaseSync['prepare']>;

interface MessageRow {
  id: string;
  data: string;
  legacy_global_completion: number;
}

interface ReceiptRow {
  message_id: string;
  actor_id: string;
  read_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  outcome: string | null;
}

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
    this.initializeSchema();
    this.migrateLegacyFiles();
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

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mailbox_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        priority TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT,
        deleted_at TEXT,
        sender_session_id TEXT,
        reply_to TEXT,
        expires_at TEXT,
        legacy_global_completion INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS message_receipts (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL,
        read_at TEXT,
        completed_at TEXT,
        completed_by TEXT,
        outcome TEXT,
        PRIMARY KEY (message_id, actor_id)
      );
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT,
        status TEXT NOT NULL,
        current_tool TEXT,
        current_task TEXT,
        iterations INTEGER NOT NULL,
        tool_calls INTEGER NOT NULL,
        registered_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        pid INTEGER NOT NULL,
        source TEXT
      );
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        pid INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credentials (
        credential_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_to_timestamp ON messages(to_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_from_timestamp ON messages(from_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_type_timestamp ON messages(type, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_deleted_at ON messages(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON messages(sender_session_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_reply_timestamp ON messages(reply_to, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_receipts_actor ON message_receipts(actor_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_clients_last_seen ON clients(last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_credentials_status ON credentials(status, expires_at);
    `);
    this.stmt(
      'INSERT INTO mailbox_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
    ).run('schema_version', String(SQLITE_MAILBOX_SCHEMA_VERSION));
    const schema = this.stmt('SELECT value FROM mailbox_meta WHERE key = ?').get(
      'schema_version',
    ) as { value: string } | undefined;
    const foundVersion = Number(schema?.value);
    if (
      !Number.isInteger(foundVersion) ||
      foundVersion < 1 ||
      foundVersion > SQLITE_MAILBOX_SCHEMA_VERSION
    ) {
      throw new Error(
        `Unsupported mailbox SQLite schema ${schema?.value ?? 'missing'}; this build supports ${SQLITE_MAILBOX_SCHEMA_VERSION}`,
      );
    }
    if (foundVersion < SQLITE_MAILBOX_SCHEMA_VERSION) {
      this.stmt('UPDATE mailbox_meta SET value = ? WHERE key = ?').run(
        String(SQLITE_MAILBOX_SCHEMA_VERSION),
        'schema_version',
      );
    }
    this.migrateLegacyCredentials();
  }

  private migrateLegacyCredentials(): void {
    const marker = this.stmt('SELECT value FROM mailbox_meta WHERE key = ?').get(
      'legacy_credentials_imported',
    ) as { value: string } | undefined;
    if (marker !== undefined) return;
    const legacyPath = path.join(this.projectDir, CREDENTIAL_STORE_FILE);
    const credentials: MailboxCredential[] = [];
    try {
      for (const line of fs.readFileSync(legacyPath, 'utf8').split(/\r?\n/u)) {
        if (!line.trim()) continue;
        try {
          const credential = JSON.parse(line) as MailboxCredential;
          if (
            typeof credential.credentialId === 'string' &&
            typeof credential.verifier === 'string' &&
            typeof credential.principalId === 'string'
          ) credentials.push(credential);
        } catch {
          // Preserve legacy adapter behavior: malformed records are skipped.
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
    this.transaction(() => {
      for (const credential of credentials) this.persistCredential(credential);
      this.stmt('INSERT INTO mailbox_meta(key, value) VALUES (?, ?)').run(
        'legacy_credentials_imported',
        new Date().toISOString(),
      );
    });
  }

  private migrateLegacyFiles(): void {
    const marker = this.stmt('SELECT value FROM mailbox_meta WHERE key = ?').get(
      'legacy_files_imported',
    ) as { value: string } | undefined;
    if (marker !== undefined) return;

    const messages = this.readLegacyMessages();
    const agents = this.readLegacyRegistry(
      path.join(this.projectDir, '_mailbox.registry.json'),
      parseAgentRegistryEntry,
    );
    const clients = this.readLegacyRegistry(
      path.join(this.projectDir, GLOBAL_MAILBOX_CLIENT_REGISTRY_FILE),
      parseClientRegistryEntry,
    );

    this.transaction(() => {
      for (const message of messages) {
        const projection = message as MailboxMessageProjection;
        this.persistMessage(message, projection.legacyGlobalCompletion === true);
        for (const state of Object.values(projection.recipientState ?? {})) {
          this.persistReceipt(message.id, state);
        }
      }
      for (const agent of agents.values()) this.persistAgent(agent);
      for (const client of clients.values()) this.persistClient(client);
      this.stmt('INSERT INTO mailbox_meta(key, value) VALUES (?, ?)').run(
        'legacy_files_imported',
        new Date().toISOString(),
      );
    });
  }

  private readLegacyMessages(): MailboxMessage[] {
    try {
      return parseMailboxFile(fs.readFileSync(path.join(this.projectDir, GLOBAL_MAILBOX_FILE), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private readLegacyRegistry<T>(
    filePath: string,
    parseEntry: (value: unknown) => T | null,
  ): Map<string, T> {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      const result = new Map<string, T>();
      for (const [id, value] of Object.entries(raw)) {
        const parsed = parseEntry(value);
        if (parsed !== null) result.set(id, parsed);
      }
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
  }

  private persistMessage(message: MailboxMessage, legacyGlobalCompletion = false): void {
    const stored = { ...message, readBy: { ...message.readBy } } as MailboxMessageProjection;
    delete (stored as Partial<MailboxMessageProjection>).recipientState;
    delete (stored as Partial<MailboxMessageProjection>).legacyGlobalCompletion;
    this.stmt(`
      INSERT INTO messages(
        id, from_id, to_id, type, priority, timestamp, completed, completed_at,
        deleted_at, sender_session_id, reply_to, expires_at,
        legacy_global_completion, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        from_id = excluded.from_id,
        to_id = excluded.to_id,
        type = excluded.type,
        priority = excluded.priority,
        timestamp = excluded.timestamp,
        completed = excluded.completed,
        completed_at = excluded.completed_at,
        deleted_at = excluded.deleted_at,
        sender_session_id = excluded.sender_session_id,
        reply_to = excluded.reply_to,
        expires_at = excluded.expires_at,
        legacy_global_completion = excluded.legacy_global_completion,
        data = excluded.data
    `).run(
      message.id,
      message.from,
      message.to,
      message.type,
      message.priority,
      message.timestamp,
      message.completed ? 1 : 0,
      message.completedAt ?? null,
      message.deletedAt ?? null,
      message.senderSessionId ?? null,
      message.replyTo ?? null,
      message.expiresAt ?? null,
      legacyGlobalCompletion ? 1 : 0,
      JSON.stringify(stored),
    );
  }

  private persistReceipt(messageId: string, state: MailboxRecipientState): void {
    this.stmt(`
      INSERT INTO message_receipts(
        message_id, actor_id, read_at, completed_at, completed_by, outcome
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id, actor_id) DO UPDATE SET
        read_at = excluded.read_at,
        completed_at = excluded.completed_at,
        completed_by = excluded.completed_by,
        outcome = excluded.outcome
    `).run(
      messageId,
      state.actorId,
      state.readAt ?? null,
      state.completedAt ?? null,
      state.completedBy ?? null,
      state.outcome ?? null,
    );
  }

  private materializeMessageRows(rows: readonly MessageRow[]): MailboxMessageProjection[] {
    if (rows.length === 0) return [];

    const useTargetedReceipts = rows.length <= 500;
    const receiptSql = useTargetedReceipts
      ? `
        SELECT message_id, actor_id, read_at, completed_at, completed_by, outcome
        FROM message_receipts
        WHERE message_id IN (${rows.map(() => '?').join(', ')})
      `
      : `
        SELECT message_id, actor_id, read_at, completed_at, completed_by, outcome
        FROM message_receipts
      `;
    const receiptRows = this.stmt(receiptSql).all(
      ...(useTargetedReceipts ? rows.map((row) => row.id) : []),
    ) as unknown as ReceiptRow[];
    const receiptState = new Map<string, Record<string, MailboxRecipientState>>();
    for (const row of receiptRows) {
      const states = receiptState.get(row.message_id) ?? {};
      states[row.actor_id] = {
        actorId: row.actor_id,
        ...(row.read_at !== null ? { readAt: row.read_at } : {}),
        ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
        ...(row.completed_by !== null ? { completedBy: row.completed_by } : {}),
        ...(row.outcome !== null ? { outcome: row.outcome } : {}),
      };
      receiptState.set(row.message_id, states);
    }

    return rows.map((row) => {
      const base = JSON.parse(row.data) as MailboxMessage;
      const recipientState = receiptState.get(row.id) ?? {};
      const readBy = { ...base.readBy };
      for (const state of Object.values(recipientState)) {
        if (state.readAt !== undefined) readBy[state.actorId] = state.readAt;
      }
      return {
        ...base,
        readBy,
        recipientState,
        ...(row.legacy_global_completion === 1 ? { legacyGlobalCompletion: true } : {}),
      };
    });
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
    const statuses =
      query.unreadBy === undefined ? await this.getAgentStatuses() : undefined;
    const where: string[] = [];
    const params: Array<string | number> = [];
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
      where.push(`CASE priority WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END >= ?`);
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
    const canPreLimit = query.unreadBy === undefined && !query.incompleteOnly;
    let sql = 'SELECT id, data, legacy_global_completion FROM messages';
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY timestamp DESC';
    if (canPreLimit) {
      sql += ' LIMIT ?';
      params.push(query.limit ?? 50);
    }
    const rows = this.stmt(sql).all(...params) as unknown as MessageRow[];
    const messages = this.materializeMessageRows(rows).filter((message) => {
      if (query.to !== undefined && message.to !== query.to && message.to !== '*') return false;
      if (query.from !== undefined && message.from !== query.from) return false;
      if (query.sessionId !== undefined && message.senderSessionId !== query.sessionId) return false;
      if (
        query.unreadBy !== undefined &&
        !isMailboxMessageVisibleTo(message, query.unreadBy, query.readerRole)
      ) return false;
      if (
        !query.incompleteOnly &&
        query.unreadBy !== undefined &&
        query.unreadBy in message.readBy
      ) return false;
      if (
        query.incompleteOnly &&
        (query.unreadBy === undefined
          ? projectMailboxCompletion(message, undefined, statuses).completed
          : isMessageCompletedForActor(message, query.unreadBy))
      ) return false;
      if (type !== undefined && message.type !== type) return false;
      if (priorityRank[message.priority] < minimumRank) return false;
      if (query.since !== undefined && message.timestamp <= query.since) return false;
      if (!query.includeDeleted && message.deletedAt !== undefined) return false;
      if (query.replyTo !== undefined && message.replyTo !== query.replyTo) return false;
      return true;
    });
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
          this.persistMessage(message, message.legacyGlobalCompletion === true);
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

  async unreadCount(forAgentId: string, sessionId?: string): Promise<number> {
    const sessionAddress = sessionId === undefined ? undefined : sessionRecipient(sessionId);
    return this.readMessages().filter(
      (message) =>
        (message.to === forAgentId || message.to === '*' || message.to === sessionAddress) &&
        isMailboxMessageVisibleTo(message, forAgentId) &&
        !(forAgentId in message.readBy) &&
        !isMessageCompletedForActor(message, forAgentId) &&
        message.deletedAt === undefined,
    ).length;
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
    this.stmt(`
      INSERT INTO agents(
        agent_id, session_id, name, role, status, current_tool, current_task,
        iterations, tool_calls, registered_at, last_seen_at, pid, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        session_id = excluded.session_id,
        name = excluded.name,
        role = excluded.role,
        status = excluded.status,
        current_tool = excluded.current_tool,
        current_task = excluded.current_task,
        iterations = excluded.iterations,
        tool_calls = excluded.tool_calls,
        registered_at = excluded.registered_at,
        last_seen_at = excluded.last_seen_at,
        pid = excluded.pid,
        source = excluded.source
    `).run(
      agent.agentId,
      agent.sessionId,
      agent.name,
      agent.role ?? null,
      agent.status,
      agent.currentTool ?? null,
      agent.currentTask ?? null,
      agent.iterations,
      agent.toolCalls,
      agent.registeredAt,
      agent.lastSeenAt,
      agent.pid,
      agent.source ?? null,
    );
  }

  private readAgents(): Map<string, RegisteredAgent> {
    const rows = this.stmt('SELECT * FROM agents').all() as unknown as Array<Record<string, unknown>>;
    const agents = new Map<string, RegisteredAgent>();
    for (const row of rows) {
      const agent: RegisteredAgent = {
        agentId: String(row['agent_id']),
        sessionId: String(row['session_id']),
        name: String(row['name']),
        ...(row['role'] !== null ? { role: String(row['role']) } : {}),
        status: row['status'] as RegisteredAgent['status'],
        ...(row['current_tool'] !== null ? { currentTool: String(row['current_tool']) } : {}),
        ...(row['current_task'] !== null ? { currentTask: String(row['current_task']) } : {}),
        iterations: Number(row['iterations']),
        toolCalls: Number(row['tool_calls']),
        registeredAt: String(row['registered_at']),
        lastSeenAt: String(row['last_seen_at']),
        pid: Number(row['pid']),
        ...(row['source'] !== null ? { source: row['source'] as RegisteredAgent['source'] } : {}),
      };
      agents.set(agent.agentId, agent);
    }
    return agents;
  }

  private pruneAgents(maxAgeMs = AGENT_STALE_MS): number {
    const cutoff = new Date(Date.now() - Math.max(0, maxAgeMs)).toISOString();
    const result = this.stmt('DELETE FROM agents WHERE last_seen_at < ?').run(cutoff);
    return Number(result.changes);
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
    if (map.size <= HEARTBEAT_TRACKING_MAX_ENTRIES) return;
    for (const [id, at] of map) {
      if (nowMs - at > HEARTBEAT_TRACKING_TTL_MS) map.delete(id);
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
    this.stmt(`
      INSERT INTO clients(
        client_id, session_id, name, source, registered_at, last_seen_at, pid
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET
        session_id = excluded.session_id,
        name = excluded.name,
        source = excluded.source,
        registered_at = excluded.registered_at,
        last_seen_at = excluded.last_seen_at,
        pid = excluded.pid
    `).run(
      client.clientId,
      client.sessionId,
      client.name,
      client.source,
      client.registeredAt,
      client.lastSeenAt,
      client.pid,
    );
  }

  private readClients(): Map<string, RegisteredClient> {
    const rows = this.stmt('SELECT * FROM clients').all() as unknown as Array<Record<string, unknown>>;
    const clients = new Map<string, RegisteredClient>();
    for (const row of rows) {
      const client: RegisteredClient = {
        clientId: String(row['client_id']),
        sessionId: String(row['session_id']),
        name: String(row['name']),
        source: row['source'] as RegisteredClient['source'],
        registeredAt: String(row['registered_at']),
        lastSeenAt: String(row['last_seen_at']),
        pid: Number(row['pid']),
      };
      clients.set(client.clientId, client);
    }
    return clients;
  }

  private pruneClientsInPlace(): number {
    const cutoff = new Date(Date.now() - CLIENT_STALE_MS).toISOString();
    const result = this.stmt('DELETE FROM clients WHERE last_seen_at < ?').run(cutoff);
    return Number(result.changes);
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
    if (
      nowMs - (this.lastClientHeartbeat.get(input.clientId) ?? 0) <
      HEARTBEAT_THROTTLE_MS
    ) return;
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
    const completedMaxAgeMs = options?.completedMaxAgeMs ?? 86_400_000;
    const incompleteMaxAgeMs = options?.incompleteMaxAgeMs ?? 604_800_000;
    const statuses = await this.getAgentStatuses();
    const now = Date.now();
    let completedPurged = 0;
    let incompletePurged = 0;
    const ids: string[] = [];
    const messages = this.readMessages();
    for (const message of messages) {
      const retention = resolveMailboxRetentionState(message, statuses);
      const messageTime = new Date(message.timestamp).getTime();
      const completionTime = new Date(retention.completedAt ?? 0).getTime();
      if (retention.completed && completionTime < now - completedMaxAgeMs) {
        completedPurged++;
        ids.push(message.id);
      } else if (!retention.completed && messageTime < now - incompleteMaxAgeMs) {
        incompletePurged++;
        ids.push(message.id);
      }
    }
    this.deleteMessages(ids);
    return {
      completedPurged,
      incompletePurged,
      totalPurged: ids.length,
      remaining: messages.length - ids.length,
    };
  }

  async autoCompact(options?: AutoCompactOptions): Promise<AutoCompactResult> {
    const readMaxAgeMs = options?.readMaxAgeMs ?? AUTO_COMPACT_READ_MAX_AGE_MS;
    const defaultTtlMs = options?.defaultTtlMs ?? AUTO_COMPACT_DEFAULT_TTL_MS;
    const typeTtlMs = options?.typeTtlMs ?? AUTO_COMPACT_TYPE_TTL_MS;
    const completedMaxAgeMs = options?.completedMaxAgeMs ?? 86_400_000;
    const incompleteMaxAgeMs = options?.incompleteMaxAgeMs ?? 604_800_000;
    const statuses = await this.getAgentStatuses();
    const online = statuses.filter((status) => status.online);
    const now = Date.now();
    let readByAllRemoved = 0;
    let expiredRemoved = 0;
    let stalePurged = 0;
    const ids: string[] = [];
    const messages = this.readMessages();

    for (const message of messages) {
      const messageTime = new Date(message.timestamp).getTime();
      const expiry =
        message.expiresAt !== undefined
          ? new Date(message.expiresAt).getTime()
          : messageTime + (typeTtlMs[message.type] ?? defaultTtlMs);
      if (expiry < now) {
        expiredRemoved++;
        ids.push(message.id);
        continue;
      }

      const retention = resolveMailboxRetentionState(message, statuses);
      const eligible = online.filter((status) =>
        isMailboxMessageVisibleTo(message, status.agentId, status.role),
      );
      if (!retention.completed && eligible.length > 0) {
        const readByAll = eligible.every((status) => status.agentId in message.readBy);
        const latestRead = Math.max(
          ...eligible.map((status) => new Date(message.readBy[status.agentId] ?? 0).getTime()),
        );
        if (readByAll && latestRead < now - readMaxAgeMs) {
          readByAllRemoved++;
          ids.push(message.id);
          continue;
        }
      }

      const completionTime = new Date(retention.completedAt ?? 0).getTime();
      if (
        (retention.completed && completionTime < now - completedMaxAgeMs) ||
        (!retention.completed && messageTime < now - incompleteMaxAgeMs)
      ) {
        stalePurged++;
        ids.push(message.id);
      }
    }

    this.deleteMessages(ids);
    return {
      readByAllRemoved,
      expiredRemoved,
      stalePurged,
      totalRemoved: ids.length,
      remaining: messages.length - ids.length,
    };
  }

  private deleteMessages(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.transaction(() => {
      const statement = this.stmt('DELETE FROM messages WHERE id = ?');
      for (const id of ids) statement.run(id);
    });
  }

  private persistCredential(credential: MailboxCredential): void {
    this.stmt(`
      INSERT INTO credentials(credential_id, status, principal_id, expires_at, data)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(credential_id) DO UPDATE SET
        status = excluded.status,
        principal_id = excluded.principal_id,
        expires_at = excluded.expires_at,
        data = excluded.data
    `).run(
      credential.credentialId,
      credential.status,
      credential.principalId,
      credential.expiresAt,
      JSON.stringify(credential),
    );
  }

  credentialGet(credentialId: string): MailboxCredential | null {
    const row = this.stmt('SELECT data FROM credentials WHERE credential_id = ?').get(
      credentialId,
    ) as { data: string } | undefined;
    return row === undefined ? null : JSON.parse(row.data) as MailboxCredential;
  }

  credentialList(): MailboxCredential[] {
    const rows = this.stmt('SELECT data FROM credentials').all() as unknown as {
      data: string;
    }[];
    return rows
      .map((row) => JSON.parse(row.data) as MailboxCredential)
      .sort((left, right) => {
        if (left.status === 'active' && right.status !== 'active') return -1;
        if (left.status !== 'active' && right.status === 'active') return 1;
        return right.issuedAt.localeCompare(left.issuedAt);
      });
  }

  credentialStatusCounts(): Record<string, number> {
    const rows = this.stmt(
      'SELECT status, COUNT(*) AS count FROM credentials GROUP BY status',
    ).all() as unknown as { status: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  credentialIssue(
    options: IssueCredentialOptions,
  ): { credential: MailboxCredential; secret: string } {
    const now = Date.now();
    const issued = createMailboxCredential(options, now);
    this.transaction(() => {
      if (options.supersedes !== undefined) {
        const old = this.credentialGet(options.supersedes);
        if (old?.status === 'active') {
          old.status = 'rotated_out';
          old.statusChangedAt = new Date(now).toISOString();
          old.statusReason = 'superseded by rotation';
          old.rotationValidUntil = new Date(now + ROTATION_OVERLAP_MS).toISOString();
          this.persistCredential(old);
        }
      }
      this.persistCredential(issued.credential);
    });
    return issued;
  }

  credentialVerify(credentialId: string, secret: string): CredentialValidation {
    return verifyMailboxCredential(this.credentialGet(credentialId) ?? undefined, secret);
  }

  credentialRevoke(credentialId: string, reason?: string, by?: string): boolean {
    const credential = this.credentialGet(credentialId);
    if (credential === null || credential.status === 'revoked') return false;
    credential.status = 'revoked';
    credential.statusChangedAt = new Date().toISOString();
    credential.statusReason = reason ?? 'revoked';
    credential.lastModifiedBy = by;
    this.persistCredential(credential);
    return true;
  }

  credentialRotate(
    credentialId: string,
    options?: Partial<IssueCredentialOptions>,
  ): { credential: MailboxCredential; secret: string } | null {
    const old = this.credentialGet(credentialId);
    if (old === null) return null;
    return this.credentialIssue({
      principalId: old.principalId,
      projectId: old.projectId ?? options?.projectId,
      kind: old.kind,
      capabilities: options?.capabilities ?? old.capabilities,
      ttlMs: options?.ttlMs ?? MAX_CREDENTIAL_TTL[old.kind],
      supersedes: credentialId,
      issuedBy: options?.issuedBy,
    });
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
