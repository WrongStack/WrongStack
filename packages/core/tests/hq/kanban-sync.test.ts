import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HqKanbanStore, MAX_HQ_KANBAN_CACHE_PROJECTS } from '../../src/hq/kanban-store.js';
import { isHqKanbanSnapshotPayload } from '../../src/hq/protocol.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function board(boardId: string, revision: number, updatedAt: string) {
  return { boardId, revision, updatedAt, board: { id: boardId, title: `r${revision}` } };
}

function snapshot(
  boards: ReturnType<typeof board>[],
  tombstones: Array<{ boardId: string; revision: number; deletedAt: string }> = [],
  projectId = 'project-1',
) {
  return {
    projectId,
    generatedAt: '2026-07-22T12:00:00.000Z',
    boards,
    tombstones,
  };
}

describe('HQ Kanban snapshots', () => {
  it('validates bounded project snapshots', () => {
    expect(isHqKanbanSnapshotPayload(snapshot([board('board-1', 1, '2026-07-22T12:00:00Z')]))).toBe(
      true,
    );
    expect(
      isHqKanbanSnapshotPayload(snapshot([board('../escape', 1, '2026-07-22T12:00:00Z')])),
    ).toBe(false);
    expect(
      isHqKanbanSnapshotPayload(snapshot([board('board-1', -1, '2026-07-22T12:00:00Z')])),
    ).toBe(false);
  });

  it('keeps the newest revision and persists it across store instances', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-kanban-'));
    dirs.push(dir);
    const store = new HqKanbanStore(dir);
    await store.merge(snapshot([board('board-1', 3, '2026-07-22T12:03:00Z')]));
    const merged = await store.merge(snapshot([board('board-1', 2, '2026-07-22T12:04:00Z')]));
    expect(merged.boards[0]?.revision).toBe(3);
    await store.drain();
    expect((await new HqKanbanStore(dir).load('project-1')).boards[0]?.revision).toBe(3);
  });

  it('uses timestamps for equal revisions and lets a tombstone win exact ties', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-kanban-'));
    dirs.push(dir);
    const store = new HqKanbanStore(dir);
    await store.merge(snapshot([board('board-1', 2, '2026-07-22T12:00:00Z')]));
    await store.merge(snapshot([board('board-1', 2, '2026-07-22T12:01:00Z')]));
    const merged = await store.merge(
      snapshot([], [{ boardId: 'board-1', revision: 2, deletedAt: '2026-07-22T12:01:00Z' }]),
    );
    expect(merged.boards).toEqual([]);
    expect(merged.tombstones[0]?.boardId).toBe('board-1');
    await store.drain();
  });

  it('bounds retained project snapshots and releases idle writer queues', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-kanban-bounded-'));
    dirs.push(dir);
    const store = new HqKanbanStore(dir);
    await Promise.all(
      Array.from({ length: MAX_HQ_KANBAN_CACHE_PROJECTS + 8 }, (_, index) =>
        store.merge(
          snapshot([board(`board-${index}`, 1, '2026-07-22T12:00:00Z')], [], `project-${index}`),
        ),
      ),
    );
    await store.drain();

    const internals = store as unknown as {
      cache: Map<string, unknown>;
      writers: Map<string, unknown>;
    };
    expect(internals.cache.size).toBeLessThanOrEqual(MAX_HQ_KANBAN_CACHE_PROJECTS);
    expect(internals.writers.size).toBe(0);
  });
});
