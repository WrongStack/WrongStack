import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

// ── ws-client stub ──────────────────────────────────────────────────────────

type Handler = (msg: { payload: { response?: unknown; error?: string } }) => void;

const handlers = new Set<Handler>();
const findMemoriesForFile = vi.fn();
let clientImpl: () => unknown = () => client;

const client = {
  on(type: string, handler: Handler) {
    if (type !== 'memory.sage.forFile') throw new Error(`unexpected subscription: ${type}`);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  },
  findMemoriesForFile,
};

vi.mock('@/lib/ws-client', () => ({ getWSClient: () => clientImpl() }));

const { useMemoryForFile } = await import('../../src/hooks/useMemoryForFile');

function emit(payload: { response?: unknown; error?: string }) {
  for (const h of [...handlers]) h({ payload });
}

function response(filePath: string, overrides: Record<string, unknown> = {}) {
  return {
    filePath,
    primaryMatches: [],
    symbolMatches: [],
    relatedMatches: [],
    totalCount: 0,
    activeCount: 0,
    supersededCount: 0,
    reviewPendingCount: 0,
    ...overrides,
  };
}

describe('useMemoryForFile', () => {
  beforeEach(() => {
    handlers.clear();
    findMemoriesForFile.mockReset();
    clientImpl = () => client;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── idle ──────────────────────────────────────────────────────────────────

  it('stays idle and sends nothing when filePath is null', () => {
    const { result } = renderHook(() => useMemoryForFile({ filePath: null }));
    expect(result.current).toMatchObject({ data: null, loading: false, error: null });
    expect(findMemoriesForFile).not.toHaveBeenCalled();
  });

  it('clears stale data and error when the path becomes null', async () => {
    const { result, rerender } = renderHook(
      ({ filePath }: { filePath: string | null }) => useMemoryForFile({ filePath }),
      { initialProps: { filePath: 'src/a.ts' as string | null } },
    );
    act(() => emit({ response: response('src/a.ts', { totalCount: 3 }) }));
    await waitFor(() => expect(result.current.data?.totalCount).toBe(3));

    rerender({ filePath: null });
    await waitFor(() => expect(result.current.data).toBeNull());
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('does not auto-fetch when autoFetch is false', () => {
    renderHook(() => useMemoryForFile({ filePath: 'src/a.ts', autoFetch: false }));
    expect(findMemoriesForFile).not.toHaveBeenCalled();
  });

  // ── request payload ───────────────────────────────────────────────────────

  it('requests with the documented defaults', () => {
    renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    expect(findMemoriesForFile).toHaveBeenCalledWith(
      { filePath: 'src/a.ts', limit: 50, showSuperseded: true, showDeleted: false },
      undefined,
    );
  });

  it('omits lineStart/lineEnd entirely when not supplied', () => {
    renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    const payload = findMemoriesForFile.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('lineStart');
    expect(payload).not.toHaveProperty('lineEnd');
  });

  it('includes the cursor range when supplied', () => {
    renderHook(() =>
      useMemoryForFile({ filePath: 'src/a.ts', lineStart: 10, lineEnd: 25, limit: 5 }),
    );
    expect(findMemoriesForFile).toHaveBeenCalledWith(
      {
        filePath: 'src/a.ts',
        limit: 5,
        showSuperseded: true,
        showDeleted: false,
        lineStart: 10,
        lineEnd: 25,
      },
      undefined,
    );
  });

  it('includes lineStart alone', () => {
    renderHook(() => useMemoryForFile({ filePath: 'src/a.ts', lineStart: 3 }));
    const payload = findMemoriesForFile.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.lineStart).toBe(3);
    expect(payload).not.toHaveProperty('lineEnd');
  });

  it('forwards the "show recoverable" toggle', () => {
    renderHook(() =>
      useMemoryForFile({ filePath: 'src/a.ts', showDeleted: true, showSuperseded: false }),
    );
    expect(findMemoriesForFile.mock.calls[0]?.[0]).toMatchObject({
      showDeleted: true,
      showSuperseded: false,
    });
  });

  it('forwards sendOptions to the client', () => {
    renderHook(() =>
      useMemoryForFile({ filePath: 'src/a.ts', sendOptions: { echoToChat: false } }),
    );
    expect(findMemoriesForFile.mock.calls[0]?.[1]).toEqual({ echoToChat: false });
  });

  // ── responses ─────────────────────────────────────────────────────────────

  it('reports loading until the response lands', async () => {
    const { result } = renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    expect(result.current.loading).toBe(true);
    act(() => emit({ response: response('src/a.ts') }));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('stores the matched buckets', async () => {
    const { result } = renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    act(() =>
      emit({
        response: response('src/a.ts', {
          primaryMatches: [{ id: 'm1' }],
          totalCount: 1,
          activeCount: 1,
        }),
      }),
    );
    await waitFor(() => expect(result.current.data?.primaryMatches).toHaveLength(1));
    expect(result.current.error).toBeNull();
  });

  it('falls back to an empty response shape when the payload omits one', async () => {
    const { result } = renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    act(() => emit({}));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data).toMatchObject({ filePath: '', totalCount: 0 });
    expect(result.current.loading).toBe(false);
  });

  it('surfaces a server error and drops any previous data', async () => {
    const { result } = renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    act(() => emit({ response: response('src/a.ts', { totalCount: 2 }) }));
    await waitFor(() => expect(result.current.data?.totalCount).toBe(2));

    act(() => result.current.refetch());
    act(() => emit({ error: 'sage offline' }));
    await waitFor(() => expect(result.current.error).toBe('sage offline'));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('prefers the error branch even when a response is also present', async () => {
    const { result } = renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    act(() => emit({ error: 'partial failure', response: response('src/a.ts') }));
    await waitFor(() => expect(result.current.error).toBe('partial failure'));
    expect(result.current.data).toBeNull();
  });

  it('clears a previous error on a successful refetch', async () => {
    const { result } = renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    act(() => emit({ error: 'boom' }));
    await waitFor(() => expect(result.current.error).toBe('boom'));

    act(() => result.current.refetch());
    act(() => emit({ response: response('src/a.ts') }));
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  // ── cross-wiring guards ───────────────────────────────────────────────────

  it('ignores a response for a different file (cross-instance guard)', async () => {
    const { result } = renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    act(() => emit({ response: response('src/other.ts', { totalCount: 99 }) }));
    // The foreign response must not settle this hook.
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);

    act(() => emit({ response: response('src/a.ts', { totalCount: 1 }) }));
    await waitFor(() => expect(result.current.data?.totalCount).toBe(1));
  });

  it('accepts a response whose path only differs by separator or "./" prefix', async () => {
    const { result } = renderHook(() =>
      useMemoryForFile({ filePath: './packages\\tools\\src\\a.ts' }),
    );
    // The server answers with the normalized project-relative path.
    act(() => emit({ response: response('packages/tools/src/a.ts', { totalCount: 4 }) }));
    await waitFor(() => expect(result.current.data?.totalCount).toBe(4));
    expect(result.current.loading).toBe(false);
  });

  it('drops a stale response once the path changed', async () => {
    const { result, rerender } = renderHook(
      ({ filePath }: { filePath: string }) => useMemoryForFile({ filePath }),
      { initialProps: { filePath: 'src/a.ts' } },
    );
    rerender({ filePath: 'src/b.ts' });
    // A late reply for the first request must not land.
    act(() => emit({ response: response('src/a.ts', { totalCount: 42 }) }));
    expect(result.current.data).toBeNull();

    act(() => emit({ response: response('src/b.ts', { totalCount: 7 }) }));
    await waitFor(() => expect(result.current.data?.totalCount).toBe(7));
  });

  it('re-requests when the cursor range changes', () => {
    const { rerender } = renderHook(
      ({ lineStart }: { lineStart: number }) =>
        useMemoryForFile({ filePath: 'src/a.ts', lineStart }),
      { initialProps: { lineStart: 1 } },
    );
    expect(findMemoriesForFile).toHaveBeenCalledTimes(1);
    rerender({ lineStart: 20 });
    expect(findMemoriesForFile).toHaveBeenCalledTimes(2);
  });

  it('does not re-request when only the sendOptions object identity changes', () => {
    const { rerender } = renderHook(
      ({ sendOptions }: { sendOptions: Record<string, unknown> }) =>
        useMemoryForFile({ filePath: 'src/a.ts', sendOptions }),
      { initialProps: { sendOptions: { correlationId: 'c1' } } },
    );
    expect(findMemoriesForFile).toHaveBeenCalledTimes(1);
    // Same content, new object — the JSON key keeps the effect from refiring.
    rerender({ sendOptions: { correlationId: 'c1' } });
    expect(findMemoriesForFile).toHaveBeenCalledTimes(1);
  });

  it('does re-request when the sendOptions content actually changes', () => {
    const { rerender } = renderHook(
      ({ sendOptions }: { sendOptions: Record<string, unknown> }) =>
        useMemoryForFile({ filePath: 'src/a.ts', sendOptions }),
      { initialProps: { sendOptions: { correlationId: 'c1' } } },
    );
    rerender({ sendOptions: { correlationId: 'c2' } });
    expect(findMemoriesForFile).toHaveBeenCalledTimes(2);
  });

  // ── subscription hygiene ──────────────────────────────────────────────────

  it('keeps exactly one handler attached across repeated refetches', async () => {
    const { result } = renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    expect(handlers.size).toBe(1);
    act(() => result.current.refetch());
    act(() => result.current.refetch());
    expect(handlers.size).toBe(1);
  });

  it('detaches its handler on unmount', () => {
    const { unmount } = renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    expect(handlers.size).toBe(1);
    unmount();
    expect(handlers.size).toBe(0);
  });

  it('drops an in-flight response that arrives after unmount', () => {
    const { unmount } = renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    unmount();
    expect(() => emit({ response: response('src/a.ts') })).not.toThrow();
  });

  it('exposes a stable refetch identity while inputs are unchanged', () => {
    const { result, rerender } = renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    const first = result.current.refetch;
    rerender();
    expect(result.current.refetch).toBe(first);
  });

  it('refetch works when autoFetch is off', () => {
    const { result } = renderHook(() =>
      useMemoryForFile({ filePath: 'src/a.ts', autoFetch: false }),
    );
    expect(findMemoriesForFile).not.toHaveBeenCalled();
    act(() => result.current.refetch());
    expect(findMemoriesForFile).toHaveBeenCalledTimes(1);
  });

  it('refetch on a null path clears state without sending', () => {
    const { result } = renderHook(() => useMemoryForFile({ filePath: null, autoFetch: false }));
    act(() => result.current.refetch());
    expect(findMemoriesForFile).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ data: null, error: null, loading: false });
  });

  // ── failure paths ─────────────────────────────────────────────────────────

  it('reports an unavailable WS client without subscribing', () => {
    clientImpl = () => null;
    const { result } = renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    expect(result.current.error).toBe('WebSocket client unavailable');
    expect(result.current.loading).toBe(false);
    expect(handlers.size).toBe(0);
  });

  it('surfaces a throwing send and tears the handler back down', () => {
    findMemoriesForFile.mockImplementation(() => {
      throw new Error('socket closed');
    });
    const { result } = renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    expect(result.current.error).toBe('socket closed');
    expect(result.current.loading).toBe(false);
    expect(handlers.size).toBe(0);
  });

  it('stringifies a non-Error throw', () => {
    findMemoriesForFile.mockImplementation(() => {
      throw 'plain string failure';
    });
    const { result } = renderHook(() => useMemoryForFile({ filePath: 'src/a.ts' }));
    expect(result.current.error).toBe('plain string failure');
  });
});
