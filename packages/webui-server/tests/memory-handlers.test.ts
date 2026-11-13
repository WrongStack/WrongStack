import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from '../src/ws-runtime.js';

vi.mock('ws/native', async (importOriginal) => {
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  return { ...(await importOriginal<Record<string, unknown>>()), WebSocket: MockWebSocket };
});

const mockGetSageSurface = vi.hoisted(() => vi.fn((): any => null));
vi.mock('@wrongstack/sage', () => ({ getSageSurface: mockGetSageSurface }));

import {
  handleMemoryList,
  handleSageBackfillRecoverable,
  handleSageCandidateResolve,
  handleSageDelete,
  handleSageForFile,
  handleSageGet,
  handleSageGraph,
  handleSageList,
  handleSageListCandidates,
  handleSageListPage,
  handleSageRecover,
  handleSageRemember,
  handleSageSearchBreakdown,
  handleSageUpdate,
} from '../src/server/memory-handlers.js';

function mockWs(): any {
  return { readyState: WebSocket.OPEN, send: vi.fn() };
}

function msg(payload: Record<string, unknown> = {}) {
  return { payload } as any;
}

function makeSage(extra: Record<string, unknown> = {}) {
  return {
    stats: vi.fn(async () => ({
      total: 2,
      byStatus: { active: 1, stale: 0, archived: 1 },
      byKind: {},
      edges: 0,
    })),
    listSage: vi.fn(async () => [
      { id: 'mem-001', kind: 'fact', status: 'active', text: 'hello world', tags: ['t1'] },
      { id: 'mem-002', kind: 'decision', status: 'archived', text: 'old', tags: [] },
    ]),
    getSage: vi.fn(async () => null),
    updateSage: vi.fn(async (_id: string, _patch: Record<string, unknown>) => ({
      id: 'mem-001',
      kind: 'fact',
      status: 'active',
      text: 'updated',
      tags: [],
    })),
    rememberSage: vi.fn(async () => ({
      id: 'mem-003',
      kind: 'fact',
      status: 'active',
      text: 'new',
      tags: [],
    })),
    deleteSage: vi.fn(async () => undefined),
    acceptCandidate: vi.fn(async () => null),
    rejectCandidate: vi.fn(async () => null),
    graphFor: vi.fn(async () => []),
    findMemoriesForFile: vi.fn(async () => ({ primary: [], symbol: [], related: [] })),
    ...extra,
  };
}

