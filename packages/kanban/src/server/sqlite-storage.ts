import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { STALE_WRITE_PREFIX, StaleWriteError } from '../manager/lifecycle-error.js';
import {
  assertValidBoardId,
  EVENT_LOG_MAX_ENTRIES,
  EVENT_LOG_TRIM_TO,
  getKanbanDir,
  isValidBoardId,
  KANBAN_BOARD_SOFT_MAX_BYTES,
  normalizeBoard,
} from '../storage.js';
import type { KanbanStorageBackend } from '../storage-backend.js';
import type { KanbanBoard, KanbanBoardHistoryEntry, KanbanEvent } from '../types.js';
import type { KanbanWorkflowCommand, KanbanWorkflowState } from './protocol.js';

export const KANBAN_SQLITE_FILE = '_kanban.sqlite';
const LEGACY_MIGRATION_KEY = 'legacy-json-v1';

interface BoardRow {
  id: string;
  payload: string;
  revision: number;
}

interface CountRow {
  count: number;
}

export interface SqliteKanbanMutation {
  type: 'created' | 'updated' | 'deleted';
  boardId: string;
  revision?: number | undefined;
}

export class SqliteKanbanStorage implements KanbanStorageBackend {
  readonly kind = 'sqlite' as const;
  readonly databasePath: string;

  private readonly db: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** Boards already reported oversized, so the warning fires on transitions only. */
  private readonly oversizedBoards = new Set<string>();

  private constructor(
    readonly projectRoot: string,
    databasePath: string,
    private readonly onMutation?: (mutation: SqliteKanbanMutation) => void,
  ) {
    this.databasePath = databasePath;
    this.db = new DatabaseSync(databasePath);
  }

