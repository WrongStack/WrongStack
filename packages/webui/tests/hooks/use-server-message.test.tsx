import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── stub client ────────────────────────────────────────────────────────────

type Handler = (msg: unknown) => void;

function makeClient() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(type: string, handler: Handler) {
      const set = handlers.get(type) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(type, set);
      return () => {
        set.delete(handler);
      };
    },
    emit(type: string, msg: unknown) {
      for (const h of [...(handlers.get(type) ?? [])]) h(msg);
    },
    /**
     * Total number of registered handler instances across all types. A
     * subscription that doesn't tear down would leave its count = 1 forever;
     * the unmount test relies on this.
     */
    handlerCount: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
    handlerSetFor: (type: string) => handlers.get(type) ?? new Set<Handler>(),
  };
}

let client: ReturnType<typeof makeClient>;
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => client,
}));

const { useServerMessage } = await import('../../src/hooks/useServerMessage');

describe('useServerMessage (B-03 single-message subscription hook)', () => {
  beforeEach(() => {
    client = makeClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers exactly one handler on mount and tears it down on unmount', () => {
    const { unmount } = renderHook(() =>
      useServerMessage('context.editor.snapshot', () => {}),
    );
    expect(client.handlerSetFor('context.editor.snapshot').size).toBe(1);
    unmount();
    expect(client.handlerCount()).toBe(0);
  });

  it('dispatches matching messages to the handler with a narrowed payload', () => {
    const seen: unknown[] = [];
    renderHook(() =>
      useServerMessage('context.editor.snapshot', (msg) => {
        // Narrowed by the literal type parameter — handler receives the
        // matching union member, no cast required.
        seen.push(msg);
      }),
    );
    act(() => {
      client.emit('context.editor.snapshot', {
        type: 'context.editor.snapshot',
        payload: { revision: 'r1', messages: [] },
      });
    });
    expect(seen).toHaveLength(1);
    expect((seen[0] as { payload: { revision: string } }).payload.revision).toBe('r1');
  });

  it('does not dispatch messages of a different type', () => {
    const seen: unknown[] = [];
    renderHook(() => useServerMessage('context.editor.snapshot', (msg) => seen.push(msg)));
    act(() => {
      client.emit('context.editor.applied', {
        type: 'context.editor.applied',
        payload: {},
      });
    });
    expect(seen).toEqual([]);
  });

  it('filters by sessionId when one is supplied (B-03 lane filter)', () => {
    const seen: unknown[] = [];
    renderHook(() =>
      useServerMessage(
        'context.editor.snapshot',
        (msg) => seen.push(msg),
        { sessionId: 'tab-2' },
      ),
    );
    act(() => {
      // Addressed to a DIFFERENT tab — must be ignored.
      client.emit('context.editor.snapshot', {
        type: 'context.editor.snapshot',
        payload: { sessionId: 'tab-1', revision: 'r1', messages: [] },
      });
    });
    expect(seen).toEqual([]);
    act(() => {
      // Addressed to OUR tab — must arrive.
      client.emit('context.editor.snapshot', {
        type: 'context.editor.snapshot',
        payload: { sessionId: 'tab-2', revision: 'r2', messages: [] },
      });
    });
    expect(seen).toHaveLength(1);
  });

  it('permits broadcasts (no sessionId on payload) even when a sessionId is pinned', () => {
    // Server-stamped broadcasts (boot-time, project-wide) carry no
    // sessionId; the hook must not silently drop them.
    const seen: unknown[] = [];
    renderHook(() =>
      useServerMessage('context.editor.snapshot', (msg) => seen.push(msg), {
        sessionId: 'tab-2',
      }),
    );
    act(() => {
      client.emit('context.editor.snapshot', {
        type: 'context.editor.snapshot',
        payload: { revision: 'broadcast', messages: [] },
      });
    });
    expect(seen).toHaveLength(1);
  });

  it('sees the latest handler closure across re-renders (handler ref captured)', () => {
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ tag }: { tag: string }) =>
        useServerMessage('context.editor.snapshot', (msg) => {
          seen.push((msg.payload as { revision: string }).revision + ':' + tag);
        }),
      { initialProps: { tag: 'A' } },
    );
    act(() => {
      client.emit('context.editor.snapshot', {
        type: 'context.editor.snapshot',
        payload: { revision: 'r1', messages: [] },
      });
    });
    rerender({ tag: 'B' });
    act(() => {
      client.emit('context.editor.snapshot', {
        type: 'context.editor.snapshot',
        payload: { revision: 'r2', messages: [] },
      });
    });
    expect(seen).toEqual(['r1:A', 'r2:B']);
    // No churn of the underlying subscription — same single instance.
    expect(client.handlerSetFor('context.editor.snapshot').size).toBe(1);
  });

  it('re-subscribes when deps change, dropping the previous subscription', () => {
    const seen: unknown[] = [];
    const { rerender } = renderHook(
      ({ askFor }: { askFor: string | undefined }) =>
        useServerMessage(
          'context.editor.snapshot',
          (msg) => seen.push(msg),
          { sessionId: askFor, deps: [askFor] },
        ),
      { initialProps: { askFor: 'tab-1' as string | undefined } },
    );
    expect(client.handlerSetFor('context.editor.snapshot').size).toBe(1);

    act(() => {
      client.emit('context.editor.snapshot', {
        type: 'context.editor.snapshot',
        payload: { sessionId: 'tab-2', revision: 'r2', messages: [] },
      });
    });
    expect(seen).toEqual([]); // filtered by tab-1 pin

    rerender({ askFor: 'tab-2' });

    act(() => {
      client.emit('context.editor.snapshot', {
        type: 'context.editor.snapshot',
        payload: { sessionId: 'tab-2', revision: 'r3', messages: [] },
      });
    });
    expect(seen).toHaveLength(1); // now passes — and no double subscription
    expect(client.handlerSetFor('context.editor.snapshot').size).toBe(1);
  });

  it('does nothing when the WS client is not yet available', () => {
    // Substitute a getWSClient that returns null for this test only.
    const originalClient = client;
    client = null as unknown as ReturnType<typeof makeClient>;
    try {
      const { unmount } = renderHook(() =>
        useServerMessage('context.editor.snapshot', () => {
          throw new Error('handler must not run without a WS client');
        }),
      );
      unmount();
      expect(true).toBe(true);
    } finally {
      client = originalClient;
    }
  });

  it('skips the WS registration when enabled is false (gated polling)', () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useServerMessage('context.debug', () => {}, { enabled }),
      { initialProps: { enabled: false } },
    );
    expect(client.handlerCount()).toBe(0);

    rerender({ enabled: true });
    expect(client.handlerCount()).toBe(1);

    rerender({ enabled: false });
    expect(client.handlerCount()).toBe(0);
  });
});
