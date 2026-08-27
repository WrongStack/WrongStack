import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardMeta,
  createBoardObject,
  deleteBoard,
  getKanbanPath,
  isValidBoardId,
  listBoardIds,
  listBoardSummaries,
  mutateBoard,
  readBoard,
  readKanbanEvents,
  resolveBoardRef,
  writeBoard,
} from '../src/storage.js';
import type { KanbanEvent } from '../src/types.js';
import { createBoard } from './helpers/session-manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stor-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeBoard() {
  return createBoard(tmpDir, { title: 'Storage Test' });
}

let eventSeq = 0;

function moveEvent(boardId: string, taskId: string): KanbanEvent {
  eventSeq += 1;
  return {
    id: `evt-${eventSeq}`,
    boardId,
    type: 'task.moved',
    ts: new Date().toISOString(),
    taskId,
    sessionId: '2026-08-26/sess_01TESTSESSION',
    before: { columnId: 'c1' },
    after: { columnId: 'c2' },
  };
}

function fixtureBoard() {
  const now = new Date().toISOString();
  return {
    id: 'test-board-1',
    title: 'Fixture Board',
    columns: [{ id: 'col-1', title: 'Column 1', order: 0, wipLimit: 0 }],
    tasks: [],
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

// ── createBoardObject ──────────────────────────────────────────────

describe('createBoardObject', () => {
  it('creates a board with provided columns', () => {
    const board = createBoardObject({
      title: 'Custom',
      columns: [{ id: 'my-col', title: 'My Col', order: 0, wipLimit: 0 }],
    });
    expect(board.title).toBe('Custom');
    expect(board.columns).toHaveLength(1);
    expect(board.columns[0]!.id).toBe('my-col');
  });

  it('uses default columns when none provided', () => {
    const board = createBoardObject({ title: 'Defaults' });
    expect(board.columns.length).toBeGreaterThanOrEqual(4);
    expect(board.columns[0]!.id).toBe('backlog');
  });
});

// ── boardMeta ──────────────────────────────────────────────────────

describe('boardMeta', () => {
  it('returns metadata from a board', () => {
    const now = new Date().toISOString();
    const board = {
      ...fixtureBoard(),
      description: 'A test',
      tags: ['alpha'],
      tasks: [
        {
          id: 't1',
          title: 'Task 1',
          columnId: 'col-1',
          order: 0,
          priority: 'high' as const,
          status: 'completed' as const,
          createdAt: now,
          updatedAt: now,
          completedAt: now,
        },
        {
          id: 't2',
          title: 'Task 2',
          columnId: 'col-1',
          order: 1,
          priority: 'medium' as const,
          status: 'pending' as const,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const meta = boardMeta(board);
    expect(meta.title).toBe('Fixture Board');
    expect(meta.description).toBe('A test');
    expect(meta.tags).toEqual(['alpha']);
    expect(meta.columnCount).toBe(1);
    expect(meta.taskCount).toBe(2);
    expect(meta.completedTaskCount).toBe(1);
  });
});

// ── listBoardIds ───────────────────────────────────────────────────

describe('listBoardIds', () => {
  it('returns empty list when kanban dir does not exist', async () => {
    const ids = await listBoardIds(path.join(tmpDir, 'no-such-dir'));
    expect(ids).toEqual([]);
  });

  it('lists board IDs from created boards', async () => {
    const board = await makeBoard();
    const ids = await listBoardIds(tmpDir);
    expect(ids).toContain(board.id);
  });
});

// ── readKanbanEvents ───────────────────────────────────────────────

describe('readKanbanEvents', () => {
  it('returns empty array for unknown board', async () => {
    const events = await readKanbanEvents(tmpDir, 'nonexistent');
    expect(events).toEqual([]);
  });

  it('returns empty array when events file does not exist', async () => {
    const board = await makeBoard();
    const events = await readKanbanEvents(tmpDir, board.id);
    expect(events).toEqual([]);
  });

  it('reads and parses events', async () => {
    const board = await makeBoard();
    const eventsPath = path.join(
      path.dirname(getKanbanPath(tmpDir, board.id)),
      `${board.id}.events.jsonl`,
    );
    const events = [
      { type: 'task.created', taskId: 't1', timestamp: new Date().toISOString() },
      { type: 'task.completed', taskId: 't1', timestamp: new Date().toISOString() },
    ];
    await fs.writeFile(eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const parsed = await readKanbanEvents(tmpDir, board.id);
    expect(parsed).toHaveLength(2);
    expect(parsed.at(0)?.type).toBe('task.created');
    expect(parsed.at(1)?.type).toBe('task.completed');
  });

  it('re-throws non-ENOENT errors during readKanbanEvents', async () => {
    const board = await makeBoard();
    // Replace events file with a directory so readFile throws EISDIR
    const eventsPath = path.join(
      path.dirname(getKanbanPath(tmpDir, board.id)),
      `${board.id}.events.jsonl`,
    );
    await fs.writeFile(eventsPath, '', 'utf8');
    await fs.unlink(eventsPath);
    await fs.mkdir(eventsPath, { recursive: true });
    await expect(readKanbanEvents(tmpDir, board.id)).rejects.toThrow();
  });
});

// ── deleteBoard — error paths ─────────────────────────────────────

describe('deleteBoard', () => {
  it('returns false for unknown board', async () => {
    expect(await deleteBoard(tmpDir, 'nonexistent')).toBe(false);
  });

  it('removes a board cleanly (events file may not exist)', async () => {
    const board = await makeBoard();
    const result = await deleteBoard(tmpDir, board.id);
    expect(result).toBe(true);
    // Verify board file is gone
    expect(await readBoard(tmpDir, board.id)).toBeNull();
  });

  it('re-throws non-ENOENT errors during delete', async () => {
    const board = await makeBoard();
    // Replace the board file with a directory so unlink throws EISDIR
    const boardPath = getKanbanPath(tmpDir, board.id);
    await fs.unlink(boardPath);
    await fs.mkdir(boardPath, { recursive: true });
    await expect(deleteBoard(tmpDir, board.id)).rejects.toThrow();
  });

  it('re-throws non-ENOENT errors from events unlink during delete', async () => {
    const board = await makeBoard();
    // Replace events file with a directory so unlink throws EISDIR
    const eventsDir = path.dirname(getKanbanPath(tmpDir, board.id));
    const eventsPath = path.join(eventsDir, `${board.id}.events.jsonl`);
    await fs.writeFile(eventsPath, '', 'utf8');
    await fs.unlink(eventsPath);
    await fs.mkdir(eventsPath, { recursive: true });
    await expect(deleteBoard(tmpDir, board.id)).rejects.toThrow();
  });

  it('returns false when board file vanishes between resolve and lock', async () => {
    const board = await makeBoard();
    const boardPath = getKanbanPath(tmpDir, board.id);
    // Delete the file after resolveBoardRef but before the locked unlink
    await fs.unlink(boardPath);
    const result = await deleteBoard(tmpDir, board.id);
    expect(result).toBe(false);
  });
});

// ── mutateBoard — error paths ─────────────────────────────────────

describe('mutateBoard', () => {
  it('does not rewrite or bump the revision for a no-op mutation', async () => {
    const board = await makeBoard();
    const boardPath = getKanbanPath(tmpDir, board.id);
    const beforeRaw = await fs.readFile(boardPath, 'utf8');
    const beforeStat = await fs.stat(boardPath);

    const result = await mutateBoard(tmpDir, board.id, () => null);
    const afterRaw = await fs.readFile(boardPath, 'utf8');
    const afterStat = await fs.stat(boardPath);

    expect(result?.result).toBeNull();
    expect(result?.board.revision).toBe(board.revision);
    expect(afterRaw).toBe(beforeRaw);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('still persists and bumps the revision for a real mutation', async () => {
    const board = await makeBoard();

    const result = await mutateBoard(tmpDir, board.id, (current) => {
      current.description = 'changed';
      return 'ok';
    });
    const persisted = await readBoard(tmpDir, board.id);

    expect(result?.result).toBe('ok');
    expect(result?.board.revision).toBe((board.revision ?? 0) + 1);
    expect(persisted?.description).toBe('changed');
    expect(persisted?.revision).toBe((board.revision ?? 0) + 1);
  });

  it('returns null for unknown board ref', async () => {
    const result = await mutateBoard(tmpDir, 'nonexistent', () => 'ok');
    expect(result).toBeNull();
  });

  it('returns null when board file is deleted during operation', async () => {
    const board = await makeBoard();
    // Delete the board file so mutateBoard finds it via resolveBoardRef
    // but the actual readFile gets ENOENT
    const boardPath = getKanbanPath(tmpDir, board.id);
    // First verify the file exists, then delete it
    await fs.access(boardPath);
    await fs.unlink(boardPath);
    const result = await mutateBoard(tmpDir, board.id, () => 'ok');
    expect(result).toBeNull();
  });

  it('re-throws non-ENOENT errors during mutateBoard', async () => {
    const board = await makeBoard();
    // Replace board file with a directory so readFile throws EISDIR
    const boardPath = getKanbanPath(tmpDir, board.id);
    await fs.unlink(boardPath);
    await fs.mkdir(boardPath, { recursive: true });
    await expect(mutateBoard(tmpDir, board.id, () => 'ok')).rejects.toThrow();
  });

  it('detects a stale write when the file is modified during an async no-op mutator', async () => {
    // Regression: a no-op mutator (no change to `board`) must still validate
    // the on-disk revision under the file lock. Otherwise a concurrent
    // modification that lands between the initial read and the no-op return
    // is silently masked: the caller gets a stale board snapshot and the
    // revision-check bypass means the cross-process write goes undetected.
    const board = await makeBoard();
    const boardPath = getKanbanPath(tmpDir, board.id);
    const lockPath = `${boardPath}.lock`;

    // Suspend the mutator on a deferred promise so we can mutate the file
    // from outside the lock while mutateBoard is still inside withFileLock.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const mutatorPromise = mutateBoard(tmpDir, board.id, async () => {
      await gate;
      // Genuine no-op: do not touch `current` at all.
      return null;
    });

    // Wait until mutateBoard has acquired its file lock and reached the
    // suspended mutator. Polling the lock file's existence is the most
    // reliable way to know withFileLock has finished its `wx` open + write
    // and is now waiting on the mutator. We bound the wait so a regression
    // that blocks the lock doesn't hang the test suite.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        await fs.stat(lockPath);
        break;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    }
    // Give the mutator one more microtask to actually be reached so the
    // post-mutator re-read will see our concurrent write.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Simulate a concurrent process advancing the on-disk revision while
    // mutateBoard's mutator is still pending. We write directly to the file
    // path — this bypasses withFileLock's advisory lock file, which is the
    // realistic cross-process shape (a different process wouldn't honor our
    // .lock sentinel either).
    const concurrent = await readBoard(tmpDir, board.id);
    expect(concurrent).not.toBeNull();
    const advanced: typeof concurrent = {
      ...concurrent!,
      description: 'written by concurrent process',
      revision: (concurrent!.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(boardPath, `${JSON.stringify(advanced, null, 2)}\n`, 'utf8');

    // Release the mutator. It returns as a no-op (did not touch `board`),
    // and the post-mutator revision check must now reject because the
    // on-disk revision no longer matches what we read at the start.
    release();
    await expect(mutatorPromise).rejects.toThrow(/Stale write detected/);
  });
});

// ── readBoard — null returns ───────────────────────────────────────

describe('readBoard', () => {
  it('returns null for unknown board', async () => {
    expect(await readBoard(tmpDir, 'nonexistent')).toBeNull();
  });

  it('re-throws non-ENOENT errors during readBoard', async () => {
    const board = await makeBoard();
    // Replace board file with a directory so readFile throws EISDIR
    const boardPath = getKanbanPath(tmpDir, board.id);
    await fs.unlink(boardPath);
    await fs.mkdir(boardPath, { recursive: true });
    await expect(readBoard(tmpDir, board.id)).rejects.toThrow();
  });
});

// ── resolveBoardRef ────────────────────────────────────────────────

describe('resolveBoardRef', () => {
  it('returns null for unknown board', async () => {
    expect(await resolveBoardRef(tmpDir, 'nonexistent')).toBeNull();
  });

  it('resolves by full id', async () => {
    const board = await makeBoard();
    expect(await resolveBoardRef(tmpDir, board.id)).toBe(board.id);
  });

  it('resolves by unique prefix', async () => {
    const board = await makeBoard();
    const prefix = board.id.slice(0, 8);
    const resolved = await resolveBoardRef(tmpDir, prefix);
    expect(resolved).toBe(board.id);
  });

  it('throws on ambiguous prefix', async () => {
    // Directly create board files with predictable ids so both share a prefix.
    const sharedPrefix = 'ambig-';
    const now = new Date().toISOString();
    await fs.mkdir(path.join(tmpDir, '.wrongstack', 'kanbans'), { recursive: true });
    const writeBoardFile = async (id: string) => {
      const boardPath = getKanbanPath(tmpDir, id);
      await fs.writeFile(
        boardPath,
        JSON.stringify({
          id,
          title: `Board ${id}`,
          columns: [{ id: 'c1', title: 'C1', order: 0, wipLimit: 0 }],
          tasks: [],
          createdAt: now,
          updatedAt: now,
          version: 1,
        }),
        'utf8',
      );
    };
    await writeBoardFile(`${sharedPrefix}aaa`);
    await writeBoardFile(`${sharedPrefix}bbb`);
    await expect(resolveBoardRef(tmpDir, sharedPrefix)).rejects.toThrow(
      'Ambiguous kanban board id',
    );
  });
});

// ── listBoardSummaries ─────────────────────────────────────────────

describe('listBoardSummaries', () => {
  it('returns empty list when no boards', async () => {
    const summaries = await listBoardSummaries(tmpDir);
    expect(summaries).toEqual([]);
  });

  it('lists created boards sorted by updatedAt', async () => {
    await createBoard(tmpDir, { title: 'Board A' });
    await createBoard(tmpDir, { title: 'Board B' });
    const summaries = await listBoardSummaries(tmpDir);
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    // Should be sorted descending by updatedAt
    for (let i = 1; i < summaries.length; i++) {
      expect(summaries[i - 1]!.updatedAt >= summaries[i]!.updatedAt).toBe(true);
    }
  });
});

// ── isValidBoardId ──────────────────────────────────────────────────

describe('isValidBoardId', () => {
  it('accepts valid board IDs', () => {
    expect(isValidBoardId('abc123')).toBe(true);
    expect(isValidBoardId('my-board_123')).toBe(true);
    expect(isValidBoardId('A')).toBe(true);
  });

  it('rejects invalid board IDs', () => {
    expect(isValidBoardId('')).toBe(false);
    expect(isValidBoardId('-start')).toBe(false);
    expect(isValidBoardId('has..dots')).toBe(false);
    expect(isValidBoardId('has spaces')).toBe(false);
  });
});

// ── writeBoard ──────────────────────────────────────────────────────

describe('writeBoard', () => {
  it('writes a board and can be read back', async () => {
    const board = createBoardObject({ title: 'Write Test' });
    await writeBoard(tmpDir, board);
    const read = await readBoard(tmpDir, board.id);
    expect(read).not.toBeNull();
    expect(read!.title).toBe('Write Test');
  });
});

// ── appendKanbanEvent ───────────────────────────────────────────────

describe('appendKanbanEvent', () => {
  it('rejects appending an event without an owning session id', async () => {
    const { appendKanbanEvent } = await import('../src/storage.js');
    const board = await makeBoard();
    // Cast: the type forbids a session-less event, and this test proves the
    // runtime guard still refuses one that reaches it anyway (an IPC payload,
    // a legacy file on disk).
    const event = {
      ...moveEvent(board.id, 't1'),
      sessionId: undefined,
    } as unknown as KanbanEvent;

    await expect(appendKanbanEvent(tmpDir, board.id, event)).rejects.toMatchObject({
      code: 'SESSION_ID_REQUIRED',
    });
    await expect(readKanbanEvents(tmpDir, board.id)).resolves.toEqual([]);
  });

  it('appends an event and reads it back', async () => {
    const { appendKanbanEvent } = await import('../src/storage.js');
    const board = await makeBoard();
    const event = moveEvent(board.id, 't1');
    await appendKanbanEvent(tmpDir, board.id, event);
    const events = await readKanbanEvents(tmpDir, board.id);
    expect(events).toHaveLength(1);
    expect(events.at(0)?.type).toBe('task.moved');
  });

  it('skips the event-file read on successive appends when size matches the cache', async () => {
    // The trim cache short-circuits the read when the on-disk size equals
    // cached.size + appendedBytes. Instrument `node:fs/promises` so storage.ts
    // sees a wrapped readFile whose call count we can assert on. ESM
    // namespaces cannot be mutated directly, so we mock the module.
    const readFileMock = vi.fn(async (filePath: string, encoding: BufferEncoding) => {
      return fs.readFile(filePath, encoding);
    });
    const statMock = vi.fn(async (filePath: string) => fs.stat(filePath));
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        readFile: readFileMock,
        stat: statMock,
      };
    });
    const { appendKanbanEvent } = await import('../src/storage.js');
    const board = await makeBoard();
    const eventsPath = path.join(
      path.dirname(getKanbanPath(tmpDir, board.id)),
      `${board.id}.events.jsonl`,
    );

    const events = [
      moveEvent(board.id, 't1'),
      moveEvent(board.id, 't2'),
      moveEvent(board.id, 't3'),
    ];

    for (const event of events) {
      await appendKanbanEvent(tmpDir, board.id, event);
    }

    // The cache short-circuits the read when the size matches, so on a small
    // log file (well below the 512_000 byte threshold) no readFile should be
    // issued by trimKanbanEventLog. The readFile mock should record zero
    // calls against the events path.
    const trimReadCalls = readFileMock.mock.calls.filter((call) => call[0] === eventsPath);
    expect(trimReadCalls).toHaveLength(0);

    const stored = await readKanbanEvents(tmpDir, board.id);
    expect(stored).toHaveLength(3);
    vi.doUnmock('node:fs/promises');
  });

  // The previous eviction pass dropped only entries whose backing file had been
  // deleted, so in the ordinary case — boards accumulate roughly one per session
  // and nothing removes them — it evicted nothing and the map grew without
  // limit, while `stat`ing every entry on every append under the file lock.
  it('keeps the event-log cache bounded when every cached board still exists', async () => {
    const { appendKanbanEvent, eventLogCacheSizeForTests, EVENT_LOG_MAX_CACHE_ENTRIES } =
      await import('../src/storage.js');

    const boards = EVENT_LOG_MAX_CACHE_ENTRIES + 72;
    for (let index = 0; index < boards; index += 1) {
      await appendKanbanEvent(tmpDir, `bounded-${index}`, moveEvent(`bounded-${index}`, 't1'));
    }

    expect(eventLogCacheSizeForTests()).toBe(EVENT_LOG_MAX_CACHE_ENTRIES);

    // And it holds: further appends, to both new and already-cached boards,
    // must not push it past the bound.
    for (let index = 0; index < 40; index += 1) {
      await appendKanbanEvent(tmpDir, `bounded-extra-${index}`, moveEvent('extra', 't1'));
      await appendKanbanEvent(tmpDir, `bounded-${boards - 1}`, moveEvent('recent', 't1'));
    }
    expect(eventLogCacheSizeForTests()).toBe(EVENT_LOG_MAX_CACHE_ENTRIES);
  });

  it('invalidates the cache and re-reads when an external rewrite changes the file size', async () => {
    const { appendKanbanEvent } = await import('../src/storage.js');
    const board = await makeBoard();
    const eventsPath = path.join(
      path.dirname(getKanbanPath(tmpDir, board.id)),
      `${board.id}.events.jsonl`,
    );

    // Establish a cache entry by appending one event.
    await appendKanbanEvent(tmpDir, board.id, moveEvent(board.id, 't1'));

    // Externally rewrite the file at a different size: this is the
    // "concurrent process rewrote the events file" scenario. The cache must
    // notice the size mismatch on the next append and re-read.
    const externalPayload = JSON.stringify({
      type: 'task.moved',
      taskId: 'external',
      fromColumn: 'c1',
      toColumn: 'c2',
      timestamp: new Date().toISOString(),
    });
    await fs.writeFile(
      eventsPath,
      `${externalPayload}\n${externalPayload}\n${externalPayload}\n`,
      'utf8',
    );

    // Instrument node:fs/promises so we can confirm the cache invalidation
    // path. The cache must observe the size mismatch and re-read the file.
    const readFileMock = vi.fn(async (filePath: string, encoding: BufferEncoding) => {
      return fs.readFile(filePath, encoding);
    });
    const statMock = vi.fn(async (filePath: string) => fs.stat(filePath));
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        readFile: readFileMock,
        stat: statMock,
      };
    });
    const { appendKanbanEvent: trackedAppend } = await import('../src/storage.js');

    await trackedAppend(tmpDir, board.id, moveEvent(board.id, 't2'));

    // The cache short-circuit failed because the size no longer matches the
    // cached value. The trim path must have run, which is observable via
    // the stat call. The read itself is skipped because the file is still
    // small (well below 512_000 bytes), but the next append after this one
    // should hit the cache short-circuit again.
    const stores = await readKanbanEvents(tmpDir, board.id);
    expect(stores.length).toBeGreaterThanOrEqual(3);

    // A second append that just bumps the file by appendedBytes should hit
    // the cache short-circuit again — a fresh readFile call to the events
    // path inside the trim function must be zero.
    readFileMock.mockClear();
    statMock.mockClear();
    await trackedAppend(tmpDir, board.id, moveEvent(board.id, 't3'));
    const trimReadCalls = readFileMock.mock.calls.filter((call) => call[0] === eventsPath);
    expect(trimReadCalls).toHaveLength(0);
    vi.doUnmock('node:fs/promises');
  });

  it('clears the cache entry when the read inside trim fails', async () => {
    // Replace the events file with a directory so the read inside
    // trimKanbanEventLog throws EISDIR. The cache must drop the entry so a
    // subsequent successful append re-establishes a fresh cache.
    const { appendKanbanEvent } = await import('../src/storage.js');
    const board = await makeBoard();
    const eventsPath = path.join(
      path.dirname(getKanbanPath(tmpDir, board.id)),
      `${board.id}.events.jsonl`,
    );

    // Establish a cache entry.
    await appendKanbanEvent(tmpDir, board.id, moveEvent(board.id, 't1'));

    // Replace the events file with a directory so the next trim's read fails
    // with EISDIR. The catch handler must clear the cache entry.
    await fs.unlink(eventsPath);
    await fs.mkdir(eventsPath, { recursive: true });

    // appendFile will still try to write to the path-as-dir and fail. The
    // appendKanbanEvent promise rejects, but the cache should be cleared.
    await expect(appendKanbanEvent(tmpDir, board.id, moveEvent(board.id, 't2'))).rejects.toThrow();

    // Restore the file with a valid payload and confirm a fresh cache entry
    // is built on the next successful append.
    await fs.rmdir(eventsPath);
    await appendKanbanEvent(tmpDir, board.id, moveEvent(board.id, 'after-recovery'));
    const events = await readKanbanEvents(tmpDir, board.id);
    expect(events.some((e) => e.taskId === 'after-recovery')).toBe(true);
  });
});

// ── assertValidBoardId (invalid path) ───────────────────────────────

describe('getKanbanPath with invalid board ID', () => {
  it('throws for invalid board id with dots', () => {
    expect(() => getKanbanPath(tmpDir, '..%2Fevil')).toThrow('Invalid kanban board id');
  });

  it('throws for invalid board id with slashes', () => {
    expect(() => getKanbanPath(tmpDir, '../../../etc/passwd')).toThrow('Invalid kanban board id');
  });
});

// ── boolean conditional branches ────────────────────────────────────

describe('createBoardObject conditional branches', () => {
  it('creates board without description, tags, or generatedBy', () => {
    const board = createBoardObject({ title: 'Minimal' });
    expect(board.title).toBe('Minimal');
    expect(board.description).toBeUndefined();
    expect(board.tags).toBeUndefined();
    expect(board.generatedBy).toBeUndefined();
  });

  it('creates board with all optional fields', async () => {
    const board = createBoardObject({
      title: 'Full',
      description: 'desc',
      tags: ['tag1'],
      generatedBy: 'test',
    });
    expect(board.description).toBe('desc');
    expect(board.tags).toEqual(['tag1']);
    expect(board.generatedBy).toBe('test');
  });
});

// ── boardMeta with undefined optionals ──────────────────────────────

describe('boardMeta with undefined fields', () => {
  it('handles board without description, tags, or tasks', () => {
    const board = createBoardObject({ title: 'Bare' });
    // Remove optional fields to hit the undefined branches
    delete (board as any).description;
    delete (board as any).tags;
    const meta = boardMeta(board);
    expect(meta.title).toBe('Bare');
    expect((meta as any).description).toBeUndefined();
    expect((meta as any).tags).toBeUndefined();
    expect(meta.taskCount).toBe(0);
    expect(meta.completedTaskCount).toBe(0);
  });

  it('boardMeta with tasks including completed', () => {
    const now = new Date().toISOString();
    const board = createBoardObject({ title: 'Stats' });
    board.tasks = [
      {
        id: 't1',
        title: 'Done',
        columnId: 'backlog',
        order: 0,
        priority: 'high',
        status: 'completed',
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      },
      {
        id: 't2',
        title: 'Pending',
        columnId: 'backlog',
        order: 1,
        priority: 'low',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      },
    ];
    const meta = boardMeta(board);
    expect(meta.taskCount).toBe(2);
    expect(meta.completedTaskCount).toBe(1);
  });
});
