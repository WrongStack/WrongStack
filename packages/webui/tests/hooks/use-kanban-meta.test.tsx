import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

type Handler = (msg: { payload?: unknown }) => void;

const handlers = new Map<string, Set<Handler>>();
const sent: Array<{ type: string }> = [];
const seenUrls: Array<string | undefined> = [];

const client = {
  on(type: string, handler: Handler) {
    const set = handlers.get(type) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(type, set);
    return () => {
      set.delete(handler);
    };
  },
  send(msg: { type: string }) {
    sent.push(msg);
  },
};

vi.mock('@/lib/ws-client', () => ({
  getWSClient: (url?: string) => {
    seenUrls.push(url);
    return client;
  },
}));

const { useConfigStore } = await import('../../src/stores');
const { useKanbanMeta } = await import('../../src/hooks/useKanbanMeta');

function emit(payload: unknown) {
  for (const h of [...(handlers.get('kanban.meta') ?? [])]) h({ payload });
}

/** Server replies wrap the real body in `payload.data`. */
function reply(data: unknown) {
  return { data };
}

describe('useKanbanMeta', () => {
  beforeEach(() => {
    handlers.clear();
    sent.length = 0;
    seenUrls.length = 0;
    useConfigStore.setState({
      wsUrl: 'ws://localhost:3456',
      provider: 'anthropic',
      model: 'opus',
    } as never);
  });

  it('subscribes to kanban.meta on mount', () => {
    renderHook(() => useKanbanMeta(false));
    expect(handlers.get('kanban.meta')?.size).toBe(1);
  });

  it('does not request metadata while inactive', () => {
    renderHook(() => useKanbanMeta(false));
    expect(sent).toEqual([]);
  });

  it('requests metadata when a task becomes selected', () => {
    const { rerender } = renderHook(({ active }: { active: boolean }) => useKanbanMeta(active), {
      initialProps: { active: false },
    });
    expect(sent).toEqual([]);
    rerender({ active: true });
    expect(sent).toEqual([{ type: 'kanban.meta' }]);
  });

  it('requests immediately when mounted already active', () => {
    renderHook(() => useKanbanMeta(true));
    expect(sent).toEqual([{ type: 'kanban.meta' }]);
  });

  it('starts with empty collections', () => {
    const { result } = renderHook(() => useKanbanMeta(true));
    expect(result.current.tools).toEqual([]);
    expect(result.current.skills).toEqual([]);
    expect(result.current.fallbackProfiles).toEqual({});
  });

  it('falls back to the persisted config for provider/model', () => {
    const { result } = renderHook(() => useKanbanMeta(true));
    expect(result.current.sessionProvider).toBe('anthropic');
    expect(result.current.sessionModel).toBe('opus');
  });

  it('stores the live tool and skill lists', () => {
    const { result } = renderHook(() => useKanbanMeta(true));
    act(() =>
      emit(
        reply({
          tools: [{ name: 'read_file', description: 'Read a file' }],
          skills: [{ name: 'commit', description: 'Make a commit', source: 'project' }],
        }),
      ),
    );
    expect(result.current.tools).toEqual([{ name: 'read_file', description: 'Read a file' }]);
    expect(result.current.skills[0]).toMatchObject({ name: 'commit', source: 'project' });
  });

  it('stores the named fallback chains', () => {
    const { result } = renderHook(() => useKanbanMeta(true));
    act(() => emit(reply({ fallbackProfiles: { cheap: ['haiku', 'sonnet'] } })));
    expect(result.current.fallbackProfiles).toEqual({ cheap: ['haiku', 'sonnet'] });
  });

  it('server provider/model override the config fallback', () => {
    const { result } = renderHook(() => useKanbanMeta(true));
    act(() => emit(reply({ sessionProvider: 'openai', sessionModel: 'gpt-5' })));
    expect(result.current.sessionProvider).toBe('openai');
    expect(result.current.sessionModel).toBe('gpt-5');
  });

  it('keeps the config fallback when the server omits provider/model', () => {
    const { result } = renderHook(() => useKanbanMeta(true));
    act(() => emit(reply({ tools: [] })));
    expect(result.current.sessionProvider).toBe('anthropic');
    expect(result.current.sessionModel).toBe('opus');
  });

  it('ignores an empty-string provider/model rather than blanking the fallback', () => {
    const { result } = renderHook(() => useKanbanMeta(true));
    act(() => emit(reply({ sessionProvider: '', sessionModel: '' })));
    expect(result.current.sessionProvider).toBe('anthropic');
    expect(result.current.sessionModel).toBe('opus');
  });

  it('resets tools/skills/profiles to empty when a later reply omits them', () => {
    const { result } = renderHook(() => useKanbanMeta(true));
    act(() => emit(reply({ tools: [{ name: 'a' }], skills: [{ name: 'b' }] })));
    expect(result.current.tools).toHaveLength(1);
    act(() => emit(reply({})));
    expect(result.current.tools).toEqual([]);
    expect(result.current.skills).toEqual([]);
    expect(result.current.fallbackProfiles).toEqual({});
  });

  it('ignores a reply with no data envelope', () => {
    const { result } = renderHook(() => useKanbanMeta(true));
    act(() => emit(reply({ tools: [{ name: 'keep' }] })));
    act(() => emit(undefined));
    act(() => emit({}));
    expect(result.current.tools).toEqual([{ name: 'keep' }]);
  });

  it('passes the configured wsUrl to getWSClient', () => {
    renderHook(() => useKanbanMeta(true));
    expect(seenUrls).toContain('ws://localhost:3456');
  });

  it('re-subscribes against the new URL when wsUrl changes', () => {
    const { rerender } = renderHook(() => useKanbanMeta(true));
    expect(handlers.get('kanban.meta')?.size).toBe(1);
    act(() => {
      useConfigStore.setState({ wsUrl: 'ws://localhost:9999' } as never);
    });
    rerender();
    // Old subscription torn down, exactly one live listener remains.
    expect(handlers.get('kanban.meta')?.size).toBe(1);
    expect(seenUrls).toContain('ws://localhost:9999');
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useKanbanMeta(true));
    unmount();
    expect(handlers.get('kanban.meta')?.size ?? 0).toBe(0);
  });

  it('drops a reply that arrives after unmount', () => {
    const { unmount } = renderHook(() => useKanbanMeta(true));
    unmount();
    expect(() => emit(reply({ tools: [] }))).not.toThrow();
  });
});
