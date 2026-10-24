import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HqSageRecord } from '../src/protocol/sage.js';
import { HqSageStore } from '../src/sage-store.js';

const state = vi.hoisted(() => ({
  fail: false,
  writes: 0,
  reads: 0,
  heldRead: undefined as { entered(): void; release: Promise<void> } | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      state.reads++;
      const data = await actual.readFile(...args);
      const held = state.heldRead;
      if (held) {
        state.heldRead = undefined;
        held.entered();
        await held.release;
      }
      return data;
    },
  };
});
vi.mock('../../core/src/utils/atomic-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/src/utils/atomic-write.js')>();
  return {
    ...actual,
    atomicWrite: (...args: Parameters<typeof actual.atomicWrite>) => {
      state.writes++;
      if (state.fail) return Promise.reject(new Error('disk write failed'));
      return actual.atomicWrite(...args);
    },
  };
});
let root: string;
let store: HqSageStore;
const record: HqSageRecord = { id: 'm', revision: 1, changeId: 'a'.repeat(32), memory: null };
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-sage-store-'));
  store = new HqSageStore(root);
  state.fail = false;
  state.writes = 0;
  state.heldRead = undefined;
});
afterEach(async () => {
  await store.drain();
  await fs.rm(root, { recursive: true, force: true });
});
it('does not acknowledge a failed durable write from cache on retry', async () => {
  await store.merge({ projectId: 'p', records: [record] });
  const newer = { ...record, revision: 2 };
  state.fail = true;
  await expect(store.merge({ projectId: 'p', records: [newer] })).rejects.toThrow(
    'disk write failed',
  );
  expect((await store.load('p')).records).toEqual([record]);
  state.fail = false;
  expect((await store.merge({ projectId: 'p', records: [newer] })).records).toEqual([newer]);
  expect(state.writes).toBe(3);
  expect((await new HqSageStore(root).load('p')).records).toEqual([newer]);
});
it('returns isolated snapshots and avoids rewriting identical replayed records', async () => {
  await store.merge({ projectId: 'p', records: [record] });
  const loaded = await store.load('p');
  loaded.records.length = 0;
  const replay = await store.merge({ projectId: 'p', records: [record] });
  expect(replay.records).toEqual([record]);
  expect(state.writes).toBe(1);
});
it('serializes concurrent chunks without dropping independent records', async () => {
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.merge({ projectId: 'p', records: [{ ...record, id: `m${i}` }] }),
    ),
  );
  expect((await store.load('p')).records).toHaveLength(20);
  expect((await new HqSageStore(root).load('p')).records).toHaveLength(20);
});

it('does not lend cached records to callers through merge input or output', async () => {
  const incoming = { ...record };
  const delta = await store.merge({ projectId: 'p', records: [incoming] });
  incoming.revision = 50;
  delta.records[0]!.revision = 99;
  expect((await store.load('p')).records[0]!.revision).toBe(1);
  expect((await new HqSageStore(root).load('p')).records[0]!.revision).toBe(1);
});

it('shares a cold read between snapshot loading and concurrent merges', async () => {
  await store.merge({ projectId: 'p', records: [record] });
  store = new HqSageStore(root);
  const priorReads = state.reads;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  state.heldRead = {
    entered,
    release: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const delayed = store.load('p');
  await started;
  const merged = store.merge({ projectId: 'p', records: [{ ...record, revision: 2 }] });
  // Let both operations overlap without requiring either one to win the race.
  await new Promise((resolve) => setImmediate(resolve));
  const overlappingReads = state.reads - priorReads;
  release();
  await Promise.all([delayed, merged]);
  expect(overlappingReads).toBe(1);
  expect((await store.load('p')).records[0]!.revision).toBe(2);
  const stale = await store.merge({ projectId: 'p', records: [record] });
  expect(stale.records[0]!.revision).toBe(2);
});

it('evicts idle projects after a concurrent burst exceeds the cache capacity', async () => {
  await Promise.all(
    Array.from({ length: 40 }, (_, i) => store.merge({ projectId: `p${i}`, records: [record] })),
  );
  const before = state.reads;
  await Promise.all(Array.from({ length: 40 }, (_, i) => store.load(`p${i}`)));
  expect(state.reads - before).toBeGreaterThanOrEqual(8);
});
