import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SddBoardSnapshot } from '../src/board-types.js';
import { SddBoardStore, sameIndexSignature } from '../src/sdd-board-store.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-board-store-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function snapshot(runId: string, updatedAt: number, specId?: string): SddBoardSnapshot {
  return {
    runId,
    specId,
    graphId: 'graph-1',
    title: `Run ${runId}`,
    status: 'running',
    startedAt: 1,
    updatedAt,
    progress: {
      total: 2,
      completed: 1,
      failed: 0,
      inProgress: 1,
      pending: 0,
      blocked: 0,
      review: 0,
      percentComplete: 50,
      estimatedHours: 0,
      actualHours: 0,
    },
    wave: 1,
    tasks: [],
    columns: [],
  };
}

describe('SddBoardStore', () => {
  it('sanitizes paths and persists, updates, lists, and deletes snapshots', async () => {
    const store = new SddBoardStore({ baseDir: directory });
    expect(store.snapshotPath('run/unsafe')).toBe(path.join(directory, 'run_unsafe.json'));
    expect(store.eventsPath('run unsafe')).toBe(path.join(directory, 'run_unsafe.events.jsonl'));
    expect(store.controlPath('run:unsafe')).toBe(path.join(directory, 'run_unsafe.control.jsonl'));
    expect(await store.latest()).toBeUndefined();
    expect(await store.load('missing')).toBeNull();
    expect(await store.loadLatestForSpec('missing')).toBeNull();

    await store.saveSnapshot(snapshot('older', 10, 'spec-a'));
    await store.saveSnapshot(snapshot('newer', 20, 'spec-b'));
    await store.saveSnapshot({
      ...snapshot('older', 30, 'spec-a'),
      title: 'Updated older',
      status: 'completed',
    });

    expect((await store.list()).map((entry) => entry.runId)).toEqual(['older', 'newer']);
    expect((await store.latest())?.title).toBe('Updated older');
    expect((await store.load('older'))?.status).toBe('completed');
    expect((await store.loadLatestForSpec('spec-b'))?.runId).toBe('newer');

    await fs.writeFile(store.snapshotPath('broken'), 'not-json');
    expect(await store.load('broken')).toBeNull();

    await store.delete('older');
    expect((await store.list()).map((entry) => entry.runId)).toEqual(['newer']);
    expect(await store.load('older')).toBeNull();
  });

  it('reloads an externally changed or invalid index', async () => {
    const store = new SddBoardStore({ baseDir: directory });
    await store.saveSnapshot(snapshot('one', 1));
    expect(await store.list()).toHaveLength(1);
    expect(await store.list()).toHaveLength(1);

    await fs.writeFile(
      path.join(directory, '_index.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            runId: 'external',
            title: 'External',
            status: 'idle',
            total: 0,
            completed: 0,
            updatedAt: 99,
          },
          {
            runId: 'external-older',
            title: 'External older',
            status: 'idle',
            total: 0,
            completed: 0,
            updatedAt: 1,
          },
        ],
      }),
    );
    expect((await store.list())[0]?.runId).toBe('external');

    await fs.writeFile(path.join(directory, '_index.json'), JSON.stringify({ version: 2 }));
    expect(await store.list()).toEqual([]);
    await fs.writeFile(path.join(directory, '_index.json'), 'invalid');
    expect(await new SddBoardStore({ baseDir: directory }).list()).toEqual([]);
    await fs.writeFile(path.join(directory, '_index.json'), 'null');
    expect(await new SddBoardStore({ baseDir: directory }).list()).toEqual([]);
  });

  it('serializes concurrent event writes and amortizes size checks', async () => {
    const store = new SddBoardStore({
      baseDir: directory,
      eventMaxBytes: 4096,
      eventKeepBytes: 2048,
      eventSizeCheckEvery: 2,
    });

    await Promise.all([
      store.appendEvent('run', { ts: 1, type: 'one' }),
      store.appendEvent('run', { ts: 2, type: 'two' }),
      store.appendEvent('run', { ts: 3, type: 'three' }),
    ]);

    const lines = (await fs.readFile(store.eventsPath('run'), 'utf8')).trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).type)).toEqual(['one', 'two', 'three']);
  });

  it('rotates event logs to zero, an exact line, and complete tail lines', async () => {
    const event = { ts: 1, type: 'event', payload: 'x'.repeat(180) };
    const line = `${JSON.stringify(event)}\n`;

    const zero = new SddBoardStore({
      baseDir: path.join(directory, 'zero'),
      eventMaxBytes: 1024,
      eventKeepBytes: 0,
      eventSizeCheckEvery: 1,
    });
    for (let index = 0; index < 5; index++) await zero.appendEvent('run', event);
    expect(await fs.readFile(zero.eventsPath('run'), 'utf8')).toBe('');

    const exact = new SddBoardStore({
      baseDir: path.join(directory, 'exact'),
      eventMaxBytes: 1024,
      eventKeepBytes: Buffer.byteLength(line),
      eventSizeCheckEvery: 1,
    });
    for (let index = 0; index < 5; index++) await exact.appendEvent('run', event);
    expect(await fs.readFile(exact.eventsPath('run'), 'utf8')).toBe(line);

    const partial = new SddBoardStore({
      baseDir: path.join(directory, 'partial'),
      eventMaxBytes: 1024,
      eventKeepBytes: 350,
      eventSizeCheckEvery: 1,
    });
    for (let index = 0; index < 5; index++) await partial.appendEvent('run', event);
    const retained = await fs.readFile(partial.eventsPath('run'), 'utf8');
    expect(retained.startsWith('{')).toBe(true);
    expect(retained.endsWith('\n')).toBe(true);
  });

  it('treats event persistence as best effort and retries directory creation', async () => {
    const blocker = path.join(directory, 'blocker');
    await fs.writeFile(blocker, 'file');
    const store = new SddBoardStore({ baseDir: path.join(blocker, 'boards') });

    await expect(store.appendEvent('run', { ts: 1, type: 'lost' })).resolves.toBeUndefined();
    await fs.unlink(blocker);
    await fs.mkdir(blocker);
    await store.appendEvent('run', { ts: 2, type: 'saved' });

    expect(await fs.readFile(store.eventsPath('run'), 'utf8')).toContain('"saved"');
  });

  it('appends, drains, filters, and truncates control commands', async () => {
    const store = new SddBoardStore({ baseDir: directory });
    expect(await store.drainControl('missing')).toEqual([]);

    await store.appendControl('run', { ts: 1, type: 'pause', payload: { reason: 'test' } });
    await fs.appendFile(store.controlPath('run'), 'invalid-json\n\n');
    const [first, concurrent] = await Promise.all([
      store.drainControl('run'),
      store.drainControl('run'),
    ]);

    expect(first).toEqual([{ ts: 1, type: 'pause', payload: { reason: 'test' } }]);
    expect(concurrent).toEqual([]);
    expect(await store.drainControl('run')).toEqual([]);
  });

  it('leaves control commands queued when reading or truncating fails', async () => {
    const normal = new SddBoardStore({ baseDir: directory });
    await normal.appendControl('run', { ts: 1, type: 'pause' });

    const readFailure = new SddBoardStore({
      baseDir: directory,
      controlFileIO: {
        stat: vi.fn(async () => ({ size: 1 })),
        readFile: vi.fn(async () => {
          throw new Error('read failed');
        }),
        truncate: vi.fn(async () => {}),
      },
    });
    expect(await readFailure.drainControl('run')).toEqual([]);

    const truncateFailure = new SddBoardStore({
      baseDir: directory,
      controlFileIO: {
        stat: vi.fn(async () => ({ size: 1 })),
        readFile: vi.fn(async () => '{"ts":1,"type":"pause"}\n'),
        truncate: vi.fn(async () => {
          throw new Error('truncate failed');
        }),
      },
    });
    expect(await truncateFailure.drainControl('run')).toEqual([]);

    const emptiedBeforeLock = new SddBoardStore({
      baseDir: directory,
      controlFileIO: {
        stat: vi
          .fn<() => Promise<{ size: number }>>()
          .mockResolvedValueOnce({ size: 1 })
          .mockResolvedValueOnce({ size: 0 }),
        readFile: vi.fn(async () => ''),
        truncate: vi.fn(async () => {}),
      },
    });
    expect(await emptiedBeforeLock.drainControl('run')).toEqual([]);
  });
});

describe('sameIndexSignature', () => {
  it('compares null and every signature field', () => {
    const base = { size: 1, mtimeMs: 2, ctimeMs: 3 };
    expect(sameIndexSignature(null, null)).toBe(true);
    expect(sameIndexSignature(null, base)).toBe(false);
    expect(sameIndexSignature(base, null)).toBe(false);
    expect(sameIndexSignature(base, { ...base })).toBe(true);
    expect(sameIndexSignature(base, { ...base, size: 9 })).toBe(false);
    expect(sameIndexSignature(base, { ...base, mtimeMs: 9 })).toBe(false);
    expect(sameIndexSignature(base, { ...base, ctimeMs: 9 })).toBe(false);
  });
});
