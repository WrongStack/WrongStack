import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HqKanbanSnapshotPayload, HqPublisher } from '@wrongstack/hq';
import { writeBoard } from '@wrongstack/kanban';
import { createBoardObject } from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKanbanHqSync } from '../src/kanban-hq-sync.js';

const fsHooks = vi.hoisted(() => ({
  actualRename: undefined as typeof import('node:fs/promises').rename | undefined,
  rename: vi.fn<typeof import('node:fs/promises').rename>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsHooks.actualRename = actual.rename;
  return { ...actual, rename: fsHooks.rename };
});

const DEFAULT_POLICY = { rawContent: true, toolArgs: 'full', paths: 'full' } as const;
const roots: string[] = [];
const realSetTimeout = globalThis.setTimeout;

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  }
  expect(condition(), message).toBe(true);
}

beforeEach(() => {
  if (fsHooks.actualRename === undefined) throw new Error('fs.rename mock was not initialized');
  fsHooks.rename.mockReset().mockImplementation(fsHooks.actualRename);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.useRealTimers();
});

// Regression: `schedulePublish` returned early while a remote snapshot was
// being applied, so a genuine local edit landing in that window was neither
// published nor marked pending — HQ never saw it until some later change.
describe('Kanban HQ sync local edits during a remote apply', () => {
  it('publishes a local board change that lands while a remote snapshot applies', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-hq-window-'));
    roots.push(root);
    const remoteBoard = createBoardObject({ title: 'Remote seed' });
    const localBoard = createBoardObject({ title: 'Local' });
    await writeBoard(root, localBoard);

    const publishEvent = vi.fn();
    const sync = createKanbanHqSync(root, 'window-project');
    await sync.attachPublisher({
      publishEvent,
      redactionPolicy: DEFAULT_POLICY,
    } as unknown as HqPublisher);
    publishEvent.mockClear();

    // Hold the remote board's write so the apply pass stays in flight.
    let releaseRemoteWrite!: () => void;
    const remoteWriteHeld = new Promise<void>((resolve) => {
      releaseRemoteWrite = resolve;
    });
    let remoteWriteStarted = false;
    fsHooks.rename.mockImplementation(async (from, to) => {
      if (String(to).includes(remoteBoard.id)) {
        remoteWriteStarted = true;
        await remoteWriteHeld;
      }
      return fsHooks.actualRename!(from, to);
    });

    const applying = sync.handleRemote({
      projectId: 'window-project',
      generatedAt: '2026-11-08T12:00:00Z',
      boards: [
        {
          boardId: remoteBoard.id,
          revision: 3,
          updatedAt: '2026-11-08T12:00:00Z',
          board: { ...remoteBoard, revision: 3, updatedAt: '2026-11-08T12:00:00Z' },
        },
      ],
      tombstones: [],
    } as HqKanbanSnapshotPayload);
    await waitFor(() => remoteWriteStarted, 'expected the remote apply to reach its board write');

    // A real local edit, on another board, while the apply is in flight.
    localBoard.revision = 1;
    localBoard.title = 'Local edited during remote apply';
    localBoard.updatedAt = '2026-11-08T12:00:01.000Z';
    await writeBoard(root, localBoard);
    sync.refresh(localBoard.id);

    releaseRemoteWrite();
    await applying;

    const publishedLocal = (): boolean =>
      publishEvent.mock.calls.some(([input]) =>
        (input as { payload: HqKanbanSnapshotPayload }).payload.boards.some(
          (board) => board.boardId === localBoard.id,
        ),
      );
    await waitFor(publishedLocal, 'expected the local edit to reach HQ after the remote apply');
    sync.stop();
  });
});