describe('memory-handlers', () => {
  it('bounds preview roots and deduplicates persisted graph edges without a vector lookup', async () => {
    const edge = { from: 'mem:a', to: 'mem:b', relation: 'related_to', weight: 1 };
    const sage = makeSage({
      graphFor: vi.fn(async () => [edge]),
      getSage: vi.fn(async (id: string) => ({ id, text: 'preview' })),
    });
    mockGetSageSurface.mockReturnValue(sage);
    const ws = mockWs();
    await handleSageGraph(
      ws,
      msg({
        query: 'mem:a',
        roots: ['mem:a', 'mem:b', 'mem:a', 7, 'file:ignored'],
        summaryOnly: true,
      }),
      {} as any,
    );
    expect(sage.graphFor.mock.calls.map((call: unknown[]) => call[0])).toEqual(['mem:a', 'mem:b']);
    expect(JSON.parse(ws.send.mock.calls[0][0]).payload.edges).toHaveLength(1);
    const many = makeSage();
    mockGetSageSurface.mockReturnValue(many);
    await handleSageGraph(
      mockWs(),
      msg({ query: 'mem:a', roots: Array.from({ length: 55 }, (_, i) => 'mem:' + i) }),
      {} as any,
    );
    expect(many.graphFor).toHaveBeenCalledTimes(40);
  });
  it('returns bounded SAGE previews without record bodies when summaries are requested', async () => {
    const ws = mockWs();
    const sage = makeSage();
    mockGetSageSurface.mockReturnValue(sage);
    await handleSageListPage(ws, msg({ summaryOnly: true, requestId: 'summary-proof' }), {} as any);
    const payload = JSON.parse(ws.send.mock.calls[0][0]).payload;
    expect(payload.requestId).toBe('summary-proof');
    expect(payload.memories[0].text).toBeUndefined();
    expect(payload.memories[0].preview).toBe('hello world');
    expect(payload.total).toBe(2);
    expect(payload.stats.total).toBe(2);
  });
  it('returns stored graph edges with summary-only neighbors, retaining the full-record legacy response', async () => {
    const sage = makeSage({
      graphFor: vi.fn(async () => [
        { from: 'mem:one', to: 'mem:two', relation: 'supports', weight: 0.8 },
      ]),
      getSage: vi.fn(async (id: string) => ({
        id,
        text: 'A'.repeat(400),
        kind: 'fact',
        status: 'active',
        tags: [],
        sources: [{ content: 'full evidence' }],
      })),
    });
    mockGetSageSurface.mockReturnValue(sage);
    const ws = mockWs();
    await handleSageGraph(ws, msg({ query: 'mem:one', summaryOnly: true }), {} as any);
    const summary = JSON.parse(ws.send.mock.calls[0][0]).payload;
    expect(summary.edges[0].relation).toBe('supports');
    expect(summary.memories[0].text).toBeUndefined();
    expect(summary.memories[0].sources).toBeUndefined();
    expect(summary.memories[0].preview.length).toBeLessThanOrEqual(120);
    const legacy = mockWs();
    await handleSageGraph(legacy, msg({ query: 'mem:one' }), {} as any);
    expect(JSON.parse(legacy.send.mock.calls[0][0]).payload.memories[0].text).toHaveLength(400);
  });
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleMemoryList', () => {
    it('sends SAGE formatted text when SAGE is available', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(makeSage());
      await handleMemoryList(ws, { type: 'memory.list' }, { readAll: vi.fn() } as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('memory.list');
      expect(sent.payload.text).toContain('🧠 SAGE');
    });

    it('sends "SAGE is empty" when no memories', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue({
        stats: vi.fn(async () => ({ total: 0, byStatus: {}, byKind: {}, edges: 0 })),
        listSage: vi.fn(async () => []),
      });
      await handleMemoryList(ws, { type: 'memory.list' }, { readAll: vi.fn() } as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.text).toContain('empty');
    });

    it('falls back to readAll() when SAGE is not available', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(null);
      const store = { readAll: vi.fn(async () => 'plain text') } as any;
      await handleMemoryList(ws, { type: 'memory.list' }, store);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.text).toBe('plain text');
    });

    it('sends error text on exception', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue({
        stats: vi.fn(async () => {
          throw new Error('boom');
        }),
        listSage: vi.fn(async () => []),
      });
      await handleMemoryList(ws, { type: 'memory.list' }, { readAll: vi.fn() } as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toBeTruthy();
    });
  });

  describe('handleSageListCandidates', () => {
    it('requires SAGE surface', async () => {
      mockGetSageSurface.mockReturnValue(null);
      const ws = mockWs();
      await handleSageListCandidates(ws, msg(), {} as any);
      const frame = JSON.parse(ws.send.mock.calls[0][0]);
      expect(frame.type).toBe('memory.sage.listCandidates');
      expect(frame.payload.error).toMatch(/requires the SAGE/);
    });

    it('lists candidates from the surface', async () => {
      const candidates = [{ id: 'c1', status: 'pending', text: 'review me' }];
      mockGetSageSurface.mockReturnValue({
        listCandidates: vi.fn(async () => candidates),
      });
      const ws = mockWs();
      await handleSageListCandidates(ws, msg({ includeResolved: false }), {} as any);
      const frame = JSON.parse(ws.send.mock.calls[0][0]);
      expect(frame.type).toBe('memory.sage.listCandidates');
      expect(frame.payload.candidates).toEqual(candidates);
    });
  });

  describe('handleSageList', () => {
    it('sends error when SAGE is not available', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(null);
      await handleSageList(ws, { type: 'memory.sage.list' }, {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toContain('SAGE');
    });

    it('sends memories and stats on success', async () => {
      const ws = mockWs();
      const sage = makeSage();
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageList(ws, { type: 'memory.sage.list' }, {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.memories).toHaveLength(2);
      expect(sent.payload.stats.total).toBe(2);
    });

    it('sends error on exception', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue({
        stats: vi.fn(async () => {
          throw new Error('fail');
        }),
        listSage: vi.fn(async () => []),
      });
      await handleSageList(ws, { type: 'memory.sage.list' }, {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toBe('fail');
    });
  });

  describe('handleSageListPage', () => {
    it('sends error when SAGE is not available', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(null);
      await handleSageListPage(ws, msg(), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toContain('SAGE');
    });

    it('uses listSagePage when available', async () => {
      const ws = mockWs();
      const sage = makeSage({
        listSagePage: vi.fn(async () => ({ memories: [], nextCursor: 'cur', total: 0 })),
      });
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageListPage(ws, msg({ limit: 10 }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.nextCursor).toBe('cur');
      expect(sent.payload.stats).toBeDefined();
    });

    // Sage.stats() is a store-wide aggregate that search/filter reloads do not
    // change; the WebUI opts out with includeStats:false on every keystroke.
    it('skips the store-wide stats when includeStats is false', async () => {
      const ws = mockWs();
      const sage = makeSage({
        listSagePage: vi.fn(async () => ({
          memories: [],
          nextCursor: null,
          total: 0,
          statusCounts: { active: 1 },
        })),
      });
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageListPage(ws, msg({ query: 'x', includeStats: false }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sage.stats).not.toHaveBeenCalled();
      expect(sent.payload.stats).toBeUndefined();
      expect(sent.payload.statusCounts).toEqual({ active: 1 });
    });

    it('skips stats on the emulated path when includeStats is false', async () => {
      const ws = mockWs();
      const sage = makeSage();
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageListPage(ws, msg({ includeStats: false }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sage.stats).not.toHaveBeenCalled();
      expect(sent.payload.stats).toBeUndefined();
      expect(sent.payload.memories.length).toBeGreaterThan(0);
    });

    it('forwards statuses to listSagePage', async () => {
      const ws = mockWs();
      const listSagePage = vi.fn(async () => ({ memories: [], nextCursor: null, total: 0 }));
      mockGetSageSurface.mockReturnValue(makeSage({ listSagePage }));
      await handleSageListPage(ws, msg({ statuses: ['stale'] }), {} as any);
      expect(listSagePage).toHaveBeenCalledWith(expect.objectContaining({ statuses: ['stale'] }));
    });

    it('emulates pagination when listSagePage is absent', async () => {
      const ws = mockWs();
      const sage = makeSage();
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageListPage(ws, msg({ limit: 1 }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.memories).toHaveLength(1);
    });

    it('filters by status', async () => {
      const ws = mockWs();
      const sage = makeSage();
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageListPage(ws, msg({ statuses: ['archived'] }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.memories.every((m: any) => m.status === 'archived')).toBe(true);
    });

    it('filters by kind', async () => {
      const ws = mockWs();
      const sage = makeSage();
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageListPage(ws, msg({ kind: 'fact' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.memories.every((m: any) => m.kind === 'fact')).toBe(true);
    });

    it('filters by query text', async () => {
      const ws = mockWs();
      const sage = makeSage();
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageListPage(ws, msg({ query: 'hello' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.memories.length).toBeGreaterThanOrEqual(1);
    });

    it('sends error on exception', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue({
        listSage: vi.fn(async () => {
          throw new Error('db');
        }),
        stats: vi.fn(async () => ({ total: 0 })),
      });
      await handleSageListPage(ws, msg(), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toBe('db');
    });
  });

  describe('handleSageGet', () => {
    it('sends error when SAGE is not available', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(null);
      await handleSageGet(ws, msg({ id: 'x' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toContain('SAGE');
    });

    it('sends error when id is missing', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(makeSage());
      await handleSageGet(ws, msg({}), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toBe('id is required');
    });

    it('answers a payload-less frame with a structured error, not a throw', async () => {
      // The protocol decoder only requires a payload for server-direction
      // frames, so client frames can arrive without one (same class the
      // candidateResolve handler documents). The handler must answer with the
      // same "id is required" frame instead of throwing a TypeError from the
      // unguarded destructure, which escapes the handler and leaves the
      // client without any response.
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(makeSage());
      await handleSageGet(ws, { type: 'memory.sage.get' } as any, {} as any);
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('memory.sage.get');
      expect(sent.payload.error).toBe('id is required');
    });

    it('sends error when memory not found', async () => {
      const ws = mockWs();
      const sage = makeSage({ getSage: vi.fn(async () => null) });
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageGet(ws, msg({ id: 'gone' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toContain('not found');
    });

    it('sends memory on success', async () => {
      const ws = mockWs();
      const sage = makeSage({
        getSage: vi.fn(async () => ({
          id: 'mem-1',
          kind: 'fact',
          status: 'active',
          text: 'hi',
          tags: [],
        })),
      });
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageGet(ws, msg({ id: 'mem-1' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.memory.id).toBe('mem-1');
    });
  });

  describe('handleSageGraph', () => {
    it('sends error when graphFor is not available', async () => {
      const ws = mockWs();
      // makeSage() includes a graphFor stub; override it to undefined.
      const sage = makeSage();
      delete (sage as any).graphFor;
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageGraph(ws, msg({ query: 'x' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toBeTruthy();
    });

    it('sends error when query is empty', async () => {
      const ws = mockWs();
      const sage = makeSage({ graphFor: vi.fn(async () => []) });
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageGraph(ws, msg({}), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toBe('query is required');
    });

    it('returns edges and memories', async () => {
      const ws = mockWs();
      const sage = makeSage({
        graphFor: vi.fn(async () => [{ from: 'mem:abc', to: 'mem:def', relation: 'rel' }]),
        getSage: vi.fn(async () => ({
          id: 'abc',
          kind: 'fact',
          status: 'active',
          text: 't',
          tags: [],
        })),
      });
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageGraph(ws, msg({ query: 'test' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.edges).toHaveLength(1);
      expect(sent.payload.memories.length).toBeGreaterThanOrEqual(1);
    });

    it('sends error on exception', async () => {
      const ws = mockWs();
      const sage = makeSage({
        graphFor: vi.fn(async () => {
          throw new Error('graph-fail');
        }),
      });
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageGraph(ws, msg({ query: 'test' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toBe('graph-fail');
    });
  });

  describe('handleSageUpdate', () => {
    it('sends error when id missing', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(makeSage());
      await handleSageUpdate(ws, msg({}), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toBe('id is required');
    });

    it('sends error when no fields to update', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(makeSage());
      await handleSageUpdate(ws, msg({ id: 'mem-1' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toContain('No fields');
    });

    it('updates and returns memory', async () => {
      const ws = mockWs();
      const sage = makeSage();
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageUpdate(ws, msg({ id: 'mem-1', text: 'new' }), {} as any);
      expect(sage.updateSage).toHaveBeenCalledWith('mem-1', { text: 'new' });
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.memory.id).toBe('mem-001');
    });
  });

  describe('handleSageRemember', () => {
    it('forwards applicability conditions without dropping them', async () => {
      const sage = makeSage();
      mockGetSageSurface.mockReturnValue(sage);
      const validity = {
        statement: 'Default policy only.',
        checks: [{ type: 'source_contains', path: 'retry.ts', text: 'quota = 3' }],
      };
      await handleSageRemember(
        mockWs(),
        msg({ text: 'Retry quota is three.', validity }),
        {} as any,
      );
      expect(sage.rememberSage).toHaveBeenCalledWith(expect.objectContaining({ validity }));
    });
    it('sends error when text is missing', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(makeSage());
      await handleSageRemember(ws, msg({}), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toBe('text is required');
    });

    it('creates and returns memory', async () => {
      const ws = mockWs();
      const sage = makeSage();
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageRemember(ws, msg({ text: 'new fact', kind: 'fact' }), {} as any);
      expect(sage.rememberSage).toHaveBeenCalled();
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.memory.id).toBe('mem-003');
    });
  });

  describe('handleSageDelete', () => {
    it.each(['success', 'protected', 'missing', 'unavailable'])(
      'correlates %s deletion replies without changing authorization',
      async (scenario) => {
        const ws = mockWs();
        const sage = makeSage({
          deleteSage: vi.fn(async () => {
            if (scenario === 'protected') throw new Error('Explicit authorization required');
          }),
        });
        mockGetSageSurface.mockReturnValue(scenario === 'unavailable' ? null : sage);
        await handleSageDelete(
          ws,
          msg({
            requestId: 'memory-delete-1',
            ...(scenario === 'missing' ? {} : { id: 'mem-1' }),
          }),
          {} as any,
        );
        const sent = JSON.parse(ws.send.mock.calls[0][0]);
        expect(sent.payload.requestId).toBe('memory-delete-1');
        expect(sent.payload.success).toBe(scenario === 'success');
        if (scenario === 'success' || scenario === 'protected')
          expect(sage.deleteSage).toHaveBeenCalledWith('mem-1', undefined, {
            force: false,
            neverInject: false,
          });
      },
    );
    it('sends error when id missing', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(makeSage());
      await handleSageDelete(ws, msg({}), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.success).toBe(false);
    });

    it('deletes with force default false', async () => {
      const ws = mockWs();
      const sage = makeSage();
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageDelete(ws, msg({ id: 'mem-1' }), {} as any);
      expect(sage.deleteSage).toHaveBeenCalledWith('mem-1', undefined, {
        force: false,
        neverInject: false,
      });
    });

    it('respects explicit force:true', async () => {
      const ws = mockWs();
      const sage = makeSage();
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageDelete(ws, msg({ id: 'mem-1', force: true, neverInject: true }), {} as any);
      expect(sage.deleteSage).toHaveBeenCalledWith('mem-1', undefined, {
        force: true,
        neverInject: true,
      });
    });
  });

  describe('handleSageRecover', () => {
    it('sends error when recoverSage is not available', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(makeSage());
      await handleSageRecover(ws, msg({ id: 'x' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toContain('SAGE');
    });

    it('sends error when id missing', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue({
        recoverSage: vi.fn(),
        getSage: vi.fn(async () => null),
      });
      await handleSageRecover(ws, msg({}), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toBe('id is required');
    });

    it('noop when already active', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue({
        recoverSage: vi.fn(),
        getSage: vi.fn(async () => ({
          id: 'mem-1',
          status: 'active',
          kind: 'fact',
          text: 't',
          tags: [],
        })),
      });
      await handleSageRecover(ws, msg({ id: 'mem-1' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.noop).toBe(true);
    });
  });

  describe('handleSageCandidateResolve', () => {
    it('sends error when candidateId missing', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(makeSage());
      await handleSageCandidateResolve(ws, msg({ action: 'accept' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toContain('candidateId');
    });

    it('sends error for invalid action', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(makeSage());
      await handleSageCandidateResolve(ws, msg({ candidateId: 'c1', action: 'bad' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toContain('action');
    });

    it('accepts a candidate', async () => {
      const ws = mockWs();
      const sage = makeSage({
        acceptCandidate: vi.fn(async () => ({ id: 'c1', status: 'active' })),
      });
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageCandidateResolve(ws, msg({ candidateId: 'c1', action: 'accept' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.candidate.id).toBe('c1');
      expect(sent.payload.resolvedAction).toBe('accept');
    });

    it('rejects a candidate', async () => {
      const ws = mockWs();
      const sage = makeSage({ rejectCandidate: vi.fn(async () => true) });
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageCandidateResolve(
        ws,
        msg({ candidateId: 'c1', action: 'reject', reason: 'dup' }),
        {} as any,
      );
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.resolvedAction).toBe('reject');
    });

    it('sends error when candidate not found', async () => {
      const ws = mockWs();
      const sage = makeSage({ acceptCandidate: vi.fn(async () => null) });
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageCandidateResolve(
        ws,
        msg({ candidateId: 'gone', action: 'accept' }),
        {} as any,
      );
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toContain('not found');
    });

    // The review queue runs several resolves; each wait must settle on its own
    // reply, so success AND failure frames echo the request's requestId.
    it('echoes requestId on success and failure responses', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(
        makeSage({ acceptCandidate: vi.fn(async () => ({ id: 'c1', status: 'active' })) }),
      );
      await handleSageCandidateResolve(
        ws,
        msg({ candidateId: 'c1', action: 'accept', requestId: 'req-ok' }),
        {} as any,
      );
      await handleSageCandidateResolve(
        ws,
        msg({ candidateId: 'c1', action: 'bad', requestId: 'req-bad' }),
        {} as any,
      );
      mockGetSageSurface.mockReturnValue(makeSage({ acceptCandidate: vi.fn(async () => null) }));
      await handleSageCandidateResolve(
        ws,
        msg({ candidateId: 'gone', action: 'accept', requestId: 'req-gone' }),
        {} as any,
      );
      const frames = ws.send.mock.calls.map((call: [string]) => JSON.parse(call[0]));
      expect(frames.map((f: any) => f.payload.requestId)).toEqual([
        'req-ok',
        'req-bad',
        'req-gone',
      ]);
      expect(frames[0].payload.resolvedAction).toBe('accept');
      expect(frames[1].payload.error).toContain('action');
      expect(frames[2].payload.error).toContain('not found');
    });
  });

  describe('handleSageBackfillRecoverable', () => {
    it('sends error when not available', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(makeSage());
      await handleSageBackfillRecoverable(ws, msg({}), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toContain('SAGE');
    });

    it('runs dry-run by default', async () => {
      const ws = mockWs();
      const sage = makeSage({
        backfillRecoverable: vi.fn(async () => ({ examined: 10, recovered: 0, recoverable: 5 })),
      });
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageBackfillRecoverable(ws, msg({}), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.dryRun).toBe(true);
      expect(sent.payload.examined).toBe(10);
    });

    it('applies when requested', async () => {
      const ws = mockWs();
      const sage = makeSage({
        backfillRecoverable: vi.fn(async () => ({ examined: 10, recovered: 5, recoverable: 5 })),
      });
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageBackfillRecoverable(ws, msg({ apply: true }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.dryRun).toBe(false);
    });
  });

  describe('handleSageForFile', () => {
    it('sends error when not available', async () => {
      const ws = mockWs();
      const sage = makeSage();
      delete (sage as any).findMemoriesForFile;
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageForFile(ws, msg({ filePath: 'x.ts' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toBeTruthy();
    });

    it('sends error when filePath missing', async () => {
      const ws = mockWs();
      const sage = makeSage({
        findMemoriesForFile: vi.fn(async () => ({ primary: [], symbol: [], related: [] })),
      });
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageForFile(ws, msg({}), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.error).toBe('filePath is required');
    });

    it('returns the bucketed response under payload.response', async () => {
      const ws = mockWs();
      const sage = makeSage({
        findMemoriesForFile: vi.fn(async () => ({
          filePath: 'src/x.ts',
          primaryMatches: [{ memory: { id: 'm1' }, matchedVia: 'anchor_file', matchStrength: 0.9 }],
          symbolMatches: [],
          relatedMatches: [],
          totalCount: 1,
          activeCount: 1,
          supersededCount: 0,
          reviewPendingCount: 0,
        })),
      });
      mockGetSageSurface.mockReturnValue(sage);
      await handleSageForFile(ws, msg({ filePath: 'src/x.ts' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.payload.response.primaryMatches).toHaveLength(1);
      expect(sent.payload.response.filePath).toBe('src/x.ts');
    });

    it('maps the wire showSuperseded / showDeleted flags onto store options', async () => {
      const ws = mockWs();
      const findMemoriesForFile = vi.fn(
        async (_filePath: string, _options?: Record<string, unknown>) => ({
          filePath: 'src/x.ts',
          primaryMatches: [],
          symbolMatches: [],
          relatedMatches: [],
          totalCount: 0,
          activeCount: 0,
          supersededCount: 0,
          reviewPendingCount: 0,
        }),
      );
      mockGetSageSurface.mockReturnValue(makeSage({ findMemoriesForFile }));
      await handleSageForFile(
        ws,
        msg({ filePath: 'src/x.ts', showSuperseded: false, showDeleted: true }),
        {} as any,
      );
      expect(findMemoriesForFile).toHaveBeenCalledWith(
        'src/x.ts',
        expect.objectContaining({ includeSuperseded: false, includeDeleted: true }),
      );
    });

    it('leaves includeSuperseded unset when the request omits the flag', async () => {
      const ws = mockWs();
      const findMemoriesForFile = vi.fn(
        async (_filePath: string, _options?: Record<string, unknown>) => ({
          filePath: 'src/x.ts',
          primaryMatches: [],
          symbolMatches: [],
          relatedMatches: [],
          totalCount: 0,
          activeCount: 0,
          supersededCount: 0,
          reviewPendingCount: 0,
        }),
      );
      mockGetSageSurface.mockReturnValue(makeSage({ findMemoriesForFile }));
      await handleSageForFile(ws, msg({ filePath: 'src/x.ts' }), {} as any);
      const options = findMemoriesForFile.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(options).not.toHaveProperty('includeSuperseded');
      expect(options).not.toHaveProperty('includeDeleted');
    });
  });

  describe('handleSageSearchBreakdown', () => {
    it('sends error when SAGE is not available', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(null);
      await handleSageSearchBreakdown(ws, msg({ query: 'pool' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0]![0] as string);
      expect(sent.payload.error).toContain('SAGE');
    });

    it('sends 400-style error when the query is empty', async () => {
      const ws = mockWs();
      mockGetSageSurface.mockReturnValue(makeSage());
      await handleSageSearchBreakdown(ws, msg({ query: '' }), {} as any);
      const sent = JSON.parse(ws.send.mock.calls[0]![0] as string);
      expect(sent.payload.error).toContain('Missing');
    });

    it('uses searchSageWithBreakdown when the surface implements it', async () => {
      const ws = mockWs();
      const searchSageWithBreakdown = vi.fn(async () => [
        {
          memory: { id: 'a', kind: 'fact', status: 'active', text: 'mem a', tags: [] },
          lexicalScore: 0.9,
          vectorScore: 0.7,
          finalScore: 0.8,
          source: 'both',
        },
      ]);
      mockGetSageSurface.mockReturnValue(makeSage({ searchSageWithBreakdown }));
      await handleSageSearchBreakdown(ws, msg({ query: 'pool', limit: 5 }), {} as any);
      expect(searchSageWithBreakdown).toHaveBeenCalledWith('pool', {
        limit: 5,
        includeStatuses: ['active'],
      });
      const sent = JSON.parse(ws.send.mock.calls[0]![0] as string);
      expect(sent.payload.source).toBe('breakdown');
      expect(sent.payload.hits).toHaveLength(1);
      expect(sent.payload.hits[0].source).toBe('both');
    });

    it('falls back to lexical-only synthesis when the rich variant is missing', async () => {
      const ws = mockWs();
      const searchSage = vi.fn(async () => [
        { id: 'x', kind: 'fact', status: 'active', text: 'mem x', tags: [] },
        { id: 'y', kind: 'note', status: 'active', text: 'mem y', tags: [] },
      ]);
      mockGetSageSurface.mockReturnValue(makeSage({ searchSage }));
      await handleSageSearchBreakdown(
        ws,
        msg({ query: 'pool', limit: 5, includeStale: true }),
        {} as any,
      );
      expect(searchSage).toHaveBeenCalledWith('pool', {
        limit: 5,
        includeStatuses: ['active', 'stale'],
      });
      const sent = JSON.parse(ws.send.mock.calls[0]![0] as string);
      expect(sent.payload.source).toBe('lexical');
      expect(sent.payload.hits).toHaveLength(2);
      expect(sent.payload.hits[0].source).toBe('lexical');
      expect(sent.payload.hits[0].vectorScore).toBeNull();
    });
  });

  describe('payload-less frames and non-finite numeric bounds', () => {
    it('answers payload-less and non-string SAGE mutation/file frames with structured errors instead of throwing', async () => {
      const sage = makeSage({
        recoverSage: vi.fn(async (id: string) => ({
          id,
          kind: 'fact',
          status: 'active',
          text: 'recovered',
          tags: [],
        })),
      });
      mockGetSageSurface.mockReturnValue(sage);

      const wsUpdate = mockWs();
      await expect(
        handleSageUpdate(wsUpdate, { type: 'memory.sage.update' } as any, {} as any),
      ).resolves.toBeUndefined();
      expect(JSON.parse(wsUpdate.send.mock.calls[0]![0] as string).payload.error).toBe(
        'id is required',
      );

      const wsRemember = mockWs();
      await expect(
        handleSageRemember(wsRemember, { type: 'memory.sage.remember' } as any, {} as any),
      ).resolves.toBeUndefined();
      await expect(
        handleSageRemember(
          wsRemember,
          msg({ text: 12345 as unknown as string, requestId: 'req-rem' }),
          {} as any,
        ),
      ).resolves.toBeUndefined();
      expect(JSON.parse(wsRemember.send.mock.calls[0]![0] as string).payload.error).toBe(
        'text is required',
      );
      expect(JSON.parse(wsRemember.send.mock.calls[1]![0] as string).payload).toMatchObject({
        error: 'text is required',
        requestId: 'req-rem',
      });

      const wsDelete = mockWs();
      await expect(
        handleSageDelete(wsDelete, { type: 'memory.sage.delete' } as any, {} as any),
      ).resolves.toBeUndefined();
      expect(JSON.parse(wsDelete.send.mock.calls[0]![0] as string).payload).toMatchObject({
        success: false,
        message: 'id is required',
      });

      const wsRecover = mockWs();
      await expect(
        handleSageRecover(wsRecover, { type: 'memory.sage.recover' } as any, {} as any),
      ).resolves.toBeUndefined();
      expect(JSON.parse(wsRecover.send.mock.calls[0]![0] as string).payload.error).toBe(
        'id is required',
      );

      const wsForFile = mockWs();
      await expect(
        handleSageForFile(wsForFile, { type: 'memory.sage.forFile' } as any, {} as any),
      ).resolves.toBeUndefined();
      expect(JSON.parse(wsForFile.send.mock.calls[0]![0] as string).payload.error).toBe(
        'filePath is required',
      );
    });

    it('falls back to finite defaults when NaN or Infinity bounds reach listPage, graph, and searchBreakdown', async () => {
      const sage = makeSage({
        graphFor: vi.fn(async () => []),
        searchSage: vi.fn(async () => []),
      });
      mockGetSageSurface.mockReturnValue(sage);

      const wsPage = mockWs();
      await handleSageListPage(wsPage, msg({ limit: Number.NaN, includeStats: false }), {} as any);
      expect(JSON.parse(wsPage.send.mock.calls[0]![0] as string).payload.memories).toHaveLength(2);

      const wsGraph = mockWs();
      await handleSageGraph(
        wsGraph,
        msg({
          query: 'mem:001',
          maxDepth: Number.NaN,
          limit: Number.POSITIVE_INFINITY,
        }),
        {} as any,
      );
      expect(sage.graphFor).toHaveBeenCalledWith('mem:001', 1, 100);

      const wsSearch = mockWs();
      await handleSageSearchBreakdown(
        wsSearch,
        msg({ query: 'hello', limit: Number.NaN }),
        {} as any,
      );
      expect((sage as { searchSage?: unknown }).searchSage).toHaveBeenCalledWith('hello', {
        limit: 20,
        includeStatuses: ['active'],
      });
    });
  });
});
