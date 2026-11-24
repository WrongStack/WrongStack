import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pruneSessionBoards } from '../src/manager/prune.js';
import { getKanbanPath } from '../src/storage.js';
import { createBoard, getBoard } from './helpers/session-manager.js';

const OLD = '2026-11-09T00:00:00.000Z';
const NOW = '2026-11-09T00:00:02.000Z';

const state = vi.hoisted(() => ({
  refreshAfterListing: false,
  root: '',
  boardId: '',
  refreshedUpdatedAt: '',
}));

vi.mock('../src/storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/storage.js')>();
  return {
    ...actual,
    // Stage a session todo-mirror write landing AFTER the prune took its
    // listing snapshot but BEFORE the prune deletes the board. The snapshot is
    // genuine; only the interleaving is staged.
    listBoardSummaries: async (projectRoot: string) => {
      const summaries = await actual.listBoardSummaries(projectRoot);
      if (state.refreshAfterListing) {
        await actual.mutateBoard(state.root, state.boardId, (board) => {
          board.updatedAt = state.refreshedUpdatedAt;
          return true;
        });
      }
      return summaries;
    },
  };
});

describe('pruneSessionBoards — delete_after_ttl race', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-prune-race-'));
    state.root = root;
    state.refreshAfterListing = false;
  });

  afterEach(async () => {
    state.refreshAfterListing = false;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not delete a board refreshed after the listing snapshot', async () => {
    const board = await createBoard(root, { title: 'session mirror' });
    state.boardId = board.id;
    state.refreshedUpdatedAt = NOW;
    await fs.writeFile(
      getKanbanPath(root, board.id),
      JSON.stringify({
        ...board,
        kind: 'session_mirror',
        updatedAt: OLD,
        retention: { mode: 'delete_after_ttl', ttlMs: 1000 },
      }),
    );

    const control = await createBoard(root, { title: 'control mirror' });
    await fs.writeFile(
      getKanbanPath(root, control.id),
      JSON.stringify({
        ...control,
        kind: 'session_mirror',
        updatedAt: OLD,
        retention: { mode: 'delete_after_ttl', ttlMs: 1000 },
      }),
    );

    // The listing sees updatedAt=OLD (TTL elapsed). A concurrent mirror write
    // refreshes updatedAt to NOW before the prune deletes. The board is no
    // longer expired, so the delete must re-check it under the lock.
    state.refreshAfterListing = true;
    const result = await pruneSessionBoards(root, { now: NOW });
    state.refreshAfterListing = false;

    expect(result.deleted).toContain(control.id);
    expect(await getBoard(root, control.id)).toBeNull();
    expect(result.deleted).not.toContain(board.id);
    expect(await getBoard(root, board.id)).not.toBeNull();
  });
});
