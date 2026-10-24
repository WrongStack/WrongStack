import * as os from 'node:os';
import * as path from 'node:path';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUE_MAX_BYTES, QUEUE_MAX_ITEMS, QueueStore } from '../../src/storage/queue-store.js';

// vi.mock is hoisted above imports.  We use vi.importActual inside the factory
// to lazily get the real module, avoiding TDZ issues.  The returned plain object
// replaces 'node:fs/promises' before the second import runs.
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

  // In-memory store so writes and reads share state within a test.
  const store: Record<string, string> = {};

  const mockFs = {
    ...real,
    open: vi.fn(real.open),
    mkdtemp: async (prefix: string) => {
      const dir = await real.mkdtemp(prefix);
      store[dir] = '';
      return dir;
    },
    readFile: vi.fn(async (filepath: string) => {
      if (store[filepath] !== undefined) return store[filepath];
      return await real.readFile(filepath, 'utf8');
    }),
    stat: vi.fn(async (filepath: string) => {
      if (store[filepath] !== undefined)
        return { size: Buffer.byteLength(store[filepath], 'utf8') };
      return await real.stat(filepath);
    }),
    writeFile: vi.fn(async (filepath: string, data: string) => {
      store[filepath] = data;
      try {
        await real.writeFile(filepath, data, 'utf8');
      } catch {
        /* best-effort real write */
      }
    }),
    rename: real.rename,
    unlink: vi.fn(async (filepath: string) => {
      delete store[filepath];
      try {
        await real.unlink(filepath);
      } catch {
        /* best-effort */
      }
    }),
    access: vi.fn(async (filepath: string) => {
      if (store[filepath] !== undefined) return;
      try {
        await real.access(filepath);
      } catch {
        /* fall through to check in-memory */
      }
      if (store[filepath] === undefined)
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    mkdir: real.mkdir,
    readdir: real.readdir,
    rm: vi.fn(async (filepath: string, opts?: { recursive?: boolean; force?: boolean }) => {
      // Remove all in-memory entries under this directory prefix
      if (opts?.recursive) {
        for (const key of Object.keys(store)) {
          if (key.startsWith(filepath)) delete store[key];
        }
      } else {
        delete store[filepath];
      }
      try {
        await real.rm(filepath, opts);
      } catch {
        /* best-effort */
      }
    }),
    chmod: real.chmod,
  };
  return mockFs;
});

import * as fsp from 'node:fs/promises';

const readFileMock = vi.mocked(fsp.readFile);
const statMock = vi.mocked(fsp.stat);
const writeFileMock = vi.mocked(fsp.writeFile);
const unlinkMock = vi.mocked(fsp.unlink);
const accessMock = vi.mocked(fsp.access);

async function mktmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-queue-'));
}

