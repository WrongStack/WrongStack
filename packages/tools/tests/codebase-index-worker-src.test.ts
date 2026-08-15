import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the SRC worker entry (worker.ts) by faking the worker-thread port
// and the index services it dispatches to. The existing worker test runs the
// built dist instead, so src/worker.ts was uncovered.
const port = new EventEmitter() as EventEmitter & { postMessage: ReturnType<typeof vi.fn> };
port.postMessage = vi.fn();

const indexService = vi.fn();
const searchService = vi.fn(async () => ({ results: [] }));
const statsService = vi.fn(async () => ({ totalSymbols: 0 }));

vi.mock('node:worker_threads', async (orig) => ({
  ...(await orig<typeof import('node:worker_threads')>()),
  parentPort: port,
}));
vi.mock('../src/codebase-index/index-service.js', () => ({
  indexService: (...a: unknown[]) => indexService(...a),
  searchService: (...a: unknown[]) => searchService(...a),
  statsService: (...a: unknown[]) => statsService(...a),
}));

const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  port.postMessage.mockReset();
  indexService.mockReset();
  searchService.mockClear();
  statsService.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('codebase-index worker entry (src)', () => {
  it('registers a message handler on import', async () => {
    await import('../src/codebase-index/worker.js');
    expect(port.listenerCount('message')).toBeGreaterThan(0);
  });

  it('dispatches an index request and forwards progress', async () => {
    await import('../src/codebase-index/worker.js');
    indexService.mockImplementation(
      async (_args, optsArg: { onProgress: (c: number, t: number) => void }) => {
        optsArg.onProgress(1, 3);
        return { filesIndexed: 1 };
      },
    );
    port.emit('message', { type: 'request', id: 1, op: 'index', args: {} });
    await flush();
    const msgs = port.postMessage.mock.calls.map((c) => c[0] as { type: string; id: number });
    expect(msgs.some((m) => m.type === 'progress' && m.id === 1)).toBe(true);
    expect(msgs.some((m) => m.type === 'response' && m.id === 1)).toBe(true);
  });

  it('dispatches search and stats requests', async () => {
    await import('../src/codebase-index/worker.js');
    port.emit('message', { type: 'request', id: 2, op: 'search', args: {} });
    port.emit('message', { type: 'request', id: 3, op: 'stats', args: {} });
    await flush();
    expect(searchService).toHaveBeenCalled();
    expect(statsService).toHaveBeenCalled();
  });

  it('responds with an error for an unknown op', async () => {
    await import('../src/codebase-index/worker.js');
    port.emit('message', { type: 'request', id: 4, op: 'bogus', args: {} });
    await flush();
    const err = port.postMessage.mock.calls
      .map((c) => c[0] as { type: string; ok?: boolean; error?: string; id: number })
      .find((m) => m.id === 4);
    expect(err?.ok).toBe(false);
    expect(err?.error).toMatch(/unknown index op/);
  });

  it('responds with an error when a service rejects', async () => {
    await import('../src/codebase-index/worker.js');
    indexService.mockImplementation(async () => {
      throw new Error('parse exploded');
    });
    port.emit('message', { type: 'request', id: 5, op: 'index', args: {} });
    await flush();
    const err = port.postMessage.mock.calls
      .map((c) => c[0] as { ok?: boolean; error?: string; id: number })
      .find((m) => m.id === 5);
    expect(err?.ok).toBe(false);
    expect(err?.error).toMatch(/parse exploded/);
  });

  it('stringifies a non-Error rejection', async () => {
    await import('../src/codebase-index/worker.js');
    indexService.mockImplementation(() => Promise.reject('plain string failure') as Promise<never>);
    port.emit('message', { type: 'request', id: 7, op: 'index', args: {} });
    await flush();
    const err = port.postMessage.mock.calls
      .map((c) => c[0] as { ok?: boolean; error?: string; id: number })
      .find((m) => m.id === 7);
    expect(err?.ok).toBe(false);
    expect(err?.error).toBe('plain string failure');
  });

  it('cancels an in-flight request', async () => {
    await import('../src/codebase-index/worker.js');
    let captured: AbortSignal | undefined;
    indexService.mockImplementation(
      (_args, optsArg: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          captured = optsArg.signal;
          optsArg.signal.addEventListener('abort', () => resolve({ cancelled: true }));
        }),
    );
    port.emit('message', { type: 'request', id: 6, op: 'index', args: {} });
    await flush();
    port.emit('message', { type: 'cancel', id: 6 });
    await flush();
    expect(captured?.aborted).toBe(true);
  });
});
