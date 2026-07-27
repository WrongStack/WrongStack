/**
 * Worker-path coverage for the index host. The existing background-indexer test
 * runs entirely inline (from source no built worker.js exists). Here we mock
 * `node:fs.existsSync` so resolveWorkerUrl finds a worker file and mock
 * `node:worker_threads.Worker` with a controllable fake, exercising
 * ensureWorker, the RPC round-trip, progress forwarding, error/exit handling,
 * the watchdog terminate, cancel propagation, and shutdown.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostToWorker,
  SearchOpArgs,
  StatsOpArgs,
  WorkerToHost,
} from '../src/codebase-index/worker-protocol.js';

const hoisted = vi.hoisted(() => {
  const OK_RESULT = { filesIndexed: 2, symbolsIndexed: 5, langStats: {}, durationMs: 1, errors: [] };
  // Self-contained emitter: vi.hoisted runs before static imports init, so we
  // can't `extends EventEmitter` here.
  class FakeWorker {
    static instances: FakeWorker[] = [];
    static throwOnConstruct = false;
    static terminateRejects = false;
    private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
    postMessage = vi.fn();
    unref = vi.fn();
    terminate = vi.fn(async () => {
      if (FakeWorker.terminateRejects) throw new Error('terminate failed');
    });
    constructor(_url: URL, _opts?: unknown) {
      if (FakeWorker.throwOnConstruct) throw new Error('spawn failed');
      FakeWorker.instances.push(this);
    }
    on(event: string, fn: (...a: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
  }
  return { FakeWorker, OK_RESULT, indexServiceMock: vi.fn(async () => OK_RESULT) };
});
const { FakeWorker, OK_RESULT, indexServiceMock } = hoisted;

vi.mock('node:worker_threads', async (orig) => ({
  ...(await orig<typeof import('node:worker_threads')>()),
  Worker: FakeWorker,
}));
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, existsSync: () => true, default: { ...actual, existsSync: () => true } };
});
vi.mock('../src/codebase-index/index-service.js', () => ({
  indexService: (...a: unknown[]) => indexServiceMock(...a),
  searchService: vi.fn(async () => ({ results: [], total: 0 })),
  statsService: vi.fn(async () => ({ totalSymbols: 0 })),
}));

// This suite intentionally exercises the legacy worker fallback. The mocked
// existsSync() also makes the new built project-server entry appear present,
// so opt out of the server transport before importing the host.
process.env['WRONGSTACK_INDEX_SERVER'] = '0';

const {
  runStartupIndex,
  searchCodebaseIndex,
  codebaseIndexStats,
  shutdownCodebaseIndexHost,
  onIndexStateChange,
  getIndexState,
  isIndexReady,
  setIndexReady,
} = await import('../src/codebase-index/background-indexer.js');
const { resetIndexCircuitBreaker, IndexTimeoutError } = await import(
  '../src/codebase-index/circuit-breaker.js'
);

const SEARCH_ARGS: SearchOpArgs = { projectRoot: '/proj', query: 'foo', limit: 10 };
const STATS_ARGS: StatsOpArgs = { projectRoot: '/proj' };

const tick = () => new Promise((r) => setTimeout(r, 0));
const lastWorker = () => FakeWorker.instances[FakeWorker.instances.length - 1]!;
const lastRequest = (w: FakeWorker): Extract<HostToWorker, { type: 'request' }> =>
  w.postMessage.mock.calls.map((c) => c[0] as HostToWorker).find((m) => m.type === 'request') as never;
const respond = (w: FakeWorker, msg: WorkerToHost) => w.emit('message', msg);

beforeEach(async () => {
  FakeWorker.instances = [];
  FakeWorker.throwOnConstruct = false;
  FakeWorker.terminateRejects = false;
  indexServiceMock.mockClear();
  resetIndexCircuitBreaker();
  // Reset module-level worker/unavailable flags.
  await shutdownCodebaseIndexHost();
});
afterEach(async () => {
  await shutdownCodebaseIndexHost();
  vi.useRealTimers();
});

afterAll(() => {
  delete process.env['WRONGSTACK_INDEX_SERVER'];
});

describe('worker RPC round-trip', () => {
  it('spawns one worker, unrefs it, and resolves a search response', async () => {
    const p = searchCodebaseIndex(SEARCH_ARGS);
    await tick();
    const w = lastWorker();
    expect(w.unref).toHaveBeenCalled();
    const req = lastRequest(w);
    expect(req.op).toBe('search');
    respond(w, { type: 'response', id: req.id, ok: true, result: { results: [], total: 0 } });
    await expect(p).resolves.toEqual({ results: [], total: 0 });
  });

  it('reuses the same worker across calls', async () => {
    const p1 = searchCodebaseIndex(SEARCH_ARGS);
    await tick();
    const w = lastWorker();
    respond(w, { type: 'response', id: lastRequest(w).id, ok: true, result: { results: [], total: 0 } });
    await p1;
    const p2 = codebaseIndexStats(STATS_ARGS);
    await tick();
    expect(FakeWorker.instances.length).toBe(1); // no new worker
    const req2 = w.postMessage.mock.calls
      .map((c) => c[0] as HostToWorker)
      .reverse()
      .find((m) => m.type === 'request') as Extract<HostToWorker, { type: 'request' }>;
    respond(w, { type: 'response', id: req2.id, ok: true, result: { totalSymbols: 0 } });
    await expect(p2).resolves.toEqual({ totalSymbols: 0 });
  });

  it('rejects when the worker reports an error result', async () => {
    const p = searchCodebaseIndex(SEARCH_ARGS);
    await tick();
    const w = lastWorker();
    respond(w, { type: 'response', id: lastRequest(w).id, ok: false, error: 'boom' });
    await expect(p).rejects.toThrow('boom');
  });

  it('forwards progress messages and ignores responses for unknown ids', async () => {
    const states: number[] = [];
    const off = onIndexStateChange((s) => states.push(s.currentFile));
    const p = runStartupIndex({ projectRoot: '/proj' });
    await tick();
    const w = lastWorker();
    const req = lastRequest(w);
    respond(w, { type: 'progress', id: req.id, current: 3, total: 7 });
    respond(w, { type: 'progress', id: 999999, current: 1, total: 1 }); // unknown id → no-op
    respond(w, { type: 'response', id: 424242, ok: true, result: OK_RESULT }); // unknown id → no-op
    respond(w, { type: 'response', id: req.id, ok: true, result: OK_RESULT });
    await expect(p).resolves.toMatchObject({ filesIndexed: 2 });
    expect(states).toContain(3);
    off();
  });
});

describe('inline override', () => {
  it('never spawns a worker when WRONGSTACK_INDEX_INLINE is set', async () => {
    process.env['WRONGSTACK_INDEX_INLINE'] = '1';
    try {
      const res = await runStartupIndex({ projectRoot: '/proj' });
      expect(res).toMatchObject({ filesIndexed: 2 });
      expect(FakeWorker.instances.length).toBe(0); // resolveWorkerUrl → null
      expect(indexServiceMock).toHaveBeenCalled();
    } finally {
      delete process.env['WRONGSTACK_INDEX_INLINE'];
    }
  });
});

describe('worker lifecycle failures', () => {
  it("rejects all pending calls on the worker's error event", async () => {
    const p = searchCodebaseIndex(SEARCH_ARGS);
    await tick();
    lastWorker().emit('error', new Error('worker crashed'));
    await expect(p).rejects.toThrow('worker crashed');
  });

  it('rejects all pending calls when the worker exits', async () => {
    const p = searchCodebaseIndex(SEARCH_ARGS);
    await tick();
    lastWorker().emit('exit', 1);
    await expect(p).rejects.toThrow('worker exited');
  });

  it('falls back to inline when spawning the worker throws', async () => {
    FakeWorker.throwOnConstruct = true;
    const res = await runStartupIndex({ projectRoot: '/proj' });
    expect(res).toMatchObject({ filesIndexed: 2 });
    expect(indexServiceMock).toHaveBeenCalled(); // inline service path
  });
});

describe('watchdog + cancel', () => {
  it('terminates a wedged worker on watchdog timeout', async () => {
    const p = searchCodebaseIndex(SEARCH_ARGS, { timeoutMs: 20 });
    await tick();
    const w = lastWorker();
    await expect(p).rejects.toThrow(IndexTimeoutError);
    expect(w.terminate).toHaveBeenCalled();
  });

  it('swallows a terminate that rejects', async () => {
    FakeWorker.terminateRejects = true;
    const p = searchCodebaseIndex(SEARCH_ARGS, { timeoutMs: 20 });
    await tick();
    await expect(p).rejects.toThrow(IndexTimeoutError);
    await tick(); // let the terminate().catch settle
  });

  it('posts a cancel message when an in-flight call is aborted', async () => {
    const ac = new AbortController();
    const p = searchCodebaseIndex(SEARCH_ARGS, { signal: ac.signal });
    await tick();
    const w = lastWorker();
    ac.abort();
    const cancel = w.postMessage.mock.calls
      .map((c) => c[0] as HostToWorker)
      .find((m) => m.type === 'cancel');
    expect(cancel).toBeTruthy();
    respond(w, { type: 'response', id: lastRequest(w).id, ok: false, error: 'cancelled' });
    await expect(p).rejects.toThrow('cancelled');
  });

  it('rejects an already-aborted signal without ever posting a request', async () => {
    const ac = new AbortController();
    ac.abort();
    const p = searchCodebaseIndex(SEARCH_ARGS, { signal: ac.signal });
    const w = lastWorker();
    expect(w).toBeTruthy();
    expect(w!.postMessage.mock.calls.some((c) => (c[0] as HostToWorker).type === 'request')).toBe(false);
    // The promise rejects with the supplied reason verbatim — a DOMException
    // for `ac.abort()` with no reason, an Error for any other.
    await expect(p).rejects.toBeInstanceOf(DOMException);
  });
});

describe('state accessors', () => {
  it('isIndexReady / setIndexReady and getIndexState reflect module state', () => {
    setIndexReady();
    expect(isIndexReady()).toBe(true);
    const s = getIndexState();
    expect(s).toHaveProperty('circuit');
    expect(s).toHaveProperty('indexing');
  });
});
