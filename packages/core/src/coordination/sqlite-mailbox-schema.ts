/**
 * Schema creation, version fencing, and one-time legacy-file import for the
 * SQLite mailbox.
 *
 * Split out of `sqlite-mailbox.ts`. Everything here runs once, from the store's
 * constructor; keeping it separate leaves that file to the message flow.
 *
 * @module coordination/sqlite-mailbox-schema
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import { withSqliteExperimentalWarningSuppressed } from '../utils/sqlite-warning.js';
import {
  GLOBAL_MAILBOX_CLIENT_REGISTRY_FILE,
  GLOBAL_MAILBOX_FILE,
} from './global-mailbox-paths.js';
import { CREDENTIAL_STORE_FILE, type MailboxCredential } from './mailbox-credential-store.js';
import { parseMailboxFile } from './mailbox-parse-state.js';
import { parseAgentRegistryEntry, parseClientRegistryEntry } from './mailbox-registry-codec.js';
import type { MailboxMessage, MailboxMessageProjection } from './mailbox-types.js';
import {
  persistAgent,
  persistClient,
  persistCredential,
  persistMessage,
  persistReceipt,
} from './sqlite-mailbox-rows.js';

export const SQLITE_MAILBOX_SCHEMA_VERSION = 2;

let DatabaseSyncCtor: typeof DatabaseSync | undefined;

export function loadDatabaseSync(): typeof DatabaseSync {
  if (DatabaseSyncCtor) return DatabaseSyncCtor;
  return withSqliteExperimentalWarningSuppressed(() => {
    DatabaseSyncCtor = loadRuntimeDatabaseSync();
    return DatabaseSyncCtor;
  });
}

/** The store state schema setup and migration need. */
export interface SchemaContext {
  db: DatabaseSync;
  projectDir: string;
  transaction: <T>(run: () => T) => T;
}

export function initializeSchema(ctx: SchemaContext): void {
  const { db } = ctx;
  db.exec(`
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
  db.prepare('INSERT INTO mailbox_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(
    'schema_version',
    String(SQLITE_MAILBOX_SCHEMA_VERSION),
  );
  const schema = db.prepare('SELECT value FROM mailbox_meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
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
    db.prepare('UPDATE mailbox_meta SET value = ? WHERE key = ?').run(
      String(SQLITE_MAILBOX_SCHEMA_VERSION),
      'schema_version',
    );
  }
  migrateLegacyCredentials(ctx);
}

function migrateLegacyCredentials(ctx: SchemaContext): void {
  const { db } = ctx;
  const marker = db
    .prepare('SELECT value FROM mailbox_meta WHERE key = ?')
    .get('legacy_credentials_imported') as { value: string } | undefined;
  if (marker !== undefined) return;
  const legacyPath = path.join(ctx.projectDir, CREDENTIAL_STORE_FILE);
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
        )
          credentials.push(credential);
      } catch {
        // Preserve legacy adapter behavior: malformed records are skipped.
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
  ctx.transaction(() => {
    for (const credential of credentials) persistCredential(db, credential);
    db.prepare('INSERT INTO mailbox_meta(key, value) VALUES (?, ?)').run(
      'legacy_credentials_imported',
      new Date().toISOString(),
    );
  });
}

export function migrateLegacyFiles(ctx: SchemaContext): void {
  const { db } = ctx;
  const marker = db
    .prepare('SELECT value FROM mailbox_meta WHERE key = ?')
    .get('legacy_files_imported') as { value: string } | undefined;
  if (marker !== undefined) return;

  const messages = readLegacyMessages(ctx.projectDir);
  const agents = readLegacyRegistry(
    path.join(ctx.projectDir, '_mailbox.registry.json'),
    parseAgentRegistryEntry,
  );
  const clients = readLegacyRegistry(
    path.join(ctx.projectDir, GLOBAL_MAILBOX_CLIENT_REGISTRY_FILE),
    parseClientRegistryEntry,
  );

  ctx.transaction(() => {
    for (const message of messages) {
      const projection = message as MailboxMessageProjection;
      persistMessage(db, message, projection.legacyGlobalCompletion === true);
      for (const state of Object.values(projection.recipientState ?? {})) {
        persistReceipt(db, message.id, state);
      }
    }
    for (const agent of agents.values()) persistAgent(db, agent);
    for (const client of clients.values()) persistClient(db, client);
    db.prepare('INSERT INTO mailbox_meta(key, value) VALUES (?, ?)').run(
      'legacy_files_imported',
      new Date().toISOString(),
    );
  });
}

function readLegacyMessages(projectDir: string): MailboxMessage[] {
  try {
    return parseMailboxFile(fs.readFileSync(path.join(projectDir, GLOBAL_MAILBOX_FILE), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function readLegacyRegistry<T>(
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
