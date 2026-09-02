import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HqKanbanSnapshotPayload, HqPublisher } from '@wrongstack/core/hq';
import { readBoard, readKanbanMetadata, writeBoard, writeKanbanMetadata } from '@wrongstack/kanban';
import { createBoardObject } from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKanbanHqSync } from '../src/kanban-hq-sync.js';

const atomicWriteFs = vi.hoisted(() => ({
  actualRename: undefined as typeof import('node:fs/promises').rename | undefined,
  rename: vi.fn<typeof import('node:fs/promises').rename>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  atomicWriteFs.actualRename = actual.rename;
  return { ...actual, rename: atomicWriteFs.rename };
});

/** The publisher's shipped default; the sync reads it to size boards for HQ. */
const DEFAULT_POLICY = { rawContent: true, toolArgs: 'full', paths: 'full' } as const;

const roots: string[] = [];
const realSetTimeout = globalThis.setTimeout;

async function waitForCondition(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) {
    await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  }
  expect(condition(), message).toBe(true);
}

beforeEach(() => {
  if (atomicWriteFs.actualRename === undefined)
    throw new Error('fs.rename mock was not initialized');
  atomicWriteFs.rename.mockReset().mockImplementation(atomicWriteFs.actualRename);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.useRealTimers();
});

/**
 * A board that is over HQ's per-board limit for a reason redaction cannot fix.
 *
 * Size has to come from MANY cards, not one long field: the publisher
 * summarises any string over 100 KB before sending, so a single giant string
 * shrinks on the wire and the board arrives fine. Only a board whose bulk is
 * spread across ordinary-sized cards stays over the limit.
 */
function oversizedBoardObject(title: string) {
  const board = createBoardObject({ title });
  const filler = 'card body '.repeat(120);
  let index = 0;
  while (Buffer.byteLength(JSON.stringify(board), 'utf8') <= 750_000) {
    board.tasks.push({
      id: `bulk-${index}`,
      title: `Bulk card ${index}`,
      description: `${filler}#${index}`,
      columnId: board.columns[0]?.id ?? 'todo',
      order: index,
      priority: 'medium',
      status: 'pending',
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    } as (typeof board.tasks)[number]);
    index += 1;
  }
  return board;
}

async function tempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-hq-client-'));
  roots.push(root);
  return root;
}

