import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBoard } from '../src/storage.js';
import { createBoard, getBoard, pruneSessionBoards } from './helpers/session-manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-prune-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

// Helper: create a board with kind + retention, then set its updatedAt to the past.
async function createSessionBoard(opts: {
  id?: string;
  kind?: string;
  retention?: { mode: string; ttlMs?: number; archivedAt?: string };
  updatedAt?: string;
}): Promise<string> {
  const board = await createBoard(tmpDir, {
    title: 'Session Board',
    tags: ['session', 'session-work', 'session:test'],
  });
  // Manually update kind/retention/updatedAt by writing the board directly.
  const existing = await getBoard(tmpDir, board.id);
  if (!existing) throw new Error('Board not created');
  existing.kind = (opts.kind ?? 'session_mirror') as never;
  existing.retention = (opts.retention ?? {
    mode: 'archive_after_ttl',
    ttlMs: 1000,
  }) as never;
  if (opts.updatedAt) existing.updatedAt = opts.updatedAt;
  await writeBoard(tmpDir, existing);
  return board.id;
}

describe('pruneSessionBoards', () => {
  it('archives session mirrors past their TTL (archive_after_ttl)', async () => {
    const expiredId = await createSessionBoard({
      retention: { mode: 'archive_after_ttl', ttlMs: 1000 },
      updatedAt: '2020-01-01T00:00:00.000Z',
    });

    const result = await pruneSessionBoards(tmpDir, { now: '2026-08-01T00:00:00.000Z' });

    expect(result.archived).toContain(expiredId);
    expect(result.deleted).toHaveLength(0);

    // Board should now have kind 'archive' and archivedAt set.
    const archived = await getBoard(tmpDir, expiredId);
    expect(archived?.kind).toBe('archive');
    expect(archived?.retention?.archivedAt).toBeDefined();
  });

  it('deletes session mirrors past their TTL (delete_after_ttl)', async () => {
    const expiredId = await createSessionBoard({
      retention: { mode: 'delete_after_ttl', ttlMs: 1000 },
      updatedAt: '2020-01-01T00:00:00.000Z',
    });

    const result = await pruneSessionBoards(tmpDir, { now: '2026-08-01T00:00:00.000Z' });

    expect(result.deleted).toContain(expiredId);
    expect(result.archived).toHaveLength(0);

    // Board should be gone.
    const gone = await getBoard(tmpDir, expiredId);
    expect(gone).toBeNull();
  });

  it('skips session mirrors within TTL', async () => {
    const freshId = await createSessionBoard({
      retention: { mode: 'archive_after_ttl', ttlMs: 999_999_999 },
      updatedAt: '2026-07-31T00:00:00.000Z',
    });

    const result = await pruneSessionBoards(tmpDir, { now: '2026-08-01T00:00:00.000Z' });

    expect(result.skipped).toContain(freshId);
    expect(result.archived).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);

    // Board unchanged.
    const board = await getBoard(tmpDir, freshId);
    expect(board?.kind).toBe('session_mirror');
  });

  it('skips session mirrors with retention mode keep', async () => {
    const keepId = await createSessionBoard({
      retention: { mode: 'keep' },
      updatedAt: '2020-01-01T00:00:00.000Z',
    });

    const result = await pruneSessionBoards(tmpDir, { now: '2026-08-01T00:00:00.000Z' });

    expect(result.skipped).toContain(keepId);
    expect(result.archived).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  it('skips non-session boards', async () => {
    const projectBoard = await createBoard(tmpDir, { title: 'Project Board' });
    // Project boards have kind 'project' — no retention policy.
    const result = await pruneSessionBoards(tmpDir, { now: '2026-08-01T00:00:00.000Z' });

    expect(result.skipped).toContain(projectBoard.id);
    expect(result.archived).not.toContain(projectBoard.id);
    expect(result.deleted).not.toContain(projectBoard.id);
  });

  it('skips already-archived boards', async () => {
    const archivedId = await createSessionBoard({
      retention: { mode: 'archive_after_ttl', ttlMs: 1000, archivedAt: '2026-01-01T00:00:00.000Z' },
      updatedAt: '2020-01-01T00:00:00.000Z',
    });

    const result = await pruneSessionBoards(tmpDir, { now: '2026-08-01T00:00:00.000Z' });

    expect(result.skipped).toContain(archivedId);
    expect(result.archived).not.toContain(archivedId);
  });

  it('handles mixed boards in one pass', async () => {
    const expiredArchive = await createSessionBoard({
      retention: { mode: 'archive_after_ttl', ttlMs: 1000 },
      updatedAt: '2020-01-01T00:00:00.000Z',
    });
    const expiredDelete = await createSessionBoard({
      retention: { mode: 'delete_after_ttl', ttlMs: 1000 },
      updatedAt: '2020-01-01T00:00:00.000Z',
    });
    const fresh = await createSessionBoard({
      retention: { mode: 'archive_after_ttl', ttlMs: 999_999_999 },
      updatedAt: '2026-07-31T00:00:00.000Z',
    });
    const project = await createBoard(tmpDir, { title: 'Project' });

    const result = await pruneSessionBoards(tmpDir, { now: '2026-08-01T00:00:00.000Z' });

    expect(result.archived).toContain(expiredArchive);
    expect(result.deleted).toContain(expiredDelete);
    expect(result.skipped).toContain(fresh);
    expect(result.skipped).toContain(project.id);
  });
});
