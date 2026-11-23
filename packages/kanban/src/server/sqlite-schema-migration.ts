import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { assertValidBoardId, getKanbanDir, isValidBoardId, normalizeBoard } from '../storage.js';
import type { KanbanBoard, KanbanEvent } from '../types.js';

const LEGACY_MIGRATION_KEY = 'legacy-json-v1';

function eventIdentity(event: KanbanEvent): string {
  return typeof event.id === 'string' && event.id.length > 0
    ? `id:${event.id}`
    : `sha256:${createHash('sha256').update(JSON.stringify(event)).digest('hex')}`;
}

/**
 * Read a legacy JSON/JSONL source the way the file codec in storage.ts reads
 * it: a leading UTF-8 BOM (Windows editors, PowerShell 5.1) is dropped, so a
 * file the legacy readers accept is never what blocks the store from opening.
 */
async function readLegacyText(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

async function removeLegacyFiles(dir: string, fileNames: readonly string[]): Promise<void> {
  await Promise.all(fileNames.map((fileName) => fs.rm(path.join(dir, fileName), { force: true })));
}

export function initializeKanbanSchema(db: DatabaseSync): void {
  db.exec(`
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

export async function migrateLegacyKanbanFiles(
  db: DatabaseSync,
  projectRoot: string,
): Promise<void> {
  const migrated = db
    .prepare('SELECT value FROM kanban_meta WHERE key = ?')
    .get(LEGACY_MIGRATION_KEY) as { value: string } | undefined;

  const dir = getKanbanDir(projectRoot);
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

  db.exec('BEGIN IMMEDIATE');
  try {
    const upsertLegacyBoard = db.prepare(
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
      const raw = await readLegacyText(path.join(dir, entry.name));
      const parsed = JSON.parse(raw) as KanbanBoard;
      if (parsed.id !== boardId) {
        throw new Error(
          `Legacy Kanban filename "${entry.name}" does not match board id "${parsed.id}"`,
        );
      }
      const sourceUpdatedAt = parsed.updatedAt ?? parsed.createdAt ?? '';
      const board = normalizeBoard(parsed);
      upsertLegacyBoard.run(board.id, JSON.stringify(board), board.revision ?? 0, sourceUpdatedAt);
    }
    for (const entry of eventFiles) {
      const boardId = entry.name.slice(0, -'.events.jsonl'.length);
      assertValidBoardId(boardId);
      const existingEventKeys = new Set(
        (
          db
            .prepare('SELECT payload FROM kanban_events WHERE board_id = ? ORDER BY seq')
            .all(boardId) as Array<{ payload: string }>
        ).map((row) => eventIdentity(JSON.parse(row.payload) as KanbanEvent)),
      );
      const eventRaw = await readLegacyText(path.join(dir, entry.name));
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
        db.prepare('INSERT INTO kanban_events(board_id, payload) VALUES (?, ?)').run(
          boardId,
          JSON.stringify(event),
        );
        existingEventKeys.add(identity);
      }
    }
    const legacyHqState =
      hqSyncFile === null ? null : await readLegacyText(path.join(dir, hqSyncFile));
    if (legacyHqState !== null) {
      JSON.parse(legacyHqState);
      db.prepare('INSERT OR IGNORE INTO kanban_meta(key, value) VALUES (?, ?)').run(
        'hq-sync-state-v1',
        legacyHqState,
      );
    }
    db.prepare(
      `INSERT INTO kanban_meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(LEGACY_MIGRATION_KEY, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    // Preserve the original error if ROLLBACK itself fails (e.g. the
    // transaction was already ended by the failing write).
    try {
      db.exec('ROLLBACK');
    } catch {
      /* preserve original error */
    }
    throw error;
  }
  // Filesystem deletion deliberately happens only after COMMIT. A parse,
  // insert, or transaction failure therefore leaves every legacy source
  // intact for diagnosis/retry. Cleanup failure fails startup and is retried
  // on the next open via the committed migration marker above.
  await removeLegacyFiles(dir, legacyFiles);
}