  static async open(
    projectRoot: string,
    onMutation?: (mutation: SqliteKanbanMutation) => void,
  ): Promise<SqliteKanbanStorage> {
    const dir = getKanbanDir(projectRoot);
    await fs.mkdir(dir, { recursive: true });
    const storage = new SqliteKanbanStorage(
      projectRoot,
      path.join(dir, KANBAN_SQLITE_FILE),
      onMutation,
    );
    try {
      storage.initializeSchema();
      await storage.migrateLegacyFiles();
      return storage;
    } catch (error) {
      storage.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  async listBoardIds(): Promise<string[]> {
    return this.exclusive(() =>
      (
        this.db.prepare('SELECT id FROM kanban_boards ORDER BY id').all() as Array<{
          id: string;
        }>
      ).map((row) => row.id),
    );
  }

  async readBoard(boardRef: string): Promise<KanbanBoard | null> {
    return this.exclusive(() => this.readBoardUnlocked(boardRef));
  }

  async writeBoard(board: KanbanBoard, expectedRevision?: number): Promise<void> {
    const created = await this.exclusive(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const inserted = this.writeBoardUnlocked(board, expectedRevision);
        this.db.exec('COMMIT');
        return inserted;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
    this.notify({
      type: created ? 'created' : 'updated',
      boardId: board.id,
      revision: board.revision,
    });
  }

  async appendEvent(boardId: string, event: KanbanEvent): Promise<void> {
    assertValidBoardId(boardId);
    await this.exclusive(() => {
      this.db
        .prepare('INSERT INTO kanban_events(board_id, payload) VALUES (?, ?)')
        .run(boardId, JSON.stringify(event));
      const row = this.db
        .prepare('SELECT COUNT(*) AS count FROM kanban_events WHERE board_id = ?')
        .get(boardId) as unknown as CountRow;
      if (row.count > EVENT_LOG_MAX_ENTRIES) {
        this.db
          .prepare(
            `DELETE FROM kanban_events
             WHERE board_id = ?
               AND seq NOT IN (
                 SELECT seq FROM kanban_events
                 WHERE board_id = ?
                 ORDER BY seq DESC
                 LIMIT ?
               )`,
          )
          .run(boardId, boardId, EVENT_LOG_TRIM_TO);
      }
    });
  }

  async readEvents(boardRef: string): Promise<KanbanEvent[]> {
    return this.exclusive(() => {
      const boardId = this.resolveBoardRefUnlocked(boardRef);
      if (!boardId) return [];
      return (
        this.db
          .prepare('SELECT payload FROM kanban_events WHERE board_id = ? ORDER BY seq')
          .all(boardId) as Array<{ payload: string }>
      ).map((row) => JSON.parse(row.payload) as KanbanEvent);
    });
  }

  async deleteBoard(boardRef: string): Promise<boolean> {
    const outcome = await this.exclusive(() => {
      const boardId = this.resolveBoardRefUnlocked(boardRef);
      if (!boardId) return { boardId: null, deleted: false };
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM kanban_events WHERE board_id = ?').run(boardId);
        const result = this.db.prepare('DELETE FROM kanban_boards WHERE id = ?').run(boardId);
        this.db.exec('COMMIT');
        return { boardId, deleted: Number(result.changes) > 0 };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
    if (outcome.deleted && outcome.boardId) {
      this.notify({ type: 'deleted', boardId: outcome.boardId });
    }
    return outcome.deleted;
  }

  async appendBoardHistory(entry: KanbanBoardHistoryEntry): Promise<void> {
    await this.exclusive(() => {
      this.db
        .prepare('INSERT INTO kanban_board_history(board_id, payload) VALUES (?, ?)')
        .run(entry.boardId, JSON.stringify(entry));
      // Board history grows much slower than per-board events (board-level
      // mutations are rare), but cap it with the same trim thresholds so a
      // long-lived project does not accumulate an unbounded global log.
      const row = this.db
        .prepare('SELECT COUNT(*) AS count FROM kanban_board_history')
        .get() as unknown as CountRow;
      if (row.count > EVENT_LOG_MAX_ENTRIES) {
        this.db
          .prepare(
            `DELETE FROM kanban_board_history
             WHERE seq NOT IN (
               SELECT seq FROM kanban_board_history
               ORDER BY seq DESC
               LIMIT ?
             )`,
          )
          .run(EVENT_LOG_TRIM_TO);
      }
    });
  }

  async readBoardHistory(boardId?: string): Promise<KanbanBoardHistoryEntry[]> {
    return this.exclusive(() => {
      const rows = boardId
        ? (this.db
            .prepare('SELECT payload FROM kanban_board_history WHERE board_id = ? ORDER BY seq')
            .all(boardId) as Array<{ payload: string }>)
        : (this.db.prepare('SELECT payload FROM kanban_board_history ORDER BY seq').all() as Array<{
            payload: string;
          }>);
      return rows.map((row) => JSON.parse(row.payload) as KanbanBoardHistoryEntry);
    });
  }

  async readMetadata(key: string): Promise<string | null> {
    return this.exclusive(() => {
      const row = this.db.prepare('SELECT value FROM kanban_meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    });
  }

  async writeMetadata(key: string, value: string): Promise<void> {
    await this.exclusive(() => {
      this.db
        .prepare(
          `INSERT INTO kanban_meta(key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, value);
    });
  }

  async enqueueWorkflowCommand(
    workflowId: string,
    command: KanbanWorkflowCommand,
  ): Promise<boolean> {
    return this.exclusive(() => {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO kanban_workflow_commands
             (workflow_id, command_id, created_at, type, payload)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          workflowId,
          command.id,
          command.createdAt,
          command.type,
          command.payload === undefined ? null : JSON.stringify(command.payload),
        );
      return Number(result.changes) > 0;
    });
  }

  async drainWorkflowCommands(workflowId: string, limit = 100): Promise<KanbanWorkflowCommand[]> {
    return this.exclusive(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const rows = this.db
          .prepare(
            `SELECT seq, command_id, created_at, type, payload
             FROM kanban_workflow_commands
             WHERE workflow_id = ?
             ORDER BY seq
             LIMIT ?`,
          )
          .all(workflowId, limit) as Array<{
          seq: number;
          command_id: string;
          created_at: string;
          type: string;
          payload: string | null;
        }>;
        if (rows.length > 0) {
          const placeholders = rows.map(() => '?').join(', ');
          this.db
            .prepare(`DELETE FROM kanban_workflow_commands WHERE seq IN (${placeholders})`)
            .run(...rows.map((row) => row.seq));
        }
        this.db.exec('COMMIT');
        return rows.map((row) => ({
          id: row.command_id,
          workflowId,
          createdAt: row.created_at,
          type: row.type,
          ...(row.payload === null ? {} : { payload: JSON.parse(row.payload) as unknown }),
        }));
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async readWorkflowState(workflowId: string): Promise<KanbanWorkflowState | null> {
    return this.exclusive(() => this.readWorkflowStateUnlocked(workflowId));
  }

  async writeWorkflowState(
    workflowId: string,
    value: unknown,
    expectedRevision?: number,
  ): Promise<KanbanWorkflowState> {
    return this.exclusive(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const current = this.readWorkflowStateUnlocked(workflowId);
        const currentRevision = current?.revision ?? 0;
        if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
          throw new StaleWriteError(
            `${STALE_WRITE_PREFIX} for workflow "${workflowId}": current revision ` +
              `${currentRevision} does not match expected revision ${expectedRevision}.`,
          );
        }
        const state: KanbanWorkflowState = {
          workflowId,
          revision: currentRevision + 1,
          updatedAt: new Date().toISOString(),
          value,
        };
        this.db
          .prepare(
            `INSERT INTO kanban_workflow_state(workflow_id, revision, updated_at, payload)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(workflow_id) DO UPDATE SET
               revision = excluded.revision,
               updated_at = excluded.updated_at,
               payload = excluded.payload`,
          )
          .run(workflowId, state.revision, state.updatedAt, JSON.stringify(value));
        this.db.exec('COMMIT');
        return state;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async listWorkflowStates(prefix: string, limit = 100): Promise<KanbanWorkflowState[]> {
    return this.exclusive(() => {
      const rows = this.db
        .prepare(
          `SELECT workflow_id, revision, updated_at, payload
           FROM kanban_workflow_state
           WHERE workflow_id LIKE ? ESCAPE '\\'
           ORDER BY updated_at DESC, workflow_id
           LIMIT ?`,
        )
        .all(`${escapeLike(prefix)}%`, limit) as Array<{
        workflow_id: string;
        revision: number;
        updated_at: string;
        payload: string;
      }>;
      return rows.map((row) => this.workflowStateFromRow(row));
    });
  }

  async deleteWorkflowState(workflowId: string): Promise<boolean> {
    return this.exclusive(() => {
      const result = this.db
        .prepare('DELETE FROM kanban_workflow_state WHERE workflow_id = ?')
        .run(workflowId);
      return Number(result.changes) > 0;
    });
  }

  async mutateBoard<T>(
    boardRef: string,
    mutator: (board: KanbanBoard) => T | Promise<T>,
  ): Promise<{ board: KanbanBoard; result: T } | null> {
    const outcome = await this.exclusive(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const board = this.readBoardUnlocked(boardRef);
        if (!board) {
          this.db.exec('ROLLBACK');
          return null;
        }
        const readRevision = board.revision ?? 0;
        const before = fingerprint(board);
        const result = await mutator(board);
        const changed = fingerprint(board) !== before;
        if (changed) {
          board.revision = readRevision + 1;
          this.writeBoardUnlocked(board, readRevision);
        }
        this.db.exec('COMMIT');
        return { value: { board, result }, changed };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
    if (!outcome) return null;
    if (outcome.changed) {
      this.notify({
        type: 'updated',
        boardId: outcome.value.board.id,
        revision: outcome.value.board.revision,
      });
    }
    return outcome.value;
  }

  private initializeSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS kanban_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kanban_boards (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kanban_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kanban_events_board_seq
        ON kanban_events(board_id, seq);

      CREATE TABLE IF NOT EXISTS kanban_workflow_commands (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT,
        UNIQUE (workflow_id, command_id)
      );

      CREATE INDEX IF NOT EXISTS idx_kanban_workflow_commands_workflow_seq
        ON kanban_workflow_commands(workflow_id, seq);

      CREATE TABLE IF NOT EXISTS kanban_workflow_state (
        workflow_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kanban_workflow_state_updated
        ON kanban_workflow_state(updated_at DESC);

      CREATE TABLE IF NOT EXISTS kanban_board_history (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kanban_board_history_board_seq
        ON kanban_board_history(board_id, seq);
    `);
  }

  private readWorkflowStateUnlocked(workflowId: string): KanbanWorkflowState | null {
    const row = this.db
      .prepare(
        `SELECT workflow_id, revision, updated_at, payload
         FROM kanban_workflow_state WHERE workflow_id = ?`,
      )
      .get(workflowId) as
      | { workflow_id: string; revision: number; updated_at: string; payload: string }
      | undefined;
    return row ? this.workflowStateFromRow(row) : null;
  }

  private workflowStateFromRow(row: {
    workflow_id: string;
    revision: number;
    updated_at: string;
    payload: string;
  }): KanbanWorkflowState {
    return {
      workflowId: row.workflow_id,
      revision: row.revision,
      updatedAt: row.updated_at,
      value: JSON.parse(row.payload) as unknown,
    };
  }

  private async migrateLegacyFiles(): Promise<void> {
    const migrated = this.db
      .prepare('SELECT value FROM kanban_meta WHERE key = ?')
      .get(LEGACY_MIGRATION_KEY) as { value: string } | undefined;

    const dir = getKanbanDir(this.projectRoot);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    const boardFiles = entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith('.json') && isValidBoardId(entry.name.slice(0, -5)),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    const eventFiles = entries
      .filter((entry) => {
        if (!entry.isFile() || !entry.name.endsWith('.events.jsonl')) return false;
        return isValidBoardId(entry.name.slice(0, -'.events.jsonl'.length));
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const hqSyncFile = entries.some((entry) => entry.isFile() && entry.name === '.hq-sync.json')
      ? '.hq-sync.json'
      : null;
    const legacyFiles = [
      ...boardFiles.map((entry) => entry.name),
      ...eventFiles.map((entry) => entry.name),
      ...(hqSyncFile ? [hqSyncFile] : []),
    ];

    if (migrated && legacyFiles.length === 0) return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const upsertLegacyBoard = this.db.prepare(
        `INSERT INTO kanban_boards(id, payload, revision, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload = excluded.payload,
           revision = excluded.revision,
           updated_at = excluded.updated_at
         WHERE excluded.revision > kanban_boards.revision
            OR (
              excluded.revision = kanban_boards.revision
              AND excluded.updated_at > kanban_boards.updated_at
            )`,
      );
      for (const entry of boardFiles) {
        const boardId = entry.name.slice(0, -5);
        assertValidBoardId(boardId);
        const raw = await fs.readFile(path.join(dir, entry.name), 'utf8');
        const parsed = JSON.parse(raw) as KanbanBoard;
        if (parsed.id !== boardId) {
          throw new Error(
            `Legacy Kanban filename "${entry.name}" does not match board id "${parsed.id}"`,
          );
        }
        const sourceUpdatedAt = parsed.updatedAt ?? parsed.createdAt ?? '';
        const board = normalizeBoard(parsed);
        upsertLegacyBoard.run(
          board.id,
          JSON.stringify(board),
          board.revision ?? 0,
          sourceUpdatedAt,
        );
      }
      for (const entry of eventFiles) {
        const boardId = entry.name.slice(0, -'.events.jsonl'.length);
        assertValidBoardId(boardId);
        const existingEventKeys = new Set(
          (
            this.db
              .prepare('SELECT payload FROM kanban_events WHERE board_id = ? ORDER BY seq')
              .all(boardId) as Array<{ payload: string }>
          ).map((row) => eventIdentity(JSON.parse(row.payload) as KanbanEvent)),
        );
        const eventRaw = await fs.readFile(path.join(dir, entry.name), 'utf8');
        for (const line of eventRaw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as KanbanEvent;
          if (event.boardId !== boardId) {
            throw new Error(
              `Legacy Kanban event "${event.id}" belongs to "${event.boardId}", not "${boardId}"`,
            );
          }
          const identity = eventIdentity(event);
          if (existingEventKeys.has(identity)) continue;
          this.db
            .prepare('INSERT INTO kanban_events(board_id, payload) VALUES (?, ?)')
            .run(boardId, JSON.stringify(event));
          existingEventKeys.add(identity);
        }
      }
      const legacyHqState =
        hqSyncFile === null ? null : await fs.readFile(path.join(dir, hqSyncFile), 'utf8');
      if (legacyHqState !== null) {
        JSON.parse(legacyHqState);
        this.db
          .prepare('INSERT OR IGNORE INTO kanban_meta(key, value) VALUES (?, ?)')
          .run('hq-sync-state-v1', legacyHqState);
      }
      this.db
        .prepare(
          `INSERT INTO kanban_meta(key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(LEGACY_MIGRATION_KEY, new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // Filesystem deletion deliberately happens only after COMMIT. A parse,
    // insert, or transaction failure therefore leaves every legacy source
    // intact for diagnosis/retry. Cleanup failure fails startup and is retried
    // on the next open via the committed migration marker above.
    await removeLegacyFiles(dir, legacyFiles);
  }

  private resolveBoardRefUnlocked(boardRef: string): string | null {
    assertValidBoardId(boardRef);
    const exact = this.db.prepare('SELECT id FROM kanban_boards WHERE id = ?').get(boardRef) as
      | { id: string }
      | undefined;
    if (exact) return exact.id;
    const matches = this.db
      .prepare(
        `SELECT id FROM kanban_boards
         WHERE id LIKE ? ESCAPE '\\'
         ORDER BY id
         LIMIT 6`,
      )
      .all(`${escapeLike(boardRef)}%`) as Array<{ id: string }>;
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous kanban board id "${boardRef}": ${matches
          .slice(0, 5)
          .map((row) => row.id)
          .join(', ')}`,
      );
    }
    return matches[0]?.id ?? null;
  }

  private readBoardUnlocked(boardRef: string): KanbanBoard | null {
    const boardId = this.resolveBoardRefUnlocked(boardRef);
    if (!boardId) return null;
    const row = this.db
      .prepare('SELECT id, payload, revision FROM kanban_boards WHERE id = ?')
      .get(boardId) as BoardRow | undefined;
    return row ? normalizeBoard(JSON.parse(row.payload) as KanbanBoard) : null;
  }

  private writeBoardUnlocked(board: KanbanBoard, expectedRevision?: number): boolean {
    const normalized = normalizeBoard(board);
    const current = this.db
      .prepare('SELECT revision FROM kanban_boards WHERE id = ?')
      .get(normalized.id) as { revision: number } | undefined;
    if (expectedRevision !== undefined && current?.revision !== expectedRevision) {
      throw new StaleWriteError(
        `${STALE_WRITE_PREFIX} for board "${normalized.id}": SQLite revision ${
          current?.revision ?? 'missing'
        } does not match read revision ${expectedRevision}. Rerun the operation.`,
      );
    }
    const payload = JSON.stringify(normalized);
    this.warnIfOversized(normalized.id, payload, normalized.tasks?.length ?? 0);
    this.db
      .prepare(
        `INSERT INTO kanban_boards(id, payload, revision, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload = excluded.payload,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
      )
      .run(
        normalized.id,
        payload,
        normalized.revision ?? 0,
        normalized.updatedAt ?? new Date().toISOString(),
      );
    return current === undefined;
  }

  /**
   * A board that outgrows the HQ wire codec disappears from HQ without a word.
   * Warn on the way past the soft threshold, while archiving still helps.
   *
   * The payload is already serialized for the INSERT, so this costs one
   * `Buffer.byteLength` — and only warns on the transition, so a board that
   * stays oversized does not warn on every mutation of every card.
   */
  private warnIfOversized(boardId: string, payload: string, taskCount: number): void {
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes <= KANBAN_BOARD_SOFT_MAX_BYTES) {
      this.oversizedBoards.delete(boardId);
      return;
    }
    if (this.oversizedBoards.has(boardId)) return;
    this.oversizedBoards.add(boardId);
    process.emitWarning(
      `Kanban board "${boardId}" is ${Math.round(bytes / 1024)} KB across ${taskCount} card(s), over the ${Math.round(
        KANBAN_BOARD_SOFT_MAX_BYTES / 1024,
      )} KB soft limit. Boards past ~750 KB stop appearing in HQ. Archive completed cards, or run the mirror compaction if this is a session board.`,
      { code: 'WRONGSTACK_KANBAN_BOARD_OVERSIZED' },
    );
  }

  private notify(mutation: SqliteKanbanMutation): void {
    try {
      this.onMutation?.(mutation);
    } catch {
      // Persistence has already committed. Subscriber failures must not turn a
      // successful board mutation into a client-visible write failure.
    }
  }

  private exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Kanban SQLite storage is closed'));
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function fingerprint(board: KanbanBoard): string {
  return createHash('sha256').update(JSON.stringify(board)).digest('hex');
}

function eventIdentity(event: KanbanEvent): string {
  return typeof event.id === 'string' && event.id.length > 0
    ? `id:${event.id}`
    : `sha256:${createHash('sha256').update(JSON.stringify(event)).digest('hex')}`;
}

async function removeLegacyFiles(dir: string, fileNames: readonly string[]): Promise<void> {
  await Promise.all(fileNames.map((fileName) => fs.rm(path.join(dir, fileName), { force: true })));
}

function escapeLike(value: string): string {
  return value.replaceAll('%', '\\%').replaceAll('_', '\\_');
}
