import { describe, expect, it, vi } from 'vitest';
import {
  dispatchOperation,
  isShareableFullIndex,
  type OperationContext,
  preservesQueryCaches,
  runFullIndex,
} from '../src/codebase-index/project-server-operations.js';
import { ServerQueryCaches } from '../src/codebase-index/project-server-query-cache.js';
import type { ClientState } from '../src/codebase-index/project-server-types.js';

vi.mock('../src/codebase-index/index-service.js', () => ({
  indexService: vi.fn().mockImplementation(async (_args, opts) => {
    opts?.onProgress?.(1, 10);
    return { totalFiles: 10, parsedFiles: 10, indexedFiles: 10, durationMs: 50 };
  }),
  searchService: vi.fn().mockResolvedValue({ results: [{ file: 'a.ts' }], total: 1 }),
  contextService: vi.fn().mockResolvedValue({ context: 'code context' }),
  vectorSearchService: vi.fn().mockResolvedValue({ results: [] }),
  statsService: vi.fn().mockResolvedValue({ totalFiles: 5, totalSymbols: 25 }),
  packageGraphService: vi.fn().mockResolvedValue({ nodes: ['pkgA'], edges: [] }),
  fileGraphService: vi.fn().mockResolvedValue({ nodes: ['a.ts'], edges: [] }),
  symbolGraphService: vi.fn().mockResolvedValue({ nodes: ['Sym'], edges: [] }),
  incomingCallsService: vi.fn().mockResolvedValue({ calls: ['callerA'] }),
  outgoingCallsService: vi.fn().mockResolvedValue({ calls: ['calleeB'] }),
}));

function createClientState(): ClientState {
  return {
    socket: {} as never,
    buffer: Buffer.alloc(0),
    cancel: new Map(),
    cancelled: new Set(),
    watchExternal: false,
    debounceMs: 0,
    coalesceWindowMs: 0,
    lastSeenAt: Date.now(),
    binary: false,
  };
}

function createMockContext(): {
  ctx: OperationContext;
  sent: Array<{ state: ClientState; msg: unknown }>;
  writes: Array<{ preserveCaches: boolean }>;
} {
  const sent: Array<{ state: ClientState; msg: unknown }> = [];
  const writes: Array<{ preserveCaches: boolean }> = [];
  let activeFullIndex: ReturnType<OperationContext['getActiveFullIndex']> = null;
  const queryCaches = new ServerQueryCaches();

  const ctx: OperationContext = {
    projectRoot: '/test/project',
    indexDir: '/test/project/.codebase-index',
    queryCaches,
    getActivity: () => ({
      indexing: false,
      currentFile: 0,
      totalFiles: 0,
      generation: 1,
      currentOp: 'idle',
      lastIndexedAt: 0,
      updatedAt: null,
      lastError: null,
    }),
    withIndexWrite: async (job, options) => {
      writes.push(options);
      return job(() => {});
    },
    send: (state, msg) => {
      sent.push({ state, msg });
    },
    getActiveFullIndex: () => activeFullIndex,
    setActiveFullIndex: (active) => {
      activeFullIndex = active;
    },
  };

  return { ctx, sent, writes };
}

describe('preservesQueryCaches', () => {
  it('returns true only for non-force targeted file index runs', () => {
    expect(preservesQueryCaches({ files: ['a.ts'] } as never)).toBe(true);
    expect(preservesQueryCaches({ files: ['a.ts'], force: false } as never)).toBe(true);
    expect(preservesQueryCaches({ files: ['a.ts'], force: true } as never)).toBe(false);
    expect(preservesQueryCaches({ files: [] } as never)).toBe(false);
    expect(preservesQueryCaches({} as never)).toBe(false);
  });
});

describe('isShareableFullIndex', () => {
  it('identifies full shareable index requests', () => {
    expect(isShareableFullIndex({} as never)).toBe(true);
    expect(isShareableFullIndex({ force: false } as never)).toBe(true);
    expect(isShareableFullIndex({ force: true } as never)).toBe(false);
    expect(isShareableFullIndex({ files: ['a.ts'] } as never)).toBe(false);
    expect(isShareableFullIndex({ langs: ['ts'] } as never)).toBe(false);
    expect(isShareableFullIndex({ ignore: ['node_modules'] } as never)).toBe(false);
  });
});

describe('runFullIndex and shared indexing', () => {
  it('runs indexing and multiplexes to multiple subscribers', async () => {
    const { ctx, sent } = createMockContext();
    const state1 = createClientState();
    const state2 = createClientState();

    const p1 = runFullIndex(ctx, state1, 1, {} as never);
    const p2 = runFullIndex(ctx, state2, 2, {} as never);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ totalFiles: 10, parsedFiles: 10, indexedFiles: 10, durationMs: 50 });
    expect(r2).toEqual(r1);

    expect(sent).toEqual(
      expect.arrayContaining([
        { state: state1, msg: { type: 'progress', id: 1, current: 1, total: 10 } },
      ]),
    );
  });

  it('cancels the active controller when all subscribers cancel', async () => {
    const { ctx } = createMockContext();
    const state = createClientState();

    let jobStarted: () => void;
    const started = new Promise<void>((resolve) => {
      jobStarted = resolve;
    });

    ctx.withIndexWrite = (_job) => {
      jobStarted();
      return new Promise((_, reject) => {
        const check = setInterval(() => {
          if (state.cancelled.has(1)) {
            clearInterval(check);
            reject(new Error('Indexing cancelled'));
          }
        }, 10);
      });
    };

    const p = runFullIndex(ctx, state, 1, {} as never);
    await started;

    const cancelFn = state.cancel.get(1);
    expect(cancelFn).toBeDefined();
    cancelFn!();

    await expect(p).rejects.toThrow('Indexing cancelled');
  });
});

