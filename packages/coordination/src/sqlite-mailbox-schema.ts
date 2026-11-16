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
import { loadDatabaseSync } from '@wrongstack/core/utils';
import {
  GLOBAL_MAILBOX_CLIENT_REGISTRY_FILE,
  GLOBAL_MAILBOX_FILE,
} from './global-mailbox-paths.js';
import { CREDENTIAL_STORE_FILE, type MailboxCredential } from './mailbox-credential-store.js';
import { parseMailboxFile } from './mailbox-parse-state.js';
import { isFanOutRecipient } from './mailbox-receipt-folding.js';
import { parseAgentRegistryEntry, parseClientRegistryEntry } from './mailbox-registry-codec.js';
import type { MailboxMessage, MailboxMessageProjection } from './mailbox-types.js';
import {
  persistAgent,
  persistClient,
  persistCredential,
  persistMessage,
  persistReceipt,
} from './sqlite-mailbox-rows.js';

/**
 * The schema version this build writes and expects.
 *
 * Bump it only together with a migration step in {@link MIGRATION_STEPS}: a
 * database whose version is below this one is migrated on open, a database
 * whose version is above it is refused.
 */
export const SQLITE_MAILBOX_SCHEMA_VERSION = 2;

export { loadDatabaseSync };

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
    applyMigrations(ctx, foundVersion);
    db.prepare('UPDATE mailbox_meta SET value = ? WHERE key = ?').run(
      String(SQLITE_MAILBOX_SCHEMA_VERSION),
      'schema_version',
    );
  }
  migrateLegacyCredentials(ctx);
}

/**
 * Migration steps, keyed by the schema version they migrate FROM.
 *
 * `CREATE TABLE IF NOT EXISTS` only ever creates a MISSING table — it cannot
 * add a column to an existing one. A database written by an older build
 * therefore needs an explicit step before the version is bumped, or every
 * write against it fails on the missing column.
 *
 * A step runs inside one transaction and must be idempotent: the version is
 * bumped only after every step succeeded, so a step that dies half-way leaves
 * the old version in place and the next start replays it.
 */
const MIGRATION_STEPS: Readonly<Record<number, (ctx: SchemaContext) => void>> = {
  1: migrateV1ToV2,
};

/**
 * Run every migration step between the version found in the database and the
 * version this build supports.
 */
function applyMigrations(ctx: SchemaContext, fromVersion: number): void {
  for (let version = fromVersion; version < SQLITE_MAILBOX_SCHEMA_VERSION; version++) {
    const step = MIGRATION_STEPS[version];
    if (step === undefined) {
      throw new Error(
        `Unsupported mailbox SQLite schema ${version}; this build has no migration step from version ${version} to version ${version + 1}`,
      );
    }
    ctx.transaction(() => step(ctx));
  }
}

/**
 * v1 → v2: per-actor receipts replace the message-global completion flag.
 *
 * v1 stored one `completed` flag per message; v2 keeps every actor's
 * delivery state in `message_receipts` and marks the historical
 * message-global completions with `legacy_global_completion`. The
 * classification is the one `mailbox-receipt-folding.ts` folds for a v1
 * message:
 *
 *   - a fan-out recipient (`*`, `@session:…`, a bare alias) completed
 *     message-globally → `legacy_global_completion = 1` and NO completion
 *     receipt: the message stays globally suppressed.
 *   - a direct recipient completed message-globally → the completion belongs
 *     to that actor, so it becomes that actor's receipt.
 *   - a v1 read mark (`readBy`) becomes a read receipt for that actor.
 */
function migrateV1ToV2(ctx: SchemaContext): void {
  const { db } = ctx;
  addColumnIfMissing(db, 'messages', 'legacy_global_completion', 'INTEGER NOT NULL DEFAULT 0');
  reconcileV1Messages(db);
}

