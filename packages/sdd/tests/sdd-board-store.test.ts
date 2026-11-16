import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SddBoardSnapshot } from '../src/board-types.js';
import { SddBoardStore, sameIndexSignature } from '../src/sdd-board-store.js';

// Control/event appends and snapshot persistence hit real fs per call; under
// parallel-suite load the 5s default testTimeout fires before the fs chain
// finishes — timeouts only, never assertion mismatches (classified 2026-10-05).
vi.setConfig({ testTimeout: 15_000 });

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

  it('serializes concurrent index removals without resurrecting deleted runs', async () => {
    const store = new SddBoardStore({ baseDir: directory });
    await store.saveSnapshot(snapshot('delete-a', 30));
    await store.saveSnapshot(snapshot('delete-b', 20));
    await store.saveSnapshot(snapshot('keep', 10));

    await Promise.all([store.delete('delete-a'), store.delete('delete-b')]);

    expect((await store.list()).map((entry) => entry.runId)).toEqual(['keep']);
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
    // Truncate failed after read succeeded — the drain retries the clear via
    // the atomic-replace fallback and returns the batch only once the file is
    // verifiably empty, so nothing is silently lost and nothing is delivered
    // twice.
    expect(await truncateFailure.drainControl('run')).toEqual([{ ts: 1, type: 'pause' }]);
    expect(await fs.readFile(truncateFailure.controlPath('run'), 'utf8')).toBe('');

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

  it('delivers truncate-failed commands exactly once across drains', async () => {
    let truncateAttempts = 0;
    const refusingStore = new SddBoardStore({
      baseDir: directory,
      controlFileIO: {
        stat: async (p) => await fs.stat(p),
        readFile: async (p) => await fs.readFile(p, 'utf8'),
        truncate: async () => {
          truncateAttempts += 1;
          throw new Error('EBUSY: in-place truncation refused');
        },
      },
    });
    const filePath = refusingStore.controlPath('run');
    await fs.writeFile(filePath, '{"ts":1,"type":"pause"}\n{"ts":2,"type":"resume"}\n', 'utf8');
    // First drain: in-place truncation refuses, the atomic-replace fallback
    // empties the file, and the read commands are delivered exactly once.
    expect(await refusingStore.drainControl('run')).toEqual([
      { ts: 1, type: 'pause' },
      { ts: 2, type: 'resume' },
    ]);
    expect(await fs.readFile(filePath, 'utf8')).toBe('');
    // Regression (chimera Medium): the truncate failure must never become
    // duplicate delivery — the emptied file yields no commands on re-drain.
    expect(await refusingStore.drainControl('run')).toEqual([]);
    expect(truncateAttempts).toBe(1);
  });

  it('preserves sanitized runIds across index rebuild and isolates _index runId from _index.json (F30)', async () => {
    const store = new SddBoardStore({ baseDir: directory });
    await store.saveSnapshot(snapshot('plain-run', 10));
    await store.saveSnapshot(snapshot('run:colon', 20));
    await store.saveSnapshot(snapshot('run/slash', 25));

    await fs.unlink(path.join(directory, '_index.json'));
    const rebuilt = new SddBoardStore({ baseDir: directory });
    await rebuilt.saveSnapshot(snapshot('third-run', 30));

    expect((await rebuilt.list()).map((entry) => entry.runId)).toEqual([
      'third-run',
      'run/slash',
      'run:colon',
      'plain-run',
    ]);
    expect(await rebuilt.load('_index')).toBeNull();
    await rebuilt.delete('_index');
    expect((await rebuilt.list()).map((entry) => entry.runId)).toEqual([
      'third-run',
      'run/slash',
      'run:colon',
      'plain-run',
    ]);
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

  it('loads BOM-prefixed SDD board snapshots and indexes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-bom-'));
    try {
      const store = new SddBoardStore({ baseDir: directory });
      await store.saveSnapshot(snapshot('bom-run', 42));
      const snapPath = path.join(directory, 'bom-run.json');
      const idxPath = path.join(directory, '_index.json');
      await fs.writeFile(snapPath, `\uFEFF${await fs.readFile(snapPath, 'utf8')}`, 'utf8');
      await fs.writeFile(idxPath, `\uFEFF${await fs.readFile(idxPath, 'utf8')}`, 'utf8');

      const reloaded = new SddBoardStore({ baseDir: directory });
      expect((await reloaded.load('bom-run'))?.runId).toBe('bom-run');
      expect((await reloaded.list()).map((e) => e.runId)).toEqual(['bom-run']);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
