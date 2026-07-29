/**
 * Row codecs for the SQLite mailbox — the SQL that turns domain records into
 * table rows and back.
 *
 * Split out of `sqlite-mailbox.ts`. Every function takes the open database and
 * prepares its own statement, exactly as the private methods it replaced did
 * via `this.stmt()`. No message-flow policy lives here: `send`/`query`/`ack`
 * stay in the store.
 *
 * @module coordination/sqlite-mailbox-rows
 */
import type { DatabaseSync } from 'node:sqlite';
import { AGENT_STALE_MS, CLIENT_STALE_MS } from './mailbox-constants.js';
import type { MailboxCredential } from './mailbox-credential-store.js';
import type {
  MailboxMessage,
  MailboxMessageProjection,
  MailboxRecipientState,
  RegisteredAgent,
  RegisteredClient,
} from './mailbox-types.js';

export type SqliteStatement = ReturnType<DatabaseSync['prepare']>;

export interface MessageRow {
  id: string;
  data: string;
  legacy_global_completion: number;
}

export interface ReceiptRow {
  message_id: string;
  actor_id: string;
  read_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  outcome: string | null;
}

/**
 * Predicate matching a `last_seen_at` that is not an ISO-8601 timestamp.
 *
 * A registration whose heartbeat timestamp is garbage would otherwise outlive
 * every sweep: string comparison puts `'invalid'` after any real timestamp, so
 * `last_seen_at < cutoff` never matches it and the row shows up as a
 * permanently offline agent. The JSONL registry it replaced pruned these via
 * `Number.isFinite(Date.parse(...))`.
 */
export const MALFORMED_TIMESTAMP =
  "last_seen_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'";

/**
 * Strip the message-level completion fields from a fan-out message before it
 * is stored. Per-actor state lives in `message_receipts`; the aggregate fields
 * would claim the message is done for every recipient.
 */
export function withoutAggregateCompletion(
  message: MailboxMessageProjection,
): MailboxMessageProjection {
  const stored: MailboxMessageProjection = {
    ...message,
    completed: message.legacyGlobalCompletion === true,
  };
  if (!stored.completed) {
    delete stored.completedBy;
    delete stored.completedAt;
  }
  delete stored.outcome;
  return stored;
}

// ── Messages ────────────────────────────────────────────────────────────────

export function persistMessage(
  db: DatabaseSync,
  message: MailboxMessage,
  legacyGlobalCompletion = false,
): void {
  const stored = { ...message, readBy: { ...message.readBy } } as MailboxMessageProjection;
  delete (stored as Partial<MailboxMessageProjection>).recipientState;
  delete (stored as Partial<MailboxMessageProjection>).legacyGlobalCompletion;
  db.prepare(`
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

export function persistReceipt(
  db: DatabaseSync,
  messageId: string,
  state: MailboxRecipientState,
): void {
  db.prepare(`
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

export function materializeMessageRows(
  db: DatabaseSync,
  rows: readonly MessageRow[],
): MailboxMessageProjection[] {
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
  const receiptRows = db
    .prepare(receiptSql)
    .all(...(useTargetedReceipts ? rows.map((row) => row.id) : [])) as unknown as ReceiptRow[];
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

export function deleteMessages(db: DatabaseSync, ids: readonly string[]): void {
  const statement = db.prepare('DELETE FROM messages WHERE id = ?');
  for (const id of ids) statement.run(id);
}

// ── Agents ──────────────────────────────────────────────────────────────────

export function persistAgent(db: DatabaseSync, agent: RegisteredAgent): void {
  db.prepare(`
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

export function readAgents(db: DatabaseSync): Map<string, RegisteredAgent> {
  const rows = db.prepare('SELECT * FROM agents').all() as unknown as Array<
    Record<string, unknown>
  >;
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

export function pruneAgents(db: DatabaseSync, maxAgeMs = AGENT_STALE_MS): number {
  const cutoff = new Date(Date.now() - Math.max(0, maxAgeMs)).toISOString();
  const result = db
    .prepare(`DELETE FROM agents WHERE last_seen_at < ? OR ${MALFORMED_TIMESTAMP}`)
    .run(cutoff);
  return Number(result.changes);
}

// ── Clients ─────────────────────────────────────────────────────────────────

export function persistClient(db: DatabaseSync, client: RegisteredClient): void {
  db.prepare(`
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

export function readClients(db: DatabaseSync): Map<string, RegisteredClient> {
  const rows = db.prepare('SELECT * FROM clients').all() as unknown as Array<
    Record<string, unknown>
  >;
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

export function pruneClients(db: DatabaseSync): number {
  const cutoff = new Date(Date.now() - CLIENT_STALE_MS).toISOString();
  const result = db
    .prepare(`DELETE FROM clients WHERE last_seen_at < ? OR ${MALFORMED_TIMESTAMP}`)
    .run(cutoff);
  return Number(result.changes);
}

// ── Credentials ─────────────────────────────────────────────────────────────

export function persistCredential(db: DatabaseSync, credential: MailboxCredential): void {
  db.prepare(`
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