/** Add a column to an existing table when it is not there yet. */
function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
  }>;
  if (columns.some((existing) => existing.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** A v1 `messages` row, as far as the migration needs it. */
interface V1MessageRow {
  id: string;
  to_id: string;
  completed: number;
  completed_at: string | null;
  data: string;
}

/** The fields of a stored v1 message the migration reads. */
interface V1StoredMessage {
  completed?: boolean;
  completedBy?: string;
  completedAt?: string;
  outcome?: string;
  readBy?: unknown;
  [key: string]: unknown;
}

/**
 * Reconcile every v1 row with the v2 receipt model.
 *
 * The stored JSON is the projection source (`materializeMessageRows` reads it
 * back), so it is rewritten to the shape v2 stores: a legacy fan-out row
 * keeps its global completion and loses the message-level outcome (v2 keeps
 * the outcome per actor), every other row keeps its fields.
 */
function reconcileV1Messages(db: DatabaseSync): void {
  const rows = db
    .prepare('SELECT id, to_id, completed, completed_at, data FROM messages')
    .all() as unknown as V1MessageRow[];
  for (const row of rows) {
    const stored = parseStoredMessage(row.data);
    if (stored === null) continue;
    const readBy = readByEntries(stored.readBy);
    const completed = row.completed === 1 || stored.completed === true;
    const completedBy = typeof stored.completedBy === 'string' ? stored.completedBy : undefined;
    const completedAt = stored.completedAt ?? row.completed_at ?? undefined;
    const legacyGlobalCompletion = completed && isFanOutRecipient(row.to_id);

    const actors = new Set(Object.keys(readBy));
    // A fan-out completion stays global: it seeds NO actor-scoped receipt,
    // exactly like `foldRecipientState` does for a v1 fan-out message.
    if (completed && !legacyGlobalCompletion && completedBy !== undefined) actors.add(completedBy);
    for (const actor of actors) {
      const actorCompleted = completed && !legacyGlobalCompletion && completedBy === actor;
      insertV1Receipt(db, row.id, {
        actorId: actor,
        readAt: readBy[actor] ?? null,
        completedAt: actorCompleted ? (completedAt ?? null) : null,
        completedBy: actorCompleted ? actor : null,
        outcome: actorCompleted ? (stored.outcome ?? null) : null,
      });
    }

    const data: Record<string, unknown> = { ...stored, completed };
    if (legacyGlobalCompletion) delete data['outcome'];
    db.prepare(
      'UPDATE messages SET legacy_global_completion = ?, completed = ?, data = ? WHERE id = ?',
    ).run(legacyGlobalCompletion ? 1 : 0, completed ? 1 : 0, JSON.stringify(data), row.id);
  }
}

/**
 * Insert one receipt for a migrated v1 row.
 *
 * `ON CONFLICT DO NOTHING`: a receipt that already exists belongs to a
 * database that was not really v1, and the migration must not destroy it.
 */
function insertV1Receipt(
  db: DatabaseSync,
  messageId: string,
  state: {
    actorId: string;
    readAt: string | null;
    completedAt: string | null;
    completedBy: string | null;
    outcome: string | null;
  },
): void {
  db.prepare(`
      INSERT INTO message_receipts(
        message_id, actor_id, read_at, completed_at, completed_by, outcome
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id, actor_id) DO NOTHING
    `).run(
    messageId,
    state.actorId,
    state.readAt,
    state.completedAt,
    state.completedBy,
    state.outcome,
  );
}

/** Parse a stored message, tolerating the malformed rows a legacy file can hold. */
function parseStoredMessage(data: string): V1StoredMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as V1StoredMessage;
}

/**
 * The `readBy` map of a stored message.
 *
 * Legacy rows may carry `null` or a non-object here; those contribute no
 * actors instead of throwing.
 */
function readByEntries(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const entries: Record<string, string> = {};
  for (const [actorId, readAt] of Object.entries(value)) {
    if (typeof readAt === 'string') entries[actorId] = readAt;
  }
  return entries;
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
    const parsedRaw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) {
      return new Map();
    }
    const raw = parsedRaw as Record<string, unknown>;
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
