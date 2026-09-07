import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  getState: vi.fn(),
  onEvent: vi.fn(),
  onStateChange: vi.fn(),
}));

let eventListener:
  | ((event: string, payload: unknown, meta?: { traceId?: string; sessionId?: string }) => void)
  | undefined;
const unsubscribeEvent = vi.fn();

vi.mock('../src/project-server-client.js', () => ({
  SageProjectServerConnection: class SageProjectServerConnectionMock {
    constructor(
      readonly projectRoot: string,
      readonly directory?: string,
    ) {}

    call = mocks.call;
    close = mocks.close;
    connect = mocks.connect;
    getState = mocks.getState;
    onStateChange = mocks.onStateChange;
    onEvent(listener: typeof eventListener): () => void {
      eventListener = listener;
      mocks.onEvent(listener);
      return unsubscribeEvent;
    }
  },
}));

import { ProjectSageMemoryPort } from '../src/remote-memory-port.js';

describe('ProjectSageMemoryPort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventListener = undefined;
    mocks.getState.mockReturnValue({ status: 'connected', connected: true, pid: 42 });
    mocks.call.mockImplementation(async (op: string) => {
      if (op === 'ping') {
        return {
          pid: 42,
          clients: 2,
          pendingRequests: 1,
          storageRoot: 'D:/repo/.wstack/sage',
          health: { status: 'healthy', backend: 'sqlite' },
        };
      }
      if (op === 'readAll') return 'all memories';
      if (op === 'list') return [{ id: 'm1' }];
      return undefined;
    });
  });

  it('forwards memory operations with trace/session metadata and no workspace override', async () => {
    const emit = vi.fn();
    const port = new ProjectSageMemoryPort({
      projectRoot: 'D:/repo',
      directory: 'D:/sage',
      workspaceRoot: 'D:/forged',
      clientId: 'client-1',
      getSessionId: () => 'session-1',
      events: { emit } as never,
    }).withTraceId('trace-1');

    await port.initialize();
    await expect(port.readAll()).resolves.toBe('all memories');
    await port.remember('Keep one owner', 'project' as never, { tags: ['ipc'] });
    await expect(port.list('project' as never, 5)).resolves.toEqual([{ id: 'm1' }]);

    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.call).toHaveBeenCalledWith(
      'remember',
      {
        text: 'Keep one owner',
        scope: 'project',
        metadata: { tags: ['ipc'] },
      },
      {
        meta: { clientId: 'client-1', traceId: 'trace-1', sessionId: 'session-1' },
      },
    );
    const allMetadata = mocks.call.mock.calls.map((call) => call[2]?.meta);
    expect(allMetadata.every((meta) => !('workspaceRoot' in meta))).toBe(true);

    eventListener?.('memory.changed', { id: 'm1' }, { traceId: 'server-trace' });
    expect(emit).toHaveBeenCalledWith('memory.changed', {
      id: 'm1',
      traceId: 'server-trace',
    });
  });

  it('exposes service capabilities, health details, and deterministic disposal', async () => {
    const port = new ProjectSageMemoryPort({ projectRoot: 'D:/repo', clientId: 'client-2' });
    const service = port.getCapability({ id: 'wrongstack.memory.sage-service.v1' } as never) as {
      readAll(): Promise<string>;
      search(query: string, scope?: unknown, limit?: number): Promise<unknown>;
    };
    const retrieval = port.getCapability({ id: 'wrongstack.memory.retrieval.v1' } as never) as {
      retrieveForPath(options: unknown): Promise<unknown>;
    };
    const surface = port.getCapability({ id: 'wrongstack.memory.surface.v1' } as never) as {
      stats(): Promise<unknown>;
    };

    await service.readAll();
    await service.search('owner', undefined, 3);
    await retrieval.retrieveForPath({ path: 'src/app.ts' });
    await surface.stats();
    expect(port.getCapability({ id: 'unknown' } as never)).toBeUndefined();
    await expect(port.health()).resolves.toEqual({
      status: 'healthy',
      backend: 'sage-project-server',
      details: {
        pid: 42,
        clients: 2,
        pendingRequests: 1,
        storageRoot: 'D:/repo/.wstack/sage',
        serverBackend: 'sqlite',
      },
    });
    expect(port.getBackend()).toEqual({
      kind: 'sage-project-server',
      connection: { status: 'connected', connected: true, pid: 42 },
    });

    await port.dispose();
    expect(unsubscribeEvent).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('forwards the complete MemoryPort surface with operation-specific timeouts', async () => {
    const port = new ProjectSageMemoryPort({ projectRoot: 'D:/repo', clientId: 'client-3' });
    const stateListener = vi.fn();
    mocks.onStateChange.mockReturnValue(() => undefined);

    expect(port.getConnectionState()).toEqual({ status: 'connected', connected: true, pid: 42 });
    expect(port.onConnectionStateChange(stateListener)).toBeTypeOf('function');
    expect(mocks.onStateChange).toHaveBeenCalledWith(stateListener);

    await port.read('project' as never);
    await port.forget('stale', 'project' as never);
    await port.consolidate('project' as never);
    await port.clear('session' as never);
    await port.search('owner', 'project' as never, 4);
    await port.findRelated('ownership', 'project' as never, 3);
    await port.scoreRelevant({ query: 'ipc' } as never, 'project' as never, 2);
    await port.hygiene({ dryRun: true } as never);

    expect(mocks.call.mock.calls.map(([op]) => op)).toEqual([
      'read',
      'forget',
      'consolidate',
      'clear',
      'search',
      'findRelated',
      'scoreRelevant',
      'hygiene',
    ]);
    expect(mocks.call).toHaveBeenCalledWith(
      'consolidate',
      { scope: 'project' },
      expect.objectContaining({ timeoutMs: 2 * 60_000 }),
    );
    expect(mocks.call).toHaveBeenCalledWith(
      'hygiene',
      { options: { dryRun: true }, automatic: true },
      expect.objectContaining({ timeoutMs: 5 * 60_000 }),
    );
  });

  it('routes retrieval and management capabilities without dropping arguments', async () => {
    const port = new ProjectSageMemoryPort({ projectRoot: 'D:/repo', clientId: 'client-4' });
    const retrieval = port.getCapability({ id: 'wrongstack.memory.retrieval.v1' } as never) as any;
    const surface = port.getCapability({ id: 'wrongstack.memory.surface.v1' } as never) as any;
    const service = port.getCapability({ id: 'wrongstack.memory.sage-service.v1' } as never) as any;
    const signal = new AbortController().signal;

    await retrieval.searchSage('needle', { limit: 2 });
    await retrieval.findRelatedSage(['m1']);
    await retrieval.findRelatedSage(['m1'], { limit: 3 });
    await retrieval.recordInjection(['m1'], 'prompt', 'session-4');
    await retrieval.recordUse(['m1'], 'tool', 'session-4');
    await retrieval.flushPendingCounters();
    await retrieval.retrieveForAudience({ role: 'assistant' }, 4, vi.fn(), 'session-4', true);

    await surface.listSage(['active']);
    await surface.listSagePage({ limit: 5 });
    await surface.getSage('m1');
    await surface.rememberSage({ text: 'remember' });
    await surface.updateSage('m1', { text: 'updated' });
    await surface.deleteSage('m1', 'obsolete', { hard: false });
    await surface.retrieveForPath({ path: 'src/app.ts' });
    await surface.searchSage('owner', { limit: 3 });
    await surface.acceptCandidate('c1');
    await surface.rejectCandidate('c2', 'duplicate');
    await surface.retrieveForAudience({ role: 'assistant' }, 2, vi.fn(), 'session-4', false);
    await surface.hygiene({ dryRun: true });
    await surface.listCandidates(true);
    await surface.createCandidate({ text: 'candidate' });
    await surface.graphFor('owner', 2, 10);
    await surface.verify('m1', signal);
    await surface.recoverSage('m1', 'restore');
    await surface.backfillRecoverable({ dryRun: true });
    await surface.findMemoriesForFile('src/app.ts', { limit: 5 });
    await surface.readAudit(20);
    await surface.importLegacy(['memory.md']);

    expect(mocks.call).toHaveBeenCalledWith(
      'findRelatedSage',
      { memoryIds: ['m1'] },
      expect.any(Object),
    );
    expect(mocks.call).toHaveBeenCalledWith(
      'verify',
      { memoryId: 'm1' },
      expect.objectContaining({ signal, timeoutMs: 2 * 60_000 }),
    );
    expect(mocks.call).toHaveBeenCalledWith(
      'importLegacyFiles',
      { files: ['memory.md'] },
      expect.objectContaining({ timeoutMs: 2 * 60_000 }),
    );

    expect(service.withTraceId('trace-4')).toBe(service);
    await service.unifiedSearchService('needle', { limit: 4 });
    await service.read('project' as never);
    await service.remember('text', 'project' as never);
    await service.forget('needle', 'project' as never);
    await service.consolidate('project' as never);
    await service.clear('session' as never);
    await service.list('project' as never, 5);
    expect(service.getBackend()).toBeDefined();
    await service.findRelated('text', 'project' as never, 3);
    await service.scoreRelevant({ query: 'ipc' } as never, 'project' as never, 2);
    await service.retrieveForPath({ path: 'src/app.ts' });
    await service.searchSage('needle', { limit: 2 });
    await service.retrieveForAudience({ role: 'assistant' }, 2, vi.fn(), 'session-4', false);
    await service.graphFor('needle', 2, 10);
    await service.verify('m1', signal);
    await service.listCandidates(true);
    await service.createCandidate({ text: 'cand' });
    await service.acceptCandidate('c1');
    await service.rejectCandidate('c1', 'reason');
    await service.rememberSage({ text: 'rem' });
    await service.updateSage('m1', { text: 'up' });
    await service.deleteSage('m1', 'reason', { hard: true });
    await service.recoverSage('m1', 'reason');
    await service.backfillRecoverable({ dryRun: true });
    await service.findMemoriesForFile('src/app.ts', { limit: 5 });
    await service.getSage('m1');
    await service.listSagePage({ limit: 5 });
    await service.resolveCandidate('c1', 'accepted', 'good');
    await service.hygiene({ dryRun: false }, signal);

    expect(mocks.call).toHaveBeenCalledWith(
      'resolveCandidate',
      { candidateId: 'c1', decision: 'accepted', reason: 'good' },
      expect.any(Object),
    );
    expect(mocks.call).toHaveBeenLastCalledWith(
      'hygiene',
      { options: { dryRun: false } },
      expect.objectContaining({
        signal,
        timeoutMs: 5 * 60_000,
        meta: expect.objectContaining({ traceId: 'trace-4' }),
      }),
    );
  });

  it('handles searchSageWithBreakdown success, daemon not-available fallback, and re-throw', async () => {
    const port = new ProjectSageMemoryPort({ projectRoot: 'D:/repo' });
    const retrieval = port.getCapability({ id: 'wrongstack.memory.retrieval.v1' } as never) as any;
    const surface = port.getCapability({ id: 'wrongstack.memory.surface.v1' } as never) as any;
    const service = port.getCapability({ id: 'wrongstack.memory.sage-service.v1' } as never) as any;

    // 1. Success on retrieval capability
    mocks.call.mockResolvedValueOnce([{ memory: { id: 'm1' }, score: 0.9 }]);
    const res1 = await retrieval.searchSageWithBreakdown('test', { limit: 2 });
    expect(res1).toEqual([{ memory: { id: 'm1' }, score: 0.9 }]);

    // 2. "not available" error -> falls back to searchSage and maps lexical breakdown
    mocks.call.mockRejectedValueOnce(new Error('Operation searchSageWithBreakdown not available'));
    mocks.call.mockResolvedValueOnce([{ id: 'm1' }, { id: 'm2' }]);
    const res2 = await retrieval.searchSageWithBreakdown('test', { limit: 2 });
    expect(res2).toHaveLength(2);
    expect(res2[0]).toMatchObject({ memory: { id: 'm1' }, source: 'lexical', finalScore: 1 });
    expect(res2[1]).toMatchObject({ memory: { id: 'm2' }, source: 'lexical', finalScore: 0 });

    // Single item edge case (total <= 1)
    mocks.call.mockRejectedValueOnce(new Error('searchSageWithBreakdown not available'));
    mocks.call.mockResolvedValueOnce([{ id: 'm1' }]);
    const res2single = await retrieval.searchSageWithBreakdown('test', { limit: 1 });
    expect(res2single[0]?.finalScore).toBe(1);

    // 3. Other error -> re-thrown
    mocks.call.mockRejectedValueOnce(new Error('database error'));
    await expect(retrieval.searchSageWithBreakdown('test', { limit: 2 })).rejects.toThrow(
      'database error',
    );

    // 4. surface.searchSageWithBreakdown maps rows directly
    mocks.call.mockResolvedValueOnce([{ id: 'm1' }, { id: 'm2' }]);
    const res3 = await surface.searchSageWithBreakdown('test', { limit: 2 });
    expect(res3).toHaveLength(2);

    // 5. service.searchSageWithBreakdown maps rows directly
    mocks.call.mockResolvedValueOnce([{ id: 'm1' }]);
    const res4 = await service.searchSageWithBreakdown('test', { limit: 2 });
    expect(res4).toHaveLength(1);
  });

  it('enriches event payload with meta traceId and sessionId when omitted in payload', async () => {
    const emit = vi.fn();
    const port = new ProjectSageMemoryPort({
      projectRoot: 'D:/repo',
      events: { emit } as never,
    });

    // Enriches when missing
    eventListener?.('memory.test', { id: 'm1' }, { traceId: 't1', sessionId: 's1' });
    expect(emit).toHaveBeenCalledWith('memory.test', { id: 'm1', traceId: 't1', sessionId: 's1' });

    // Preserves when already present
    emit.mockClear();
    eventListener?.(
      'memory.test',
      { id: 'm2', traceId: 't-existing', sessionId: 's-existing' },
      { traceId: 't1', sessionId: 's1' },
    );
    expect(emit).toHaveBeenCalledWith('memory.test', {
      id: 'm2',
      traceId: 't-existing',
      sessionId: 's-existing',
    });

    // Handles non-object payload
    emit.mockClear();
    eventListener?.('memory.primitive', 'simple-payload', { traceId: 't1' });
    expect(emit).toHaveBeenCalledWith('memory.primitive', 'simple-payload');

    await port.dispose();

    // When events is undefined
    const portWithoutEvents = new ProjectSageMemoryPort({ projectRoot: 'D:/repo' });
    eventListener?.('memory.no_events', { id: 'm1' });
    await portWithoutEvents.dispose();
  });

  it('reports an unavailable health result when the daemon call fails', async () => {
    mocks.call.mockRejectedValueOnce(new Error('daemon unavailable'));
    const port = new ProjectSageMemoryPort({ projectRoot: 'D:/repo' });
    await expect(port.health()).resolves.toEqual({
      status: 'unavailable',
      backend: 'sage-project-server',
      details: { error: 'daemon unavailable' },
    });
  });
});
