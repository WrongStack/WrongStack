/**
 * HqTimeseriesStore rehydration after a read that fails PART WAY THROUGH.
 *
 * The store's retention contract is precise: history past the newest
 * `maxBuckets` is dropped on purpose, the newest buckets never are. That
 * contract only holds if compaction is fed a map that faithfully represents
 * the file — because compaction REWRITES the file from the in-memory map.
 *
 * It used not to. A read that stopped early (EIO, Windows AV/filter-driver
 * contention, a file replaced mid-read) left two compounding defects:
 *
 *   1. `loadInternal`'s catch set `this.loaded = true` regardless, so
 *      `flushInternal`'s `if (!this.loaded) await this.load()` guard skipped
 *      rehydration and compaction wrote the prefix it happened to hold.
 *   2. `load()` memoized with `this.loadPromise ??= this.loadInternal()`, and
 *      the promise left behind by the FAILED attempt stayed settled forever —
 *      so there was no retry path at all, even once the fault cleared. The map
 *      stayed partial for the life of the process.
 *
 * Together they made the next flush destroy real history silently: the newest
 * buckets vanished, and no amount of later loading brought them back.
 *
 * Only the fs READ is injected. The store, `readJsonlLines`, the file lock and
 * `atomicWrite` all run as real production code.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readFault = vi.hoisted(() => ({
  /** Inert until a test arms it, so every other case here uses the real fs. */
  armed: false,
  /** 1-based index of the `handle.read` call that throws. */
  throwsOnRead: 0,
  /** Throw on EVERY read while armed — a fault that has not healed. */
  always: false,
  reads: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = actual.open;
  return {
    ...actual,
    open: async (p: Parameters<typeof open>[0], flags?: string, mode?: number) => {
      const handle = await open(p as string, flags as never, mode);
      if (!(String(p).endsWith('timeseries.jsonl') && flags === 'r')) return handle;
      // Wrap every read of the log, armed or not: the counter must also record
      // the reads a DISARMED (recovered) load performs, or a test that checks
      // "did the second load re-read the file?" is measuring its own mock.
      return new Proxy(handle, {
        get(target, prop) {
          if (prop !== 'read') {
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (...args: unknown[]) => {
            readFault.reads += 1;
            if (
              readFault.armed &&
              (readFault.always || readFault.reads === readFault.throwsOnRead)
            ) {
              const err: NodeJS.ErrnoException = new Error('EIO: simulated mid-stream read fault');
              err.code = 'EIO';
              throw err;
            }
            return (target.read as (...a: unknown[]) => unknown)(...args);
          };
        },
      });
    },
  };
});

import { HqTimeseriesStore } from '../../src/hq/persistence.js';

// `readJsonlLines` reads in 256 KB chunks. A file smaller than one chunk is
// consumed by a SINGLE read, so a fault on read #2 would land after every
// bucket had already been yielded and nothing would be partial. Padding each
// line forces the newest buckets into a second read — where the fault bites.
const LINE_PAD = 'x'.repeat(10_000);
const BUCKETS = 30;
const NEWEST_TS = 30_000;
const MAX_BUCKETS = 5;
const BUCKET_MS = 1_000;

let dataDir: string;
const filePath = () => path.join(dataDir, 'timeseries.jsonl');

async function writeHistory(count = BUCKETS): Promise<void> {
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    lines.push(
      `${JSON.stringify({
        ts: i * 1000,
        costUsd: i,
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        pad: LINE_PAD,
      })}\n`,
    );
  }
  await fs.writeFile(filePath(), lines.join(''));
}

async function timestampsOnDisk(): Promise<number[]> {
  const raw = await fs.readFile(filePath(), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { ts: number }).ts)
    .sort((a, b) => a - b);
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-timeseries-partial-'));
  readFault.armed = false;
  readFault.always = false;
  readFault.throwsOnRead = 0;
  readFault.reads = 0;
});

