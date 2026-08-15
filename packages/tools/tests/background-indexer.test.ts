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
      enqueueReindex({
        projectRoot: '/proj',
        files: ['/proj/a.ts'],
        debounceMs: 20,
        coalesceWindowMs: 0,
      });
    }
    await vi.advanceTimersByTimeAsync(30);
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
    expect(indexServiceMock.mock.calls[0]?.[0]).toMatchObject({ files: ['/proj/a.ts'] });
  });

  it('batches distinct files whose debounce expires in the same turn', async () => {
    vi.useFakeTimers();
    enqueueReindex({
      projectRoot: '/proj',
      files: ['/proj/a.ts'],
      debounceMs: 20,
      coalesceWindowMs: 0,
    });
    enqueueReindex({
      projectRoot: '/proj',
      files: ['/proj/b.ts'],
      debounceMs: 20,
      coalesceWindowMs: 0,
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
    expect(indexServiceMock.mock.calls[0]?.[0]).toMatchObject({
      files: ['/proj/a.ts', '/proj/b.ts'],
    });
  });

  it('keeps different project indexes in separate batches', async () => {
    vi.useFakeTimers();
    enqueueReindex({
      projectRoot: '/proj-a',
      files: ['/proj-a/a.ts'],
      debounceMs: 20,
      coalesceWindowMs: 0,
    });
    enqueueReindex({
      projectRoot: '/proj-b',
      files: ['/proj-b/b.ts'],
      debounceMs: 20,
      coalesceWindowMs: 0,
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(indexServiceMock).toHaveBeenCalledTimes(2);
  });

  it('drops non-indexable files before scheduling', async () => {
    vi.useFakeTimers();
    // plain assets are still filtered; markdown/source-like files are indexable
    enqueueReindex({
      projectRoot: '/proj',
      files: ['/proj/photo.png', '/proj/notes.txt'],
      debounceMs: 20,
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(indexServiceMock).not.toHaveBeenCalled();
  });

  it('schedules extended languages such as markdown', async () => {
    vi.useFakeTimers();
    enqueueReindex({
      projectRoot: '/proj',
      files: ['/proj/README.md'],
      debounceMs: 20,
      coalesceWindowMs: 0,
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
    expect(indexServiceMock.mock.calls[0]?.[0]).toMatchObject({ files: ['/proj/README.md'] });
  });

  it('routes reindex failures to onError, never throwing', async () => {
    vi.useFakeTimers();
    indexServiceMock.mockRejectedValueOnce(new Error('boom'));
    const onError = vi.fn();
    enqueueReindex({
      projectRoot: '/proj',
      files: ['/proj/a.ts'],
      debounceMs: 10,
      coalesceWindowMs: 0,
      onError,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueReindex staggered-burst coalescing', () => {
  // Three-tier debounce:
  //   1. Per-file setTimeout(debounceMs) — resets on re-edit of the same file.
  //   2. Per-project coalescing window (default 50ms, sliding) — after a file's
  //      debounce timer fires, the ready batch stays open for this long. Any
  //      file arriving within the window joins the batch and resets the timer.
  //   3. Mutex serialization — the batch flush acquires the write mutex and
  //      dispatches one callIndexOp('index', …).
  //
  // Timing convention: advances past a boundary use a 10ms margin so both the
  // setTimeout callback and the async indexServiceMock settle within the same
  // advanceTimersByTimeAsync call.

  it('a staggered two-file burst coalesces into one run within the window', async () => {
    vi.useFakeTimers();
    // coalesceWindowMs defaults to 50ms.
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/a.ts'], debounceMs: 100 });
    await vi.advanceTimersByTimeAsync(50); // t=50: A's timer (at t=100) hasn't fired.
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/b.ts'], debounceMs: 100 });
    // t=110 (10ms past A's timer at t=100): A enters the batch. Coalesce window
    // (50ms) starts ticking — batch would flush at t=150, but B's timer fires
    // at t=150, within the window, so it joins and resets the window to t=200.
    await vi.advanceTimersByTimeAsync(60);
    // t=170: B has entered the batch at t=150 and reset the window. No flush yet.
    expect(indexServiceMock).not.toHaveBeenCalled();
    // Advance to t=210 (10ms past the reset window flush at t=200).
    await vi.advanceTimersByTimeAsync(100);
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
    expect(indexServiceMock.mock.calls[0]?.[0]).toMatchObject({
      files: ['/proj/a.ts', '/proj/b.ts'],
    });
  });

  it('three files in a staggered burst coalesce into one run', async () => {
    vi.useFakeTimers();
    const debounceMs = 100;
    const stepMs = 30;

    // Enqueue f0 at t=0, f1 at t=30, f2 at t=60 — debounce timers fire at
    // t=100, t=130, t=160. Each arrives within the 50ms coalesce window of
    // the previous, so the sliding window stays open until t=160+50 = t=210.
    for (let i = 0; i < 3; i++) {
      enqueueReindex({ projectRoot: '/proj', files: [`/proj/f${i}.ts`], debounceMs });
      if (i < 2) await vi.advanceTimersByTimeAsync(stepMs);
    }
    // Advance to t=160 — all three debounce timers have fired, each joining
    // the batch. Window slides to t=160+50 = t=210. No flush yet.
    await vi.advanceTimersByTimeAsync(100);
    expect(indexServiceMock).not.toHaveBeenCalled();
    // Advance past t=210 (10ms margin).
    await vi.advanceTimersByTimeAsync(60);
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
    expect(indexServiceMock.mock.calls[0]?.[0]).toMatchObject({
      files: ['/proj/f0.ts', '/proj/f1.ts', '/proj/f2.ts'],
    });
  });

  it('a file arriving after the window closes starts a new batch', async () => {
    vi.useFakeTimers();
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/a.ts'], debounceMs: 50 });
    // t=60: A's timer fired at t=50, entered the batch, window ticks until t=100.
    await vi.advanceTimersByTimeAsync(60);
    // t=120 (10ms past the window at t=100): A flushes alone.
    await vi.advanceTimersByTimeAsync(60);
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
    expect(indexServiceMock.mock.calls[0]?.[0]).toMatchObject({ files: ['/proj/a.ts'] });
    // B arrives well after A's batch flushed — starts a fresh batch.
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/b.ts'], debounceMs: 50 });
    // t=230: B's timer fires at t=170, window ticks until t=220, flush at t=230.
    await vi.advanceTimersByTimeAsync(110);
    expect(indexServiceMock).toHaveBeenCalledTimes(2);
    expect(indexServiceMock.mock.calls[1]?.[0]).toMatchObject({ files: ['/proj/b.ts'] });
  });

  it('files whose timers fire simultaneously still coalesce', async () => {
    vi.useFakeTimers();
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/a.ts'], debounceMs: 100 });
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/b.ts'], debounceMs: 100 });
    // Both timers fire at t=100, both enter the batch. Window (50ms) starts
    // ticking from the first arrival; flush at t=150 + 10ms margin.
    await vi.advanceTimersByTimeAsync(160);
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
    expect(indexServiceMock.mock.calls[0]?.[0]).toMatchObject({
      files: ['/proj/a.ts', '/proj/b.ts'],
    });
  });

  it('re-editing a file within the debounce window resets its timer', async () => {
    vi.useFakeTimers();
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/a.ts'], debounceMs: 100 });
    await vi.advanceTimersByTimeAsync(80); // t=80: 20ms left on the timer.
    // Re-enqueue — old timer is cleared, new one set for 100ms from t=80 (t=180).
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/a.ts'], debounceMs: 100 });
    // Advance to t=130 — original timer would have fired at t=100, but the
    // reset pushed the deadline to t=180. Nothing should have run yet.
    await vi.advanceTimersByTimeAsync(50);
    expect(indexServiceMock).not.toHaveBeenCalled();
    // Advance to t=240: debounce fires at t=180, enters batch, window flushes
    // at t=180+50 = t=230, plus 10ms margin.
    await vi.advanceTimersByTimeAsync(110);
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
    expect(indexServiceMock.mock.calls[0]?.[0]).toMatchObject({ files: ['/proj/a.ts'] });
  });

  it('staggered bursts across two projects coalesce independently', async () => {
    vi.useFakeTimers();
    enqueueReindex({ projectRoot: '/proj-a', files: ['/proj-a/a.ts'], debounceMs: 100 });
    await vi.advanceTimersByTimeAsync(50); // t=50
    enqueueReindex({ projectRoot: '/proj-b', files: ['/proj-b/b.ts'], debounceMs: 100 });
    // t=110: proj-a's timer fires at t=100, enters batch. proj-b's timer fires
    // at t=150. Each project has its own coalesce window; they don't interfere.
    await vi.advanceTimersByTimeAsync(60);
    // proj-a window flushes at t=150 (50ms after t=100). 10ms margin → t=160.
    await vi.advanceTimersByTimeAsync(50);
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
    expect(indexServiceMock.mock.calls[0]?.[0]).toMatchObject({
      projectRoot: '/proj-a',
      files: ['/proj-a/a.ts'],
    });
    // proj-b window flushes at t=200 (50ms after t=150). 10ms margin → t=210.
    await vi.advanceTimersByTimeAsync(50);
    expect(indexServiceMock).toHaveBeenCalledTimes(2);
    expect(indexServiceMock.mock.calls[1]?.[0]).toMatchObject({
      projectRoot: '/proj-b',
      files: ['/proj-b/b.ts'],
    });
  });

  it('coalesceWindowMs=0 falls back to immediate flush (no coalescing)', async () => {
    // Setting coalesceWindowMs to 0 restores the legacy behavior: each file's
    // debounce timer fires and flushes independently (no trailing window).
    vi.useFakeTimers();
    enqueueReindex({
      projectRoot: '/proj',
      files: ['/proj/a.ts'],
      debounceMs: 100,
      coalesceWindowMs: 0,
    });
    await vi.advanceTimersByTimeAsync(50);
    enqueueReindex({
      projectRoot: '/proj',
      files: ['/proj/b.ts'],
      debounceMs: 100,
      coalesceWindowMs: 0,
    });
    // t=110: A's timer fires at t=100, window=0 means flush fires in the next
    // macrotask. B's timer hasn't fired yet (fires at t=150).
    await vi.advanceTimersByTimeAsync(60);
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
    expect(indexServiceMock.mock.calls[0]?.[0]).toMatchObject({ files: ['/proj/a.ts'] });
    // t=160: B's timer fires at t=150, flushes alone.
    await vi.advanceTimersByTimeAsync(50);
    expect(indexServiceMock).toHaveBeenCalledTimes(2);
    expect(indexServiceMock.mock.calls[1]?.[0]).toMatchObject({ files: ['/proj/b.ts'] });
  });

  it('explicit coalesceWindowMs overrides the default', async () => {
    vi.useFakeTimers();
    // Use a 100ms window so files arriving 80ms apart still coalesce.
    enqueueReindex({
      projectRoot: '/proj',
      files: ['/proj/a.ts'],
      debounceMs: 100,
      coalesceWindowMs: 100,
    });
    await vi.advanceTimersByTimeAsync(80); // t=80
    enqueueReindex({
      projectRoot: '/proj',
      files: ['/proj/b.ts'],
      debounceMs: 100,
      coalesceWindowMs: 100,
    });
    // A's timer fires at t=100, window (100ms) closes at t=200. B's timer fires
    // at t=180 (within the window) → joins the batch, resets window to t=280.
    await vi.advanceTimersByTimeAsync(30); // t=110
    expect(indexServiceMock).not.toHaveBeenCalled();
    // Advance to t=190 — B's timer fires at t=180, joins batch, resets window
    // to t=180+100 = t=280.
    await vi.advanceTimersByTimeAsync(80); // t=190
    expect(indexServiceMock).not.toHaveBeenCalled();
    // Flush at t=280 + 10ms margin.
    await vi.advanceTimersByTimeAsync(100);
    expect(indexServiceMock).toHaveBeenCalledTimes(1);
    expect(indexServiceMock.mock.calls[0]?.[0]).toMatchObject({
      files: ['/proj/a.ts', '/proj/b.ts'],
    });
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
    enqueueReindex({
      projectRoot: '/proj',
      files: ['/proj/a.ts'],
      debounceMs: 10,
      coalesceWindowMs: 0,
      onError,
    });
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