describe('dispatchOperation', () => {
  it('handles targeted non-shareable index and cancellation', async () => {
    const { ctx, writes } = createMockContext();
    const state = createClientState();

    const resPromise = dispatchOperation(ctx, state, {
      type: 'request',
      id: 1,
      op: 'index',
      args: { files: ['foo.ts'] } as never,
    });

    const cancelFn = state.cancel.get(1);
    expect(cancelFn).toBeDefined();
    cancelFn!();
    expect(state.cancelled.has(1)).toBe(true);

    const res = await resPromise;
    expect(res).toBeDefined();
    expect(writes[0]?.preserveCaches).toBe(true);
  });

  it('handles search and caches the result', async () => {
    const { ctx } = createMockContext();
    const state = createClientState();

    const res = await dispatchOperation(ctx, state, {
      type: 'request',
      id: 1,
      op: 'search',
      args: { query: 'test' } as never,
    });
    expect(res).toEqual({ results: [{ file: 'a.ts' }], total: 1 });
  });

  it('serves stale cached search when indexing is in progress', async () => {
    const { ctx } = createMockContext();
    const state = createClientState();
    ctx.queryCaches.searchCache.set(JSON.stringify({ query: 'stale-test' }), 1, {
      results: [{ file: 'cached.ts' }],
      total: 1,
    } as never);
    ctx.getActivity = () => ({
      indexing: true,
      currentFile: 1,
      totalFiles: 5,
      generation: 2,
      currentOp: 'index',
      lastIndexedAt: 0,
      updatedAt: Date.now(),
      lastError: null,
    });
    const res = (await dispatchOperation(ctx, state, {
      type: 'request',
      id: 1,
      op: 'search',
      args: { query: 'stale-test' } as never,
    })) as { stale?: boolean };
    expect(res?.stale).toBe(true);
  });

  it('handles context retrieval', async () => {
    const { ctx } = createMockContext();
    const state = createClientState();

    const res = await dispatchOperation(ctx, state, {
      type: 'request',
      id: 1,
      op: 'context',
      args: { prompt: 'foo' } as never,
    });
    expect(res).toEqual({ context: 'code context' });
  });

  it('handles vector search', async () => {
    const { ctx } = createMockContext();
    const state = createClientState();

    const res = await dispatchOperation(ctx, state, {
      type: 'request',
      id: 1,
      op: 'vectorSearch',
      args: { query: 'bar' } as never,
    });
    expect(res).toEqual({ results: [] });
  });

  it('handles stats and throws when indexing in progress', async () => {
    const { ctx } = createMockContext();
    const state = createClientState();

    const res = await dispatchOperation(ctx, state, {
      type: 'request',
      id: 1,
      op: 'stats',
      args: {} as never,
    });
    expect(res).toEqual({ totalFiles: 5, totalSymbols: 25 });

    ctx.getActivity = () => ({
      indexing: true,
      currentFile: 2,
      totalFiles: 10,
      generation: 1,
      currentOp: 'index',
      lastIndexedAt: 0,
      updatedAt: Date.now(),
      lastError: null,
    });

    await expect(
      dispatchOperation(ctx, state, {
        type: 'request',
        id: 2,
        op: 'stats',
        args: {} as never,
      }),
    ).rejects.toThrow(/Codebase index refresh in progress/);
  });

  it('handles packageGraph, fileGraph, and symbolGraph', async () => {
    const { ctx } = createMockContext();
    const state = createClientState();

    const pkgRes = await dispatchOperation(ctx, state, {
      type: 'request',
      id: 1,
      op: 'packageGraph',
      args: {} as never,
    });
    expect(pkgRes).toEqual({ nodes: ['pkgA'], edges: [] });

    const fileRes = await dispatchOperation(ctx, state, {
      type: 'request',
      id: 2,
      op: 'fileGraph',
      args: { packageFilter: 'pkgA' } as never,
    });
    expect(fileRes).toEqual({ nodes: ['a.ts'], edges: [] });

    const symRes = await dispatchOperation(ctx, state, {
      type: 'request',
      id: 3,
      op: 'symbolGraph',
      args: { fileFilter: 'a.ts' } as never,
    });
    expect(symRes).toEqual({ nodes: ['Sym'], edges: [] });
  });

  it('handles incomingCalls and outgoingCalls', async () => {
    const { ctx } = createMockContext();
    const state = createClientState();

    const inRes = await dispatchOperation(ctx, state, {
      type: 'request',
      id: 1,
      op: 'incomingCalls',
      args: { symbol: 'foo' } as never,
    });
    expect(inRes).toEqual({ calls: ['callerA'] });

    const outRes = await dispatchOperation(ctx, state, {
      type: 'request',
      id: 2,
      op: 'outgoingCalls',
      args: { symbol: 'foo' } as never,
    });
    expect(outRes).toEqual({ calls: ['calleeB'] });
  });

  it('throws on unknown operation', async () => {
    const { ctx } = createMockContext();
    const state = createClientState();

    await expect(
      dispatchOperation(ctx, state, {
        type: 'request',
        id: 1,
        op: 'unknown_op' as never,
        args: {} as never,
      }),
    ).rejects.toThrow(/unknown index operation/);
  });
});
