/**
 * Tests for board-level history — the global, append-only log that records the
 * lifecycle of every board (created, updated, deleted, duplicated, lifecycle
 * adopted) and survives board deletion.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBoardHistory } from '../src/storage.js';
import {
  adoptManagedLifecycle,
  createBoard,
  duplicateBoard,
  listBoardHistory,
  removeBoard,
  updateBoard,
} from './helpers/session-manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-board-history-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe('board history', () => {
  it('records board.created when a board is created', async () => {
    const board = await createBoard(tmpDir, { title: 'My Board', tags: ['sprint'] });
    const history = await listBoardHistory(tmpDir, board.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.type).toBe('board.created');
    expect(history[0]!.boardTitle).toBe('My Board');
    expect(history[0]!.boardId).toBe(board.id);
  });

  it('records board.updated when a board is updated', async () => {
    const board = await createBoard(tmpDir, { title: 'Original' });
    await updateBoard(tmpDir, board.id, { title: 'Renamed', description: 'New desc' });
    const history = await listBoardHistory(tmpDir, board.id);
    // created + updated
    expect(history).toHaveLength(2);
    const updated = history[1]!;
    expect(updated.type).toBe('board.updated');
    expect(updated.boardTitle).toBe('Renamed');
    expect((updated.after as { title: string }).title).toBe('Renamed');
  });

  it('records board.deleted and the history survives deletion', async () => {
    const board = await createBoard(tmpDir, { title: 'Doomed Board' });
    const deleted = await removeBoard(tmpDir, board.id);
    expect(deleted).toBe(true);

    // The per-board event log is gone, but the global board history survives.
    const history = await listBoardHistory(tmpDir, board.id);
    expect(history).toHaveLength(2);
    expect(history[0]!.type).toBe('board.created');
    expect(history[1]!.type).toBe('board.deleted');
    // Even after deletion, the title is preserved in the history snapshot.
    expect(history[1]!.boardTitle).toBe('Doomed Board');
  });

  it('records board.duplicated when a board is copied', async () => {
    const source = await createBoard(tmpDir, { title: 'Source Board' });
    const copy = await duplicateBoard(tmpDir, source.id, { title: 'Copy Board' });
    expect(copy).not.toBeNull();

    const sourceHistory = await listBoardHistory(tmpDir, source.id);
    expect(sourceHistory.some((e) => e.type === 'board.created')).toBe(true);

    const copyHistory = await listBoardHistory(tmpDir, copy!.id);
    // The copy gets a board.duplicated entry (and no board.created — it was
    // duplicated, not freshly created).
    expect(copyHistory.some((e) => e.type === 'board.duplicated')).toBe(true);
    const dup = copyHistory.find((e) => e.type === 'board.duplicated')!;
    expect((dup.after as { sourceBoardId: string }).sourceBoardId).toBe(source.id);
  });

  it('records board.lifecycle.adopted when managed lifecycle is adopted', async () => {
    const board = await createBoard(tmpDir, { title: 'Managed Board' });
    await adoptManagedLifecycle(tmpDir, board.id, {
      columns: {
        backlog: 'backlog',
        todo: 'todo',
        running: 'in-progress',
        review: 'review',
        done: 'done',
      },
      actor: 'migration-agent',
      comment: 'Adopting managed lifecycle.',
    });

    const history = await listBoardHistory(tmpDir, board.id);
    const adopted = history.find((e) => e.type === 'board.lifecycle.adopted');
    expect(adopted).toBeDefined();
    expect(adopted!.actor).toBe('migration-agent');
    expect(adopted!.note).toBe('Adopting managed lifecycle.');
  });

  it('returns the entire global history when no boardId is given', async () => {
    const boardA = await createBoard(tmpDir, { title: 'Board A' });
    const boardB = await createBoard(tmpDir, { title: 'Board B' });
    const allHistory = await listBoardHistory(tmpDir);
    // At least 2 created entries (one per board).
    const createdEntries = allHistory.filter((e) => e.type === 'board.created');
    expect(createdEntries.length).toBeGreaterThanOrEqual(2);
    expect(allHistory.some((e) => e.boardId === boardA.id)).toBe(true);
    expect(allHistory.some((e) => e.boardId === boardB.id)).toBe(true);
  });

  it('returns an empty array when no history exists for a board', async () => {
    const history = await listBoardHistory(tmpDir, 'nonexistent-board');
    expect(history).toEqual([]);
  });

  it('readBoardHistory reads the same global log directly', async () => {
    const board = await createBoard(tmpDir, { title: 'Direct Read' });
    const directHistory = await readBoardHistory(tmpDir, board.id);
    const apiHistory = await listBoardHistory(tmpDir, board.id);
    expect(directHistory).toEqual(apiHistory);
  });
});