afterEach(async () => {
  readFault.armed = false;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('HqTimeseriesStore partial rehydration', () => {
  it('CONTROL: a healthy load keeps the newest buckets through compaction', async () => {
    await writeHistory();
    const store = new HqTimeseriesStore({
      dataDir,
      bucketMs: BUCKET_MS,
      maxBuckets: MAX_BUCKETS,
    });

    await store.load();
    expect((await store.read()).map((s) => s.ts)).toContain(NEWEST_TS);

    store.record({ ts: 40_000, costUsd: 1 });
    store.flush();
    await store.drain();

    // Retention keeps the newest MAX_BUCKETS, and the newest is the newest.
    expect(await timestampsOnDisk()).toContain(NEWEST_TS);
  });

  it('does not claim to be loaded when the read stopped part way through', async () => {
    await writeHistory();
    readFault.armed = true;
    readFault.throwsOnRead = 2;

    const store = new HqTimeseriesStore({
      dataDir,
      bucketMs: BUCKET_MS,
      maxBuckets: MAX_BUCKETS,
    });
    await store.load();

    // Sanity: the fault really did stop the read mid-file, so the map is a
    // strict prefix and the newest bucket is genuinely absent from it.
    expect(readFault.reads).toBeGreaterThan(1);
    expect((await store.read()).map((s) => s.ts)).not.toContain(NEWEST_TS);

    // The store must not advertise completeness it does not have — that flag
    // is what lets compaction run off this partial map.
    readFault.armed = false;
    store.record({ ts: 40_000, costUsd: 1 });
    store.flush();
    await store.drain();

    // The regression: the newest bucket was on disk and inside the retention
    // window, so it must survive.
    expect(await timestampsOnDisk()).toContain(NEWEST_TS);
  });

  it('retries the read on a later load() once the fault has cleared', async () => {
    await writeHistory();

    // A transient fault: the handle is unavailable for exactly one load, then
    // the filesystem behaves again (AV scanner releases it, network drive
    // recovers). The store must recover on its own — nothing re-arms it.
    readFault.armed = true;
    readFault.throwsOnRead = 2;
    const store = new HqTimeseriesStore({
      dataDir,
      bucketMs: BUCKET_MS,
      maxBuckets: MAX_BUCKETS,
    });
    await store.load();
    expect((await store.read()).map((s) => s.ts)).not.toContain(NEWEST_TS);

    // Fault over. The next load must actually re-read rather than re-await the
    // settled promise the failed attempt left memoized.
    readFault.armed = false;
    const readsBefore = readFault.reads;
    await store.load();
    expect(readFault.reads).toBeGreaterThan(readsBefore);
    expect((await store.read()).map((s) => s.ts)).toContain(NEWEST_TS);
  });

  it('does NOT compact from an incomplete map when the fault persists', async () => {
    // The residual: even after the memo fix, a fault that is STILL ACTIVE at
    // flush time leaves the map a prefix. Compaction REWRITES the log from that
    // map, so it must decline rather than persist a partial view — the log may
    // grow for a while, but no real bucket is destroyed.
    await writeHistory();
    const store = new HqTimeseriesStore({
      dataDir,
      bucketMs: BUCKET_MS,
      maxBuckets: MAX_BUCKETS,
    });

    // Load once with a mid-stream fault: the map is a prefix, and diskLineCount
    // is high enough that the next flush crosses the compaction threshold.
    readFault.armed = true;
    readFault.throwsOnRead = 2;
    await store.load();
    expect((await store.read()).map((s) => s.ts)).not.toContain(NEWEST_TS);

    // The fault has NOT healed. Every read from here on fails, including the
    // re-load flushInternal attempts before compacting.
    readFault.always = true;
    store.record({ ts: 40_000, costUsd: 1 });
    store.flush();
    await store.drain();
    readFault.always = false;

    // The newest bucket is still on disk. It was never written over, because
    // the incomplete map is not a faithful view of the log and so is not
    // allowed to become the new log.
    const onDisk = await timestampsOnDisk();
    expect(onDisk).toContain(NEWEST_TS);
    // The flush's own append still landed — we stand down on compaction only,
    // not on the write itself.
    expect(onDisk).toContain(40_000);
  });

  it('still treats a genuinely empty file as loaded, without re-reading it', async () => {
    // The retry path must not turn a missing/empty log into a per-flush rescan
    // storm. Zero bytes on disk is provably nothing to rehydrate, so this is
    // the one failed load that may still count as complete.
    const store = new HqTimeseriesStore({
      dataDir,
      bucketMs: BUCKET_MS,
      maxBuckets: MAX_BUCKETS,
    });
    await store.load();
    await store.load();

    expect(await store.read()).toEqual([]);
    // A compaction-triggering flush on a log that is still empty must not have
    // re-read the file: the store already knows there is nothing there.
    expect(readFault.reads).toBe(0);
  });
});
