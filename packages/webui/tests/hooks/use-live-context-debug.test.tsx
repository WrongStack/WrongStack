import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveContextDebug } from '../../src/hooks/useLiveContextDebug';
import { ensureSessionLane, useSessionLanes } from '../../src/stores/session-lanes';

type Handler = (msg: { type: string; payload?: unknown }) => void;
const handlers = new Map<string, Set<Handler>>();
const sendMock = vi.fn();

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    send: sendMock,
    on: (type: string, handler: Handler) => {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
  }),
}));

function emitContextDebug(payload: unknown) {
  const set = handlers.get('context.debug');
  if (!set) return;
  for (const h of set) h({ type: 'context.debug', payload });
}

beforeEach(() => {
  handlers.clear();
  sendMock.mockClear();
  useSessionLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});

afterEach(() => {
  // Ensure each test leaves the document in a sensible default for the next.
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});

describe('useLiveContextDebug', () => {
  it('does nothing while inactive', () => {
    const { result } = renderHook(() => useLiveContextDebug('ws://test', { active: false }));
    expect(sendMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sends an immediate request on start and reflects the first snapshot', () => {
    const { result } = renderHook(() => useLiveContextDebug('ws://test'));

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenLastCalledWith(
      { type: 'context.debug' },
      { echoToChat: false, queueIfDisconnected: false },
    );
    expect(result.current.loading).toBe(true);

    act(() => {
      emitContextDebug({
        total: 1000,
        systemPrompt: 200,
        tools: { total: 300, count: 4, breakdown: [] },
        messages: { total: 500, count: 3, breakdown: [] },
      });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data?.total).toBe(1000);
    expect(result.current.lastUpdatedAt).not.toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('continues to poll at the configured cadence', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useLiveContextDebug('ws://test', { intervalMs: 2000 }));
      expect(sendMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(sendMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(sendMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('overwrites prior data when a new snapshot arrives (latest wins)', () => {
    const { result } = renderHook(() => useLiveContextDebug('ws://test'));

    act(() => {
      emitContextDebug({
        total: 1000,
        systemPrompt: 100,
        tools: { total: 200, count: 1, breakdown: [] },
        messages: { total: 700, count: 2, breakdown: [] },
      });
    });
    expect(result.current.data?.total).toBe(1000);

    act(() => {
      emitContextDebug({
        total: 2000,
        systemPrompt: 250,
        tools: { total: 350, count: 2, breakdown: [] },
        messages: { total: 1400, count: 4, breakdown: [] },
      });
    });
    expect(result.current.data?.total).toBe(2000);
  });

  it('does not re-enter loading once a snapshot has arrived', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useLiveContextDebug('ws://test'));
      expect(result.current.loading).toBe(true);

      act(() => {
        emitContextDebug({
          total: 1,
          systemPrompt: 1,
          tools: { total: 0, count: 0, breakdown: [] },
          messages: { total: 0, count: 0, breakdown: [] },
        });
      });
      expect(result.current.loading).toBe(false);

      // Advance through several poll ticks; loading must NOT come back.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.data?.total).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refresh() bumps the generation and triggers an immediate snapshot', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useLiveContextDebug('ws://test'));
      expect(sendMock).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.refresh();
      });
      // refresh() re-runs the effect synchronously, producing one more request.
      expect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses polling while the tab is hidden and resumes on visibility regain', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useLiveContextDebug('ws://test', { intervalMs: 2000 }));
      expect(sendMock).toHaveBeenCalledTimes(1);

      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(sendMock).toHaveBeenCalledTimes(1);

      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      // Catch-up request fires inside the visibility handler.
      expect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up subscription and timers on unmount', async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => useLiveContextDebug('ws://test', { intervalMs: 1000 }));
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(handlers.get('context.debug')?.size ?? 0).toBe(1);

      unmount();
      expect(handlers.get('context.debug')?.size ?? 0).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      // No requests must have been queued after unmount.
      expect(sendMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a snapshot whose payload is missing tools/messages', () => {
    const { result } = renderHook(() => useLiveContextDebug('ws://test'));
    act(() => {
      emitContextDebug({ total: 1 });
    });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('ignores context.debug snapshots that do not belong to the active session', () => {
    ensureSessionLane('sess-a');
    ensureSessionLane('sess-b');
    useSessionLanes.setState({ activeSessionId: 'sess-a' });
    const { result } = renderHook(() => useLiveContextDebug('ws://test'));

    act(() => {
      emitContextDebug({
        sessionId: 'sess-b',
        total: 2000,
        systemPrompt: 100,
        tools: { total: 200, count: 1, breakdown: [] },
        messages: { total: 1700, count: 3, breakdown: [] },
      });
      emitContextDebug({
        total: 3000,
        systemPrompt: 100,
        tools: { total: 200, count: 1, breakdown: [] },
        messages: { total: 2700, count: 3, breakdown: [] },
      });
    });

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);

    act(() => {
      emitContextDebug({
        sessionId: 'sess-a',
        total: 1000,
        systemPrompt: 100,
        tools: { total: 200, count: 1, breakdown: [] },
        messages: { total: 700, count: 2, breakdown: [] },
      });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data?.total).toBe(1000);
  });

  it('times out the first snapshot instead of spinning forever', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useLiveContextDebug('ws://test'));
      expect(result.current.loading).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toMatch(/timed out/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates transient send() failures (closed socket during reconnect)', () => {
    const { result } = renderHook(() => useLiveContextDebug('ws://test'));
    // Override send to throw on the next call only.
    const orig = sendMock.getMockImplementation() ?? (() => undefined);
    let thrown = false;
    sendMock.mockImplementation(() => {
      if (!thrown) {
        thrown = true;
        throw new Error('socket closed');
      }
      return orig();
    });
    // Refresh triggers a new effect run that calls send() — the throw is swallowed.
    expect(() => act(() => result.current.refresh())).not.toThrow();
    // data is still null (we never received a snapshot) but the hook is alive.
    expect(result.current.data).toBeNull();
  });
});