describe('QueueStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mktmp();
    readFileMock.mockReset();
    statMock.mockReset();
    writeFileMock.mockReset();
    vi.mocked(fsp.open).mockReset();
    unlinkMock.mockReset();
    accessMock.mockReset();
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('read() returns [] when the file is missing', async () => {
    const store = new QueueStore({ dir });
    expect(await store.read()).toEqual([]);
  });

  it('write() then read() round-trips items', async () => {
    const store = new QueueStore({ dir });
    const items = [
      { displayText: 'first', blocks: [{ type: 'text' as const, text: 'first' }] },
      { displayText: 'second', blocks: [{ type: 'text' as const, text: 'second' }] },
    ];
    await store.write(items);
    const out = await store.read();
    expect(out).toEqual(items);
  });

  it('write([]) removes the file (clean idle state)', async () => {
    const store = new QueueStore({ dir });
    await store.write([{ displayText: 'a', blocks: [{ type: 'text', text: 'a' }] }]);
    await store.write([]);
    await expect(fsp.access(path.join(dir, 'queue.json'))).rejects.toThrow();
    expect(await store.read()).toEqual([]);
  });

  it('clear() is idempotent when the file is already gone', async () => {
    const store = new QueueStore({ dir });
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('write() is atomic — no .tmp residue after a successful write', async () => {
    const store = new QueueStore({ dir });
    await store.write([{ displayText: 'one', blocks: [{ type: 'text', text: 'one' }] }]);
    const files = await fsp.readdir(dir);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('read() tolerates malformed JSON (returns [])', async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'queue.json'), '{not json');
    const store = new QueueStore({ dir });
    expect(await store.read()).toEqual([]);
  });

  it('read() tolerates a non-array root (returns [])', async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'queue.json'), '{"queue": []}');
    const store = new QueueStore({ dir });
    expect(await store.read()).toEqual([]);
  });

  it('read() drops items missing required fields', async () => {
    const valid = { displayText: 'ok', blocks: [{ type: 'text', text: 'ok' }] };
    const missingText = { blocks: [] };
    const missingBlocks = { displayText: 'no blocks' };
    const notObject = 'string-item';
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'queue.json'),
      JSON.stringify([valid, missingText, missingBlocks, notObject]),
    );
    const store = new QueueStore({ dir });
    expect(await store.read()).toEqual([valid]);
  });

  it('overwrites prior contents on each write', async () => {
    const store = new QueueStore({ dir });
    await store.write([
      { displayText: 'first', blocks: [{ type: 'text', text: 'first' }] },
      { displayText: 'second', blocks: [{ type: 'text', text: 'second' }] },
    ]);
    await store.write([{ displayText: 'only', blocks: [{ type: 'text', text: 'only' }] }]);
    const out = await store.read();
    expect(out).toHaveLength(1);
    expect(out[0]?.displayText).toBe('only');
  });

  it('caps persisted queue snapshots by item count', async () => {
    const store = new QueueStore({ dir });
    const items = Array.from({ length: QUEUE_MAX_ITEMS + 5 }, (_, index) => ({
      displayText: `item-${index}`,
      blocks: [{ type: 'text' as const, text: `item-${index}` }],
    }));
    await store.write(items);
    expect(await store.read()).toHaveLength(QUEUE_MAX_ITEMS);
  });

  it('rejects an oversized queue file before readFile allocates it', async () => {
    const store = new QueueStore({ dir });
    statMock.mockResolvedValueOnce({ size: QUEUE_MAX_BYTES + 1 } as never);
    const readsBefore = readFileMock.mock.calls.length;
    expect(await store.read()).toEqual([]);
    expect(readFileMock.mock.calls.length).toBe(readsBefore);
  });

  // ── storage.* event tests ─────────────────────────────────────────────────

  it('emits storage.read with outcome success when read() finds no file (ENOENT)', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const store = new QueueStore({ dir, events });
    const out = await store.read();
    expect(out).toEqual([]);
    expect(events.emit).toHaveBeenCalledWith(
      'storage.read',
      expect.objectContaining({
        store: 'queue',
        operation: 'read',
        outcome: 'success',
      }),
    );
  });

  it('emits storage.read with outcome failure when read() finds malformed JSON', async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'queue.json'), '{not json');
    const events: EventBus = { emit: vi.fn() } as never;
    const store = new QueueStore({ dir, events });
    const out = await store.read();
    expect(out).toEqual([]);
    expect(events.emit).toHaveBeenCalledWith(
      'storage.read',
      expect.objectContaining({
        store: 'queue',
        operation: 'read',
        outcome: 'failure',
        error: 'parse_failed',
      }),
    );
  });

  it('emits storage.read with outcome failure when read() finds non-array root', async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'queue.json'), '{"queue": []}');
    const events: EventBus = { emit: vi.fn() } as never;
    const store = new QueueStore({ dir, events });
    const out = await store.read();
    expect(out).toEqual([]);
    expect(events.emit).toHaveBeenCalledWith(
      'storage.read',
      expect.objectContaining({
        store: 'queue',
        operation: 'read',
        outcome: 'failure',
        error: 'invalid_schema',
      }),
    );
  });

  it('rejects and emits storage.error when read() encounters a disk I/O error', async () => {
    // An unreadable queue used to read as [] ("no queue"); both consumers
    // then wrote their in-memory queue over the file and lost what was queued.
    const events: EventBus = { emit: vi.fn() } as never;
    const store = new QueueStore({ dir, events });
    statMock.mockResolvedValueOnce({ size: 1 } as never);
    readFileMock.mockRejectedValueOnce(Object.assign(new Error('EIO i/o error'), { code: 'EIO' }));
    await expect(store.read()).rejects.toMatchObject({ code: 'EIO' });
    expect(events.emit).toHaveBeenCalledWith(
      'storage.error',
      expect.objectContaining({
        store: 'queue',
        operation: 'read',
        outcome: 'failure',
        error: expect.stringContaining('EIO'),
      }),
    );
  });

  it('read() reports no queue when a parent path component is a file (ENOTDIR)', async () => {
    // POSIX reports ENOTDIR where Windows reports ENOENT; the file cannot exist
    // either way, so this is "no queue", not an unreadable one.
    const store = new QueueStore({ dir });
    statMock.mockRejectedValueOnce(
      Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' }),
    );
    expect(await store.read()).toEqual([]);
  });

  it('read() retries a transient sharing violation instead of reporting no queue', async () => {
    const store = new QueueStore({ dir });
    await store.write([{ displayText: 'kept', blocks: [{ type: 'text', text: 'kept' }] }]);
    readFileMock.mockRejectedValueOnce(
      Object.assign(new Error('EBUSY resource busy'), { code: 'EBUSY' }),
    );
    expect((await store.read()).map((item) => item.displayText)).toEqual(['kept']);
  });

  it('emits storage.write with outcome success when write() succeeds', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const store = new QueueStore({ dir, events });
    await store.write([{ displayText: 'hello', blocks: [{ type: 'text', text: 'hello' }] }]);
    expect(events.emit).toHaveBeenCalledWith(
      'storage.write',
      expect.objectContaining({
        store: 'queue',
        operation: 'write',
        outcome: 'success',
      }),
    );
  });

  it('emits storage.error when write() encounters a disk I/O error', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const store = new QueueStore({ dir, events });
    vi.mocked(fsp.open).mockRejectedValueOnce(
      Object.assign(new Error('ENOSPC no space left'), { code: 'ENOSPC' }),
    );
    await store.write([{ displayText: 'hello', blocks: [{ type: 'text', text: 'hello' }] }]);
    expect(events.emit).toHaveBeenCalledWith(
      'storage.error',
      expect.objectContaining({
        store: 'queue',
        operation: 'write',
        outcome: 'failure',
        error: expect.stringContaining('ENOSPC'),
      }),
    );
  });

  it('emits storage.write with outcome success when clear() succeeds', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const store = new QueueStore({ dir, events });
    await store.write([{ displayText: 'x', blocks: [{ type: 'text', text: 'x' }] }]);
    events.emit = vi.fn(); // reset after write's emission
    await store.clear();
    expect(events.emit).toHaveBeenCalledWith(
      'storage.write',
      expect.objectContaining({
        store: 'queue',
        operation: 'clear',
        outcome: 'success',
      }),
    );
  });
});