describe('CLI Kanban HQ synchronization', () => {
  it('publishes local boards on attach', async () => {
    const root = await tempProject();
    const board = createBoardObject({ title: 'Local' });
    await writeBoard(root, board);
    const publishEvent = vi.fn();
    const sync = createKanbanHqSync(root);

    await sync.attachPublisher({
      publishEvent,
      redactionPolicy: DEFAULT_POLICY,
    } as unknown as HqPublisher);

    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'kanban.snapshot',
        payload: expect.objectContaining({
          boards: [expect.objectContaining({ boardId: board.id, revision: 0 })],
        }),
      }),
    );
    sync.stop();
  });

  it('chunks large local snapshots below the HQ websocket payload limit', async () => {
    const root = await tempProject();
    for (let index = 0; index < 40; index++) {
      const board = createBoardObject({ title: `Board ${index}` });
      board.description = `${index}:`.padEnd(20_000, 'x');
      await writeBoard(root, board);
    }
    const publishEvent = vi.fn();
    const sync = createKanbanHqSync(root, 'large-project');

    await sync.attachPublisher({
      publishEvent,
      redactionPolicy: DEFAULT_POLICY,
    } as unknown as HqPublisher);

    const calls = publishEvent.mock.calls.map(
      ([input]) => input as { payload: HqKanbanSnapshotPayload },
    );
    expect(calls.length).toBeGreaterThan(1);
    const boardIds = calls.flatMap(({ payload }) => payload.boards.map((board) => board.boardId));
    expect(boardIds).toHaveLength(40);
    expect(new Set(boardIds)).toHaveProperty('size', 40);
    for (const { payload } of calls) {
      expect(payload.boards.length + payload.tombstones.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(512 * 1024);
    }
    sync.stop();
  });

  it('warns when one board cannot fit below the snapshot chunk target', async () => {
    const root = await tempProject();
    const board = createBoardObject({ title: 'Oversized' });
    board.description = 'x'.repeat(600_000);
    await writeBoard(root, board);
    const publishEvent = vi.fn();
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const sync = createKanbanHqSync(root, 'oversized-project');

    try {
      await sync.attachPublisher({
        publishEvent,
        redactionPolicy: DEFAULT_POLICY,
      } as unknown as HqPublisher);

      expect(warning).toHaveBeenCalledWith(expect.stringContaining(board.id), {
        code: 'WRONGSTACK_HQ_KANBAN_OVERSIZED_RECORD',
      });
      const event = publishEvent.mock.calls[0]?.[0] as
        | { payload: HqKanbanSnapshotPayload }
        | undefined;
      if (event === undefined) throw new Error('expected oversized snapshot publish');
      expect(Buffer.byteLength(JSON.stringify(event.payload), 'utf8')).toBeGreaterThan(512 * 1024);
    } finally {
      warning.mockRestore();
      sync.stop();
    }
  });

  it('skips a board HQ would reject, and still publishes the rest of the round', async () => {
    // `isHqKanbanSnapshotPayload` rejects the WHOLE snapshot when one board
    // record exceeds MAX_HQ_KANBAN_BOARD_BYTES, and HQ drops a rejected frame
    // with no reply — so the board silently stopped appearing in HQ and the
    // fingerprint said it had been sent.
    const root = await tempProject();
    const huge = oversizedBoardObject('Huge');
    await writeBoard(root, huge);
    const small = createBoardObject({ title: 'Small' });
    await writeBoard(root, small);
    const publishEvent = vi.fn();
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const sync = createKanbanHqSync(root, 'dropped-project');

    try {
      await sync.attachPublisher({
        publishEvent,
        redactionPolicy: DEFAULT_POLICY,
      } as unknown as HqPublisher);

      expect(warning).toHaveBeenCalledWith(expect.stringContaining(huge.id), {
        code: 'WRONGSTACK_HQ_KANBAN_BOARD_DROPPED',
      });
      const published = publishEvent.mock.calls
        .map(([input]) => input as { payload: HqKanbanSnapshotPayload })
        .flatMap(({ payload }) => payload.boards.map((board) => board.boardId));
      expect(published).toContain(small.id);
      expect(published).not.toContain(huge.id);
    } finally {
      warning.mockRestore();
      sync.stop();
    }
  });

  it('publishes a board that only redaction can shrink', async () => {
    // The publisher summarises any string over 100 KB before sending, so a
    // board that is large because of ONE long field fits on the wire and must
    // not be skipped. Measuring the raw board dropped it — trading a truncated
    // description for a board that never appears at all.
    const root = await tempProject();
    const board = createBoardObject({ title: 'One long field' });
    board.description = 'x'.repeat(800_000);
    await writeBoard(root, board);
    const publishEvent = vi.fn();
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const sync = createKanbanHqSync(root, 'long-field-project');

    try {
      await sync.attachPublisher({
        publishEvent,
        redactionPolicy: DEFAULT_POLICY,
      } as unknown as HqPublisher);
      const published = publishEvent.mock.calls
        .map(([input]) => input as { payload: HqKanbanSnapshotPayload })
        .flatMap(({ payload }) => payload.boards.map((record) => record.boardId));
      expect(published).toContain(board.id);
      expect(warning).not.toHaveBeenCalledWith(expect.anything(), {
        code: 'WRONGSTACK_HQ_KANBAN_BOARD_DROPPED',
      });
    } finally {
      warning.mockRestore();
      sync.stop();
    }
  });

  it('measures a board the way the publisher will redact it, not the generic way', async () => {
    // `kanban.snapshot` is a project-state event, so raw-content keys (`outcome`,
    // `body`, `text`…) SURVIVE redaction. The generic `redactHqValue` helper
    // replaces them with a short marker instead — so measuring through it under
    // a `rawContent: false` policy produced an estimate smaller than the real
    // payload, and an oversized board sailed past the check to be silently
    // rejected by HQ. This board hides its bulk in `outcome` fields.
    const root = await tempProject();
    const board = createBoardObject({ title: 'Raw content heavy' });
    const filler = 'outcome text '.repeat(90);
    let index = 0;
    while (Buffer.byteLength(JSON.stringify(board), 'utf8') <= 800_000) {
      board.tasks.push({
        id: `raw-${index}`,
        title: `Card ${index}`,
        outcome: `${filler}#${index}`,
        columnId: board.columns[0]?.id ?? 'todo',
        order: index,
        priority: 'medium',
        status: 'pending',
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:00.000Z',
      } as (typeof board.tasks)[number]);
      index += 1;
    }
    await writeBoard(root, board);
    const publishEvent = vi.fn();
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const sync = createKanbanHqSync(root, 'raw-content-project');

    try {
      await sync.attachPublisher({
        publishEvent,
        // The strict policy is the one that used to expose the mismatch.
        redactionPolicy: { rawContent: false, toolArgs: 'full', paths: 'full' },
      } as unknown as HqPublisher);

      const published = publishEvent.mock.calls
        .map(([input]) => input as { payload: HqKanbanSnapshotPayload })
        .flatMap(({ payload }) => payload.boards.map((record) => record.boardId));
      expect(published).not.toContain(board.id);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(board.id), {
        code: 'WRONGSTACK_HQ_KANBAN_BOARD_DROPPED',
      });
    } finally {
      warning.mockRestore();
      sync.stop();
    }
  });

  it('retries a skipped board on the next round instead of fingerprinting it as sent', async () => {
    // The fingerprint is what makes a delta a no-op next time. Writing it for a
    // board that never reached HQ turned a transient size problem into
    // permanent absence: the board would be skipped again on every later
    // publish, even after the operator archived cards and it shrank.
    const root = await tempProject();
    const board = oversizedBoardObject('Shrinking');
    await writeBoard(root, board);
    const publishEvent = vi.fn();
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const sync = createKanbanHqSync(root, 'retry-project');

    try {
      await sync.attachPublisher({
        publishEvent,
        redactionPolicy: DEFAULT_POLICY,
      } as unknown as HqPublisher);
      const state = JSON.parse(
        (await readKanbanMetadata(root, 'hq-sync-state-v1')) ?? '{"boards":{}}',
      ) as { boards: Record<string, unknown> };
      expect(state.boards[board.id]).toBeUndefined();

      // Same revision, now small enough. Nothing about the board's identity
      // changed — only its size — so a written fingerprint would have hidden it.
      const stored = await readBoard(root, board.id);
      if (stored === null) throw new Error('expected the board to still exist');
      stored.tasks = [];
      await writeBoard(root, stored);
      publishEvent.mockClear();
      sync.refresh(board.id);

      await waitForCondition(
        () =>
          publishEvent.mock.calls.some(([input]) =>
            (input as { payload: HqKanbanSnapshotPayload }).payload.boards.some(
              (record) => record.boardId === board.id,
            ),
          ),
        'expected the shrunken board to publish on the next round',
      );
    } finally {
      warning.mockRestore();
      sync.stop();
    }
  });

  it('prunes expired tombstones before replaying a full snapshot', async () => {
    const root = await tempProject();
    await writeKanbanMetadata(
      root,
      'hq-sync-state-v1',
      JSON.stringify({
        boards: { deleted: { revision: 2, updatedAt: '2020-01-01T00:00:00.000Z' } },
        tombstones: {
          deleted: { boardId: 'deleted', revision: 3, deletedAt: '2020-01-01T00:00:00.000Z' },
        },
      }),
    );
    const publishEvent = vi.fn();
    const sync = createKanbanHqSync(root, 'retention-project');

    await sync.attachPublisher({
      publishEvent,
      redactionPolicy: DEFAULT_POLICY,
    } as unknown as HqPublisher);

    const event = publishEvent.mock.calls[0]?.[0] as
      | { payload: HqKanbanSnapshotPayload }
      | undefined;
    if (event === undefined) throw new Error('expected retained snapshot publish');
    expect(event.payload.tombstones).toEqual([]);
    const rawState = await readKanbanMetadata(root, 'hq-sync-state-v1');
    if (rawState === null) throw new Error('expected SQLite sync metadata');
    const state = JSON.parse(rawState) as {
      boards: Record<string, unknown>;
      tombstones: Record<string, unknown>;
    };
    expect(state).toEqual({ boards: {}, tombstones: {} });
    sync.stop();
  });

  it('publishes only changed boards after the initial snapshot', async () => {
    const root = await tempProject();
    const changed = createBoardObject({ title: 'Changed later' });
    const untouched = createBoardObject({ title: 'Untouched' });
    await writeBoard(root, changed);
    await writeBoard(root, untouched);
    const publishEvent = vi.fn();
    const sync = createKanbanHqSync(root, 'delta-project');

    await sync.attachPublisher({
      publishEvent,
      redactionPolicy: DEFAULT_POLICY,
    } as unknown as HqPublisher);
    publishEvent.mockClear();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    changed.revision = 1;
    changed.updatedAt = '2026-07-23T08:00:00.000Z';
    changed.title = 'Changed now';
    await writeBoard(root, changed);
    sync.refresh(changed.id);
    await waitForCondition(
      () => vi.getTimerCount() > 0,
      'expected daemon event to schedule delta publish',
    );
    await vi.advanceTimersByTimeAsync(150);
    await waitForCondition(
      () => publishEvent.mock.calls.length > 0,
      'expected delta publish after advancing the debounce timer',
    );

    expect(publishEvent.mock.calls.length).toBe(1);

    const payloads = publishEvent.mock.calls.map(
      ([input]) => (input as { payload: HqKanbanSnapshotPayload }).payload,
    );
    expect(payloads).toHaveLength(1);
    expect(payloads.flatMap((payload) => payload.boards).map((board) => board.boardId)).toEqual([
      changed.id,
    ]);
    expect(payloads.flatMap((payload) => payload.tombstones)).toEqual([]);
    sync.stop();
  });

  it('keeps a one-board update bounded in a 1000-board project', async () => {
    const root = await tempProject();
    const kanbanDir = path.join(root, '.wrongstack', 'kanbans');
    await fs.mkdir(kanbanDir, { recursive: true });
    const boards = Array.from({ length: 1000 }, (_, index) => {
      const board = createBoardObject({ title: `Scale board ${index}` });
      board.description = `payload-${index}`.padEnd(2_000, 'x');
      return board;
    });
    await Promise.all(
      boards.map((board) =>
        fs.writeFile(path.join(kanbanDir, `${board.id}.json`), JSON.stringify(board), 'utf8'),
      ),
    );
    const publishEvent = vi.fn();
    const sync = createKanbanHqSync(root, 'scale-project');

    await sync.attachPublisher({
      publishEvent,
      redactionPolicy: DEFAULT_POLICY,
    } as unknown as HqPublisher);
    publishEvent.mockClear();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const changed = boards[500]!;
    changed.revision = 1;
    changed.updatedAt = '2026-07-23T08:01:00.000Z';
    changed.title = 'Only this board changed';
    await fs.writeFile(path.join(kanbanDir, `${changed.id}.json`), JSON.stringify(changed), 'utf8');
    sync.refresh(changed.id);
    await waitForCondition(
      () => vi.getTimerCount() > 0,
      'expected daemon event to schedule bounded delta publish',
    );
    await vi.advanceTimersByTimeAsync(150);
    await waitForCondition(
      () => publishEvent.mock.calls.length > 0,
      'expected bounded delta publish after advancing the debounce timer',
    );

    expect(publishEvent.mock.calls.length).toBe(1);

    const payloads = publishEvent.mock.calls.map(
      ([input]) => (input as { payload: HqKanbanSnapshotPayload }).payload,
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.boards.map((board) => board.boardId)).toEqual([changed.id]);
    expect(Buffer.byteLength(JSON.stringify(payloads[0]), 'utf8')).toBeLessThan(10_000);
    sync.stop();
  });

  it('serializes simultaneous initial publish and remote snapshot state writes', async () => {
    const root = await tempProject();
    const publishEvent = vi.fn();
    const sync = createKanbanHqSync(root, 'shared-project');
    const remoteBoard = createBoardObject({ title: 'Remote' });
    remoteBoard.revision = 1;
    remoteBoard.updatedAt = '2026-07-22T12:00:00Z';
    const remote: HqKanbanSnapshotPayload = {
      projectId: 'shared-project',
      generatedAt: '2026-07-22T12:00:00Z',
      boards: [
        {
          boardId: remoteBoard.id,
          revision: remoteBoard.revision,
          updatedAt: remoteBoard.updatedAt,
          board: { ...remoteBoard },
        },
      ],
      tombstones: [],
    };

    await Promise.all([
      sync.attachPublisher({ publishEvent } as unknown as HqPublisher),
      sync.handleRemote(remote),
    ]);

    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ boards: [] }),
      }),
    );
    expect((await readBoard(root, remoteBoard.id))?.title).toBe('Remote');
    await expect(readKanbanMetadata(root, 'hq-sync-state-v1')).resolves.toContain('"boards"');
    sync.stop();
  });

  it('persists sync state without filesystem rename seams', async () => {
    const root = await tempProject();
    const sync = createKanbanHqSync(root, 'shared-project');
    const publishEvent = vi.fn();
    await sync.attachPublisher({
      publishEvent,
      redactionPolicy: DEFAULT_POLICY,
    } as unknown as HqPublisher);

    try {
      await expect(
        sync.handleRemote({
          projectId: 'shared-project',
          generatedAt: '2026-07-22T12:00:00Z',
          boards: [],
          tombstones: [],
        }),
      ).resolves.toBeUndefined();

      expect(atomicWriteFs.rename).not.toHaveBeenCalled();
      await expect(readKanbanMetadata(root, 'hq-sync-state-v1')).resolves.toContain('"boards"');
    } finally {
      sync.stop();
    }
  });

  it('applies newer HQ boards but preserves newer local revisions', async () => {
    const root = await tempProject();
    const local = createBoardObject({ title: 'Local' });
    local.revision = 3;
    local.updatedAt = '2026-07-22T12:03:00Z';
    await writeBoard(root, local);
    const sync = createKanbanHqSync(root);

    const payload = (revision: number, title: string): HqKanbanSnapshotPayload => ({
      projectId: projectId(root),
      generatedAt: '2026-07-22T12:05:00Z',
      boards: [
        {
          boardId: local.id,
          revision,
          updatedAt: `2026-07-22T12:0${revision}:00Z`,
          board: { ...local, revision, title, updatedAt: `2026-07-22T12:0${revision}:00Z` },
        },
      ],
      tombstones: [],
    });

    await sync.handleRemote(payload(2, 'Stale'));
    expect((await readBoard(root, local.id))?.title).toBe('Local');
    await sync.handleRemote(payload(4, 'Remote'));
    expect((await readBoard(root, local.id))?.title).toBe('Remote');
    sync.stop();
  });

  it('coalesces remote snapshots that arrive while an apply is pending', async () => {
    const root = await tempProject();
    const sync = createKanbanHqSync(root, 'coalesce-project');
    const board = createBoardObject({ title: 'Seed' });

    const payload = (revision: number, title: string): HqKanbanSnapshotPayload => ({
      projectId: 'coalesce-project',
      generatedAt: `2026-07-22T12:0${revision}:00Z`,
      boards: [
        {
          boardId: board.id,
          revision,
          updatedAt: `2026-07-22T12:0${revision}:00Z`,
          board: { ...board, revision, title, updatedAt: `2026-07-22T12:0${revision}:00Z` },
        },
      ],
      tombstones: [],
    });

    // Fire both before either apply pass runs: the second snapshot must fold
    // into the pending batch (highest revision wins) instead of chaining a
    // second apply — the unbounded chain is what used to retain every
    // full-project payload in memory during broadcast bursts.
    atomicWriteFs.rename.mockClear();
    const first = sync.handleRemote(payload(2, 'Stale'));
    const second = sync.handleRemote(payload(4, 'Remote'));
    await Promise.all([first, second]);

    expect((await readBoard(root, board.id))?.title).toBe('Remote');
    // Exactly one write of the board file: the rev-2 record was superseded
    // before the (single) apply pass ran, so it never touched disk.
    const boardWrites = atomicWriteFs.rename.mock.calls.filter(([, target]) =>
      String(target).includes(board.id),
    );
    expect(boardWrites).toHaveLength(1);
    sync.stop();
  });

  it('keeps local publishes single-flight and retains one trailing batch', async () => {
    const root = await tempProject();
    const board = createBoardObject({ title: 'Slow local publish' });
    await writeBoard(root, board);
    let releaseSlowPublish!: () => void;
    let blockNextPublish = false;
    const slowPublish = new Promise<void>((resolve) => {
      releaseSlowPublish = resolve;
    });
    const sync = createKanbanHqSync(root, 'single-flight-project', {
      beforeLocalPublish: async () => {
        if (blockNextPublish) await slowPublish;
      },
    });
    await sync.attachPublisher({ publishEvent: vi.fn() } as unknown as HqPublisher);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    blockNextPublish = true;
    sync.refresh(board.id);
    await vi.advanceTimersByTimeAsync(150);
    await waitForCondition(
      () => sync.getStats().localPublishActive,
      'expected first local publish to remain active',
    );

    for (let index = 0; index < 5_000; index++) sync.refresh(board.id);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync.getStats()).toMatchObject({
      localPublishActive: true,
      pendingBoardIds: 1,
      localPublishRuns: 1,
      coalescedLocalRefreshes: 5_000,
    });

    blockNextPublish = false;
    releaseSlowPublish();
    await waitForCondition(
      () => !sync.getStats().localPublishActive && vi.getTimerCount() > 0,
      'expected one trailing local publish timer',
    );
    await vi.advanceTimersByTimeAsync(150);
    await waitForCondition(
      () => sync.getStats().localPublishRuns === 2 && !sync.getStats().localPublishActive,
      'expected exactly one trailing local publish',
    );
    expect(sync.getStats()).toMatchObject({
      pendingBoardIds: 0,
      localPublishRuns: 2,
      coalescedLocalRefreshes: 5_000,
    });
    sync.stop();
  });

  it('ignores remote snapshots for other projects', async () => {
    const root = await tempProject();
    const sync = createKanbanHqSync(root, 'this-project');
    const board = createBoardObject({ title: 'Foreign' });

    await sync.handleRemote({
      projectId: 'other-project',
      generatedAt: '2026-07-22T12:00:00Z',
      boards: [
        {
          boardId: board.id,
          revision: 1,
          updatedAt: '2026-07-22T12:00:00Z',
          board: { ...board, revision: 1 },
        },
      ],
      tombstones: [],
    });

    expect(await readBoard(root, board.id)).toBeNull();
    sync.stop();
  });
});

function projectId(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12);
}
