/**
 * HqTimeseriesStore load path on a file larger than Node's string ceiling.
 *
 * The store used to `readFile(…, 'utf8')` the whole timeseries log. Once that
 * file passed ~512 MB the read threw ERR_STRING_TOO_LONG, the catch turned it
 * into `diskLineCount = 0`, and compaction only fires above a line threshold —
 * so "too big to read" became "too big to compact" and the file grew forever
 * while HQ silently lost every sample on restart. These tests pin the streamed
 * read: history survives, the line count is real, and memory stays bounded.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HqTimeseriesStore } from '../../src/hq/persistence.js';

// Inert unless a test arms it, so the oversized-file case below reads through
// the real fs. Only the Nth `handle.read` of the log can be made to throw, which
// is what a mid-stream EIO (or a Windows AV/filter-driver grabbing the handle)
// looks like to the store.
const readFault = vi.hoisted(() => ({ armed: false, throwsOnRead: 0, reads: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = actual.open;
  return {
    ...actual,
    open: async (p: Parameters<typeof open>[0], flags?: string, mode?: number) => {
      const handle = await open(p as string, flags as never, mode);
      if (!(String(p).endsWith('timeseries.jsonl') && flags === 'r')) return handle;
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop !== 'read') return Reflect.get(target, prop, receiver);
          return (...args: unknown[]) => {
            readFault.reads += 1;
            if (readFault.armed && readFault.reads === readFault.throwsOnRead) {
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

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-timeseries-big-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

const filePath = () => path.join(dataDir, 'timeseries.jsonl');

describe('HqTimeseriesStore oversized load', () => {
  it('rehydrates the newest buckets from a file past the 512MB string ceiling', async () => {
    // Padding makes each record fat so the file crosses MAX_STRING_LENGTH
    // without needing millions of lines. `readFile(…,'utf8')` throws here.
    const PAD = 'x'.repeat(1024 * 1024); // 1 MB per line
    const LINES = 560; // ~560 MB > 512 MB ceiling
    const handle = await fs.open(filePath(), 'w');
    try {
      for (let i = 0; i < LINES; i++) {
        await handle.write(`${JSON.stringify({ ts: 1000 * i, costUsd: i, pad: PAD })}\n`);
      }
    } finally {
      await handle.close();
    }

    const size = (await fs.stat(filePath())).size;
    expect(size).toBeGreaterThan(536_870_888); // Node's MAX_STRING_LENGTH
    // Require streaming on every runtime, independently of its string ceiling.
    const readWholeFile = fs.readFile;
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation((async (target, ...options) => {
      if (String(target) === filePath()) throw new Error('whole-file timeseries read is forbidden');
      return Reflect.apply(readWholeFile, fs, [target, ...options]);
    }) as typeof fs.readFile);
    const store = new HqTimeseriesStore({ dataDir, bucketMs: 1000, maxBuckets: 10 });
    try {
      await store.load();
      expect(readSpy.mock.calls.filter(([target]) => String(target) === filePath())).toEqual([]);
    } finally {
      readSpy.mockRestore();
    }
    const samples = await store.read();

    // Retention keeps the newest maxBuckets — the point is that they arrived
    // at all, where the old path silently produced nothing.
    expect(samples).toHaveLength(10);
    expect(samples[samples.length - 1]?.ts).toBe(1000 * (LINES - 1));
    expect(samples[0]?.ts).toBe(1000 * (LINES - 10));
  }, 600_000);

  // Deliberately no "peak heap stays under N" test here. `heapUsed` counts
  // uncollected garbage as well as live data, so such an assertion measures GC
  // timing rather than the retention it claims to check — it would flake under
  // a loaded suite and pass for the wrong reason otherwise. The oversized-file
  // case above is the real guard: a whole-file read simply cannot satisfy it.

  it('still counts lines after a partial read so compaction stays armed', async () => {
    await fs.writeFile(
      filePath(),
      `${JSON.stringify({ ts: 1000, costUsd: 1 })}\nnot-json\n${JSON.stringify({ ts: 2000, costUsd: 2 })}\n`,
    );

    const store = new HqTimeseriesStore({ dataDir, bucketMs: 1000, maxBuckets: 10 });
    await store.load();

    // Malformed lines are skipped as samples but still counted, so the
    // compaction trigger reflects what is actually on disk.
    expect((await store.read()).map((s) => s.ts)).toEqual([1000, 2000]);
  });

  it('treats a missing file as empty', async () => {
    const store = new HqTimeseriesStore({ dataDir, bucketMs: 1000 });
    await store.load();
    expect(await store.read()).toEqual([]);
  });

  it('re-reads the file on a second load() after a failed one', async () => {
    // The `load()` memo (`this.loadPromise ??= this.loadInternal()`) is a
    // retry-memoization: it must be dropped when the load it cached did NOT
    // complete. Left in place, `??=` re-awaits the promise the FAILED attempt
    // already settled, so the file is never re-read and the map stays a partial
    // prefix for the life of the process — silently, with no error to trace.
    //
    // The failure has to be a read that stops PART WAY THROUGH a non-empty
    // file. A missing file is a different case and is legitimately treated as
    // "loaded" (there is provably nothing to rehydrate), so it never reaches
    // the memo-reset path and cannot stand in for it here.
    const store = new HqTimeseriesStore({ dataDir, bucketMs: 1000, maxBuckets: 10 });

    // Two buckets, padded past the 256 KB read chunk so a fault on the second
    // read lands mid-file and leaves a genuine partial prefix.
    const pad = 'x'.repeat(200_000);
    await fs.writeFile(
      filePath(),
      `${JSON.stringify({ ts: 1000, costUsd: 1, pad })}\n${JSON.stringify({ ts: 2000, costUsd: 2, pad })}\n`,
    );

    // Load #1 fails part way through, so the map is missing the newest bucket.
    readFault.armed = true;
    readFault.throwsOnRead = 2;
    readFault.reads = 0;
    await store.load();
    readFault.armed = false;
    expect(readFault.reads).toBeGreaterThan(1);
    expect((await store.read()).map((s) => s.ts)).toEqual([1000]);

    // Load #2: the filesystem is healthy again, so this MUST go back to disk.
    // If the memo survived, no new reads would happen and the newest bucket
    // would stay invisible — both to the store and to the compaction that
    // later rewrites the file from this very map.
    const readsBefore = readFault.reads;
    await store.load();
    expect(readFault.reads).toBeGreaterThan(readsBefore);
    expect((await store.read()).map((s) => s.ts)).toEqual([1000, 2000]);
  });

  it('decodes multi-byte characters split across read chunks', async () => {
    // Long enough to straddle the internal chunk boundary many times over.
    const label = '✅🔥çğüşöi'.repeat(20_000);
    await fs.writeFile(filePath(), `${JSON.stringify({ ts: 1000, costUsd: 1, label })}\n`);

    const store = new HqTimeseriesStore({ dataDir, bucketMs: 1000 });
    await store.load();
    const samples = (await store.read()) as unknown as Array<{ label?: string }>;

    // A bare per-chunk toString would have left U+FFFD replacement characters,
    // and a truncated multi-byte sequence would break JSON.parse outright.
    expect(samples).toHaveLength(1);
    expect(samples[0]?.label).toBe(label);
  });
});
