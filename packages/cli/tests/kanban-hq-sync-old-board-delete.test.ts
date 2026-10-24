import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HqPublisher } from '@wrongstack/hq';
import { deleteBoard, readBoard, writeBoard } from '@wrongstack/kanban';
import { createBoardObject } from '@wrongstack/kanban/test-support';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKanbanHqSync } from '../src/kanban-hq-sync.js';

const POLICY = { rawContent: true, toolArgs: 'full', paths: 'full' } as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/**
 * Publishes a board, deletes it locally, rescans, then plays HQ: a board HQ got
 * a tombstone for is gone from its next snapshot; any other board is still in it.
 */
async function deleteAfterPublish(updatedAt: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-hq-old-delete-'));
  roots.push(root);
  const board = createBoardObject({ title: 'Board' });
  board.updatedAt = updatedAt;
  await writeBoard(root, board);
  const sync = createKanbanHqSync(root);
  const publishEvent = vi.fn();
  const publisher = { publishEvent, redactionPolicy: POLICY } as unknown as HqPublisher;
  await sync.attachPublisher(publisher);
  const published = publishEvent.mock.calls[0]?.[0]?.payload?.boards?.[0];
  await deleteBoard(root, board.id);
  publishEvent.mockClear();
  await sync.attachPublisher(publisher);
  const tombstoned = publishEvent.mock.calls
    .flatMap((call) => call[0].payload.tombstones)
    .some((t: { boardId: string }) => t.boardId === board.id);
  await sync.handleRemote({
    projectId: createHash('sha256').update(root).digest('hex').slice(0, 12),
    generatedAt: new Date().toISOString(),
    boards: published && !tombstoned ? [published] : [],
    tombstones: [],
  });
  const resurrected = (await readBoard(root, board.id)) !== null;
  sync.stop();
  return { tombstoned, resurrected };
}

describe('CLI Kanban HQ synchronization — deleting an old board (F519)', () => {
  it('tombstones a recently updated board', async () => {
    expect(await deleteAfterPublish(new Date().toISOString())).toEqual({
      tombstoned: true,
      resurrected: false,
    });
  });

  it('ignores a remote board no newer than our deletion tombstone (F520)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-hq-stale-'));
    roots.push(root);
    const board = createBoardObject({ title: 'Board' });
    await writeBoard(root, board);
    const sync = createKanbanHqSync(root);
    const publishEvent = vi.fn();
    const publisher = { publishEvent, redactionPolicy: POLICY } as unknown as HqPublisher;
    await sync.attachPublisher(publisher);
    const published = publishEvent.mock.calls[0]?.[0]?.payload?.boards?.[0];
    await deleteBoard(root, board.id);
    await sync.attachPublisher(publisher);
    // A snapshot HQ built before merging the tombstone: pre-deletion revision.
    await sync.handleRemote({
      projectId: createHash('sha256').update(root).digest('hex').slice(0, 12),
      generatedAt: new Date().toISOString(),
      boards: [published],
      tombstones: [],
    });
    expect(await readBoard(root, board.id)).toBeNull();
    sync.stop();
  });

  it('tombstones a board last updated 30+ days ago instead of letting HQ restore it', async () => {
    expect(await deleteAfterPublish('2020-01-01T00:00:00.000Z')).toEqual({
      tombstoned: true,
      resurrected: false,
    });
  });
});
