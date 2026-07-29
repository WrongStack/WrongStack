/**
 * Tests for the background indexing coordinator (debounce + mutex).
 *
 * `indexService` (from index-service.js) is mocked here — its real behavior is
 * covered by codebase-index.test.ts. These tests only assert
 * background-indexer's own responsibilities: coalescing rapid edits, dropping
 * non-indexable files, and serializing concurrent runs onto a single mutex.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// This suite drives the codebase index in-process. The project daemon now
// fails closed when its build cannot be located, so the in-process path has to
// be requested rather than fallen into — the same declaration a user would make
// with WRONGSTACK_INDEX_INLINE=1.
process.env['WRONGSTACK_INDEX_INLINE'] = '1';


// Mock the index-service module BEFORE importing the unit under test. The mock
// is declared via vi.hoisted so it's initialized before the hoisted vi.mock
// factory. background-indexer.ts calls indexService(args, hooks) from
// index-service.js — NOT runIndexer from indexer.js directly.
const { indexServiceMock } = vi.hoisted(() => ({ indexServiceMock: vi.fn() }));
vi.mock('../src/codebase-index/index-service.js', () => ({
  indexService: indexServiceMock,
  searchService: vi.fn(),
  statsService: vi.fn(),
  packageGraphService: vi.fn(),
  fileGraphService: vi.fn(),
  symbolGraphService: vi.fn(),
}));

const OK_RESULT = { filesIndexed: 1, symbolsIndexed: 0, langStats: {}, durationMs: 0, errors: [] };

import {
  cancelPendingReindexes,
  enqueueReindex,
  isIndexableFile,
  isIndexing,
  runStartupIndex,
} from '../src/codebase-index/background-indexer.js';
import {
  CircuitOpenError,
  IndexTimeoutError,
  indexCircuitBreaker,
  resetIndexCircuitBreaker,
} from '../src/codebase-index/circuit-breaker.js';

beforeEach(() => {
  indexServiceMock.mockReset();
  indexServiceMock.mockResolvedValue(OK_RESULT);
  // The breaker is process-wide module state — start every test closed.
  resetIndexCircuitBreaker();
});

afterEach(() => {
  cancelPendingReindexes();
  vi.useRealTimers();
});

describe('isIndexableFile', () => {
  it('accepts known source extensions and extended languages', () => {
    for (const f of [
      'a.ts',
      'b.tsx',
      'c.js',
      'd.jsx',
      'e.go',
      'f.py',
      'g.rs',
      'h.java',
      'i.md',
      'Makefile',
      'mod.mjs',
    ]) {
      expect(isIndexableFile(`/proj/${f}`)).toBe(true);
    }
  });

  it('rejects non-source binary/plain assets', () => {
    for (const f of ['notes.txt', 'image.png', 'photo.jpg', 'data.bin']) {
      expect(isIndexableFile(`/proj/${f}`)).toBe(false);
    }
  });
});

describe('enqueueReindex (debounce)', () => {
  it('coalesces rapid edits to the same file into one reindex', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i++) {
      enqueueReindex({ projectRoot: '/proj', files: ['/proj/a.ts'], debounceMs: 20 });
    }
    await vi.advanceTimersByTimeAsync(30);
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
    expect(indexServiceMock.mock.calls[0]?.[0]).toMatchObject({ files: ['/proj/a.ts'] });
  });

  it('batches distinct files whose debounce expires in the same turn', async () => {
    vi.useFakeTimers();
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/a.ts'], debounceMs: 20 });
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/b.ts'], debounceMs: 20 });
    await vi.advanceTimersByTimeAsync(30);
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
    expect(indexServiceMock.mock.calls[0]?.[0]).toMatchObject({
      files: ['/proj/a.ts', '/proj/b.ts'],
    });
  });

  it('keeps different project indexes in separate batches', async () => {
    vi.useFakeTimers();
    enqueueReindex({ projectRoot: '/proj-a', files: ['/proj-a/a.ts'], debounceMs: 20 });
    enqueueReindex({ projectRoot: '/proj-b', files: ['/proj-b/b.ts'], debounceMs: 20 });
    await vi.advanceTimersByTimeAsync(30);
    expect(indexServiceMock).toHaveBeenCalledTimes(2);
  });

  it('drops non-indexable files before scheduling', async () => {
    vi.useFakeTimers();
    // plain assets are still filtered; markdown/source-like files are indexable
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/photo.png', '/proj/notes.txt'], debounceMs: 20 });
    await vi.advanceTimersByTimeAsync(30);
    expect(indexServiceMock).not.toHaveBeenCalled();
  });

  it('schedules extended languages such as markdown', async () => {
    vi.useFakeTimers();
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/README.md'], debounceMs: 20 });
    await vi.advanceTimersByTimeAsync(30);
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
    expect(indexServiceMock.mock.calls[0]?.[0]).toMatchObject({ files: ['/proj/README.md'] });
  });

  it('routes reindex failures to onError, never throwing', async () => {
    vi.useFakeTimers();
    indexServiceMock.mockRejectedValueOnce(new Error('boom'));
    const onError = vi.fn();
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/a.ts'], debounceMs: 10, onError });
    await vi.advanceTimersByTimeAsync(20);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('mutex serialization', () => {
  it('never runs two indexer passes concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    indexServiceMock.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { filesIndexed: 1, symbolsIndexed: 0, langStats: {}, durationMs: 0, errors: [] };
    });

    await Promise.all([
      runStartupIndex({ projectRoot: '/proj' }),
      runStartupIndex({ projectRoot: '/proj' }),
      runStartupIndex({ projectRoot: '/proj' }),
    ]);

    expect(indexServiceMock).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
  });

  it('a failing job does not wedge the mutex chain', async () => {
    indexServiceMock.mockRejectedValueOnce(new Error('first fails'));
    await expect(runStartupIndex({ projectRoot: '/proj' })).rejects.toThrow('first fails');
    // The next run still proceeds.
    await expect(runStartupIndex({ projectRoot: '/proj' })).resolves.toMatchObject({
      filesIndexed: 1,
    });
  });
});

describe('watchdog timeout', () => {
  it('a hung index run times out and does not wedge the mutex chain', async () => {
    // Never settles — simulates a wedged FS / cross-process SQLite lock.
    indexServiceMock.mockImplementationOnce(() => new Promise(() => {}));
    await expect(runStartupIndex({ projectRoot: '/proj', timeoutMs: 30 })).rejects.toThrow(
      IndexTimeoutError,
    );
    // The indexing flag is released and the next run proceeds normally.
    expect(isIndexing()).toBe(false);
    await expect(runStartupIndex({ projectRoot: '/proj' })).resolves.toMatchObject({
      filesIndexed: 1,
    });
  });

  it('aborts the run signal when the watchdog fires', async () => {
    let seenSignal: AbortSignal | undefined;
    indexServiceMock.mockImplementationOnce((_args: unknown, hooks: { signal?: AbortSignal }) => {
      seenSignal = hooks?.signal;
      return new Promise(() => {});
    });
    await expect(runStartupIndex({ projectRoot: '/proj', timeoutMs: 30 })).rejects.toThrow(
      IndexTimeoutError,
    );
    expect(seenSignal?.aborted).toBe(true);
  });
});

describe('circuit breaker integration', () => {
  it('opens after repeated failures and then fails fast without running the indexer', async () => {
    indexServiceMock.mockRejectedValue(new Error('boom'));
    for (let i = 0; i < 3; i++) {
      await expect(runStartupIndex({ projectRoot: '/proj' })).rejects.toThrow('boom');
    }
    indexServiceMock.mockClear();
    await expect(runStartupIndex({ projectRoot: '/proj' })).rejects.toThrow(CircuitOpenError);
    expect(indexServiceMock).not.toHaveBeenCalled();
  });

  it('drops debounced reindexes while the circuit is open', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i++) indexCircuitBreaker.recordFailure(new Error('boom'));
    const onError = vi.fn();
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/a.ts'], debounceMs: 10, onError });
    await vi.advanceTimersByTimeAsync(20);
    expect(indexServiceMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(CircuitOpenError);
  });

  it('caller-initiated aborts do not count toward the breaker', async () => {
    const ac = new AbortController();
    indexServiceMock.mockImplementationOnce(
      (_args: unknown, hooks: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const s = hooks?.signal;
          // The abort may land before the mutex even starts this job — honor
          // an already-aborted signal, like the real runIndexer's yield points.
          if (s?.aborted) {
            reject(s.reason);
            return;
          }
          s?.addEventListener('abort', () => reject(s.reason), { once: true });
        }),
    );
    const run = runStartupIndex({ projectRoot: '/proj', signal: ac.signal });
    ac.abort(new Error('session teardown'));
    await expect(run).rejects.toThrow('session teardown');
    expect(indexCircuitBreaker.snapshot().consecutiveFailures).toBe(0);
  });

  it('a successful run closes a tripped (cooled-down) circuit again', async () => {
    indexServiceMock.mockRejectedValueOnce(new Error('one-off'));
    await expect(runStartupIndex({ projectRoot: '/proj' })).rejects.toThrow('one-off');
    await expect(runStartupIndex({ projectRoot: '/proj' })).resolves.toMatchObject({
      filesIndexed: 1,
    });
    expect(indexCircuitBreaker.snapshot()).toMatchObject({
      state: 'closed',
      consecutiveFailures: 0,
    });
  });
});

describe('UNIQUE constraint auto-recovery', () => {
  it('retries with force=true on UNIQUE constraint failure', async () => {
    // First call throws a UNIQUE constraint error (simulating corrupted DB)
    indexServiceMock.mockRejectedValueOnce(new Error('UNIQUE constraint failed: symbols.id'));
    // Second call (with force=true) succeeds
    indexServiceMock.mockResolvedValueOnce(OK_RESULT);

    const result = await runStartupIndex({ projectRoot: '/proj' });

    expect(result).toMatchObject({ filesIndexed: 1 });
    // Verify force=true was passed on retry
    expect(indexServiceMock).toHaveBeenCalledTimes(2);
    const secondCallArgs = indexServiceMock.mock.calls[1]?.[0];
    expect(secondCallArgs).toMatchObject({ force: true });
  });

  it('retries with force=true on generic SQLite constraint failure', async () => {
    // better-sqlite3 can surface some constraint failures without the table
    // name detail. Treat this like the UNIQUE form: wipe/rebuild the index DB.
    indexServiceMock.mockRejectedValueOnce(new Error('constraint failed'));
    indexServiceMock.mockResolvedValueOnce(OK_RESULT);

    const result = await runStartupIndex({ projectRoot: '/proj' });

    expect(result).toMatchObject({ filesIndexed: 1 });
    expect(indexServiceMock).toHaveBeenCalledTimes(2);
    expect(indexServiceMock.mock.calls[1]?.[0]).toMatchObject({ force: true });
  });

  it('does not retry if force=true already (prevents infinite recursion)', async () => {
    // Even with force=true, if it fails, it should not retry again
    indexServiceMock.mockRejectedValueOnce(new Error('UNIQUE constraint failed: symbols.id'));

    await expect(runStartupIndex({ projectRoot: '/proj', force: true })).rejects.toThrow(
      'UNIQUE constraint failed: symbols.id',
    );
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on non-constraint errors', async () => {
    indexServiceMock.mockRejectedValueOnce(new Error('some other error'));

    await expect(runStartupIndex({ projectRoot: '/proj' })).rejects.toThrow('some other error');
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
  });
});
