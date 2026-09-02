import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueStore } from '../../src/storage/queue-store.js';

// Covers QueueStore.clear()'s non-ENOENT error branch (storage.error emit +
// throttled warning). Uses real fs with the queue file replaced by a directory
// so unlink() throws EISDIR/EPERM rather than ENOENT.

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-queue-clearerr-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const ITEM = { displayText: 'hi', blocks: [{ type: 'text', text: 'hi' }] } as never;

describe('QueueStore — clear + read coverage', () => {
  it('emits storage.error and warns but does not throw on a non-ENOENT failure', async () => {
    const events = { emit: vi.fn() };
    const store = new QueueStore({ dir, events: events as never, traceId: 'tr-q' });
    await fs.mkdir(path.join(dir, 'queue.json'), { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(store.clear()).resolves.toBeUndefined();

    const err = events.emit.mock.calls.find(
      (c) => c[0] === 'storage.error' && (c[1] as { operation?: string }).operation === 'clear',
    );
    expect(err).toBeDefined();
    expect((err![1] as { traceId?: string }).traceId).toBe('tr-q');
    expect(warn).toHaveBeenCalled();
  });

  it('clear() unlinks an existing queue file and emits storage.write success', async () => {
    const events = { emit: vi.fn() };
    const store = new QueueStore({ dir, events: events as never });
    await store.write([ITEM]); // create the file
    await store.clear();
    const ok = events.emit.mock.calls.find(
      (c) => c[0] === 'storage.write' && (c[1] as { operation?: string }).operation === 'clear',
    );
    expect((ok![1] as { outcome?: string }).outcome).toBe('success');
    expect(await store.read()).toEqual([]); // file gone
  });

  it('clear() is a no-op when the queue file is already missing (ENOENT)', async () => {
    const store = new QueueStore({ dir });
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('read() round-trips written items and emits storage.read success', async () => {
    const events = { emit: vi.fn() };
    const store = new QueueStore({ dir, events: events as never });
    await store.write([ITEM]);
    const items = await store.read();
    expect(items).toHaveLength(1);
    expect(
      events.emit.mock.calls.some(
        (c) => c[0] === 'storage.read' && (c[1] as { outcome?: string }).outcome === 'success',
      ),
    ).toBe(true);
  });

  it('read() returns [] and emits invalid_schema for a non-array payload', async () => {
    const events = { emit: vi.fn() };
    const store = new QueueStore({ dir, events: events as never });
    await fs.writeFile(path.join(dir, 'queue.json'), JSON.stringify({ not: 'an array' }), 'utf8');
    expect(await store.read()).toEqual([]);
    expect(
      events.emit.mock.calls.some(
        (c) => c[0] === 'storage.read' && (c[1] as { error?: string }).error === 'invalid_schema',
      ),
    ).toBe(true);
  });
});
