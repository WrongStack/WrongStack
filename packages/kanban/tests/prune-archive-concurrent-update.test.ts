/**
 * Regression (F1000): `pruneSessionBoards` archived a TTL-expired session
 * mirror with `readBoard` followed by an unconditional `writeBoard`. An update
 * committed between the two — a resumed session's todo mirror write, which
 * fires alongside the session-start prune — was overwritten by the stale
 * snapshot. The archive must go through the same atomic read-modify-write
 * (`mutateBoard`) every other board mutation uses.
 *
 * Real SQLite storage; the only hook is a pass-through backend that commits one
 * concurrent update right after prune's first post-listing access to the board
 * (gated, no timers).
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneSessionBoards } from '../src/manager/prune.js';
import { SqliteKanbanStorage } from '../src/server/sqlite-storage.js';
import { createBoardObject, mutateBoard, readBoard, writeBoard } from '../src/storage.js';
import { installKanbanStorageBackend, type KanbanStorageBackend } from '../src/storage-backend.js';
import type { KanbanBoard } from '../src/types.js';
import { removeProjectFixtureDirectory } from './helpers/remove-fixture-directory.js';

const NOW = '2026-08-01T00:00:00.000Z';
const STALE = '2020-01-01T00:00:00.000Z';

let root: string;
let real: SqliteKanbanStorage;
let uninstall: (() => void) | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-prune-race-'));
  real = await SqliteKanbanStorage.open(root);
});
afterEach(async () => {
  uninstall?.();
  uninstall = undefined;
  real.close();
  await removeProjectFixtureDirectory(root, { maxRetries: 5, retryDelay: 25 });
});

/** Pass-through backend; `afterAccess` runs once a board read/mutation resolves. */
function proxyBackend(afterAccess: (ref: string) => Promise<void>): KanbanStorageBackend {
  return {
    kind: real.kind,
    listBoardIds: () => real.listBoardIds(),
    readBoard: async (ref) => {
      const board = await real.readBoard(ref);
      await afterAccess(ref);
      return board;
    },
    writeBoard: (board, expected) => real.writeBoard(board, expected),
    appendEvent: (id, event) => real.appendEvent(id, event),
    readEvents: (ref) => real.readEvents(ref),
    deleteBoard: (ref) => real.deleteBoard(ref),
    readMetadata: (key) => real.readMetadata(key),
    writeMetadata: (key, value) => real.writeMetadata(key, value),
    mutateBoard: async (ref, mutator) => {
      const result = await real.mutateBoard(ref, mutator);
      await afterAccess(ref);
      return result;
    },
    appendBoardHistory: (entry) => real.appendBoardHistory(entry),
    readBoardHistory: (id) => real.readBoardHistory(id),
  };
}

async function seedExpiredMirror(): Promise<string> {
  const board: KanbanBoard = createBoardObject({
    title: 'session mirror',
    kind: 'session_mirror',
    retention: { mode: 'archive_after_ttl', ttlMs: 1000 },
  });
  board.tasks.push({
    id: 'old-card',
    title: 'old card',
    columnId: board.columns[0]!.id,
    order: 0,
    priority: 'medium',
    status: 'completed',
    createdAt: STALE,
    updatedAt: STALE,
  } as KanbanBoard['tasks'][number]);
  board.updatedAt = STALE;
  await writeBoard(root, board);
  return board.id;
}

describe('pruneSessionBoards archive vs a concurrent board update', () => {
  it('does not overwrite an update committed after the prune listing', async () => {
    let boardId = '';
    let accesses = 0;
    let fired = false;
    uninstall = installKanbanStorageBackend(
      root,
      proxyBackend(async (ref) => {
        if (ref !== boardId || fired) return;
        accesses += 1;
        if (accesses < 2) return; // the first access is the prune listing
        fired = true;
        await mutateBoard(root, boardId, (board) => {
          board.tasks.push({
            ...structuredClone(board.tasks[0]!),
            id: 'resumed-session-card',
            title: 'card written by the resumed session',
          });
          return true;
        });
      }),
    );
    boardId = await seedExpiredMirror();

    await pruneSessionBoards(root, { now: NOW });

    expect(fired).toBe(true);
    const final = await readBoard(root, boardId);
    expect(final?.tasks.map((task) => task.id).sort()).toEqual([
      'old-card',
      'resumed-session-card',
    ]);
  });

  it('does not archive a board refreshed after the prune listing', async () => {
    let boardId = '';
    let fired = false;
    uninstall = installKanbanStorageBackend(
      root,
      proxyBackend(async (ref) => {
        // Refresh right after the listing read: prune then sees a live board.
        if (ref !== boardId || fired) return;
        fired = true;
        await mutateBoard(root, boardId, (board) => {
          board.updatedAt = NOW;
          return true;
        });
      }),
    );
    boardId = await seedExpiredMirror();

    const result = await pruneSessionBoards(root, { now: NOW });

    expect(fired).toBe(true);
    expect(result.archived).not.toContain(boardId);
    expect((await readBoard(root, boardId))?.kind).toBe('session_mirror');
  });

  it('still archives an expired mirror nobody touches', async () => {
    uninstall = installKanbanStorageBackend(
      root,
      proxyBackend(async () => {}),
    );
    const boardId = await seedExpiredMirror();

    const result = await pruneSessionBoards(root, { now: NOW });

    expect(result.archived).toContain(boardId);
    const final = await readBoard(root, boardId);
    expect(final?.kind).toBe('archive');
    expect(final?.retention?.archivedAt).toBe(NOW);
  });
});
