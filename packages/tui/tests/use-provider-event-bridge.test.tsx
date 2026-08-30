// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { EventBus } from '@wrongstack/core/kernel';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useProviderEventBridge } from '../src/hooks/use-provider-event-bridge.js';

describe('useProviderEventBridge', () => {
  it('keeps provider deltas render-neutral until the canonical response arrives', () => {
    vi.useFakeTimers();
    try {
      const events = new EventBus();
      const dispatch = vi.fn();
      const agent = { ctx: { session: { id: 'session-1' }, todos: [] } };

      const { result, unmount } = renderHook(() => {
        const streamingTextRef = useRef('');
        const streamSegmentsRef = useRef<Array<{ kind: 'assistant' | 'thinking'; text: string }>>([]);
        const pendingDeltaRef = useRef('');
        const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
        const sessionGenerationRef = useRef(1);
        const activeRunGenerationRef = useRef(1);
        const assistantCommittedThisRunRef = useRef(false);

        useProviderEventBridge({
          events,
          agent: agent as never,
          dispatch,
          streamingTextRef,
          streamSegmentsRef,
          pendingDeltaRef,
          flushTimerRef,
          sessionGenerationRef,
          activeRunGenerationRef,
          assistantCommittedThisRunRef,
          setMemoryContextMonitor: vi.fn(),
        });
        return { streamingTextRef, streamSegmentsRef, flushTimerRef };
      });

      act(() => {
        events.emit('provider.text_delta', { ctx: agent.ctx as never, text: 'hello' });
        events.emit('provider.thinking_delta', { ctx: agent.ctx as never, text: 'reasoning' });
      });

      expect(result.current.streamingTextRef.current).toBe('hello');
      expect(result.current.streamSegmentsRef.current).toEqual([
        { kind: 'assistant', text: 'hello' },
        { kind: 'thinking', text: 'reasoning' },
      ]);
      expect(result.current.flushTimerRef.current).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(dispatch.mock.calls.some(([action]) => action.type === 'streamDelta' && action.delta === 'helloreasoning')).toBe(true);
      expect(result.current.flushTimerRef.current).toBeNull();

      act(() => {
        events.emitCustom('chimera.report_available', {
          sessionId: 'session-1',
          message: '🦂 Chimera report ready. No follow-up started.',
        });
      });
      expect(dispatch).toHaveBeenCalledWith({
        type: 'addEntry',
        entry: {
          kind: 'warn',
          text: '🦂 Chimera report ready. No follow-up started.',
        },
      });

      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters out chimera.report_available events from other sessions', () => {
    const { events, dispatch, unmount } = setupBridge('leader-session');
    act(() => {
      events.emitCustom('chimera.report_available', {
        sessionId: 'other-session',
        message: '🦂 Chimera report ready.',
      });
    });
    expect(dispatch).not.toHaveBeenCalledWith({
      type: 'addEntry',
      entry: { kind: 'warn', text: '🦂 Chimera report ready.' },
    });
    unmount();
  });

  it('renders a todo tool result only once', () => {
    const events = new EventBus();
    const dispatch = vi.fn();
    const agent = {
      ctx: {
        session: { id: 'session-1' },
        todos: [{ id: 'todo-1', content: 'Ship it', status: 'in_progress' }],
      },
    };

    const { unmount } = renderHook(() => {
      const streamingTextRef = useRef('');
      const streamSegmentsRef = useRef<Array<{ kind: 'assistant' | 'thinking'; text: string }>>([]);
      const pendingDeltaRef = useRef('');
      const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
      const sessionGenerationRef = useRef(1);
      const activeRunGenerationRef = useRef(1);
      const assistantCommittedThisRunRef = useRef(false);

      useProviderEventBridge({
        events,
        agent: agent as never,
        dispatch,
        streamingTextRef,
        streamSegmentsRef,
        pendingDeltaRef,
        flushTimerRef,
        sessionGenerationRef,
        activeRunGenerationRef,
        assistantCommittedThisRunRef,
        setMemoryContextMonitor: vi.fn(),
      });
    });

    act(() => {
      events.emit('tool.executed', {
        id: 'tool-1',
        name: 'todo',
        durationMs: 12,
        ok: true,
        input: { todos: agent.ctx.todos },
        output: 'Updated 1 todo',
      });
    });

    const historyActions = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === 'addEntry');
    expect(historyActions).toEqual([
      {
        type: 'addEntry',
        entry: {
          kind: 'tool',
          name: 'todo',
          durationMs: 12,
          ok: true,
          input: { todos: agent.ctx.todos },
          output: 'Updated 1 todo',
          outputBytes: undefined,
          outputTokens: undefined,
          outputLines: undefined,
        },
      },
    ]);
    expect(historyActions.some((action) => action.entry.kind === 'info')).toBe(false);

    unmount();
  });

  // ── Memory event session filtering ──────────────────────────────
  // Regression: memory lifecycle events from other sessions/agents
  // were appearing in the leader's chat history because four handlers
  // in use-provider-event-bridge.ts were missing the session filter.

  function setupBridge(sessionId: string) {
    const events = new EventBus();
    const dispatch = vi.fn();
    const agent = { ctx: { session: { id: sessionId }, todos: [] } };
    const { unmount } = renderHook(() => {
      const streamingTextRef = useRef('');
      const streamSegmentsRef = useRef<Array<{ kind: 'assistant' | 'thinking'; text: string }>>([]);
      const pendingDeltaRef = useRef('');
      const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
      const sessionGenerationRef = useRef(1);
      const activeRunGenerationRef = useRef(1);
      const assistantCommittedThisRunRef = useRef(false);
      useProviderEventBridge({
        events,
        agent: agent as never,
        dispatch,
        streamingTextRef,
        streamSegmentsRef,
        pendingDeltaRef,
        flushTimerRef,
        sessionGenerationRef,
        activeRunGenerationRef,
        assistantCommittedThisRunRef,
        setMemoryContextMonitor: vi.fn(),
      });
    });
    return { events, dispatch, unmount };
  }

  function memoryEntries(dispatch: ReturnType<typeof vi.fn>): unknown[] {
    return dispatch.mock.calls
      .map(([action]) => action)
      .filter(
        (action) =>
          action.type === 'addEntry' &&
          ['memory-lifecycle', 'warn', 'info'].includes(action.entry.kind) &&
          (action.entry.text?.includes('SAGE') ||
            'action' in (action.entry as Record<string, unknown>)),
      );
  }

  it('filters out memory.staled events from other sessions', () => {
    const { events, dispatch, unmount } = setupBridge('leader-session');
    act(() => {
      events.emit('memory.staled', {
        memoryId: 'mem-1',
        reason: 'anchor drift',
        sessionId: 'other-session',
      });
    });
    expect(memoryEntries(dispatch)).toHaveLength(0);
    unmount();
  });

  it('allows memory.staled events from the current session', () => {
    // memory.staled fires both the named handler (kind: 'warn') and the
    // memory.* pattern handler (kind: 'memory-lifecycle'), so we expect 2.
    const { events, dispatch, unmount } = setupBridge('leader-session');
    act(() => {
      events.emit('memory.staled', {
        memoryId: 'mem-1',
        reason: 'anchor drift',
        sessionId: 'leader-session',
      });
    });
    expect(memoryEntries(dispatch)).toHaveLength(2);
    unmount();
  });

  it('filters out memory.contradicted events from other sessions', () => {
    const { events, dispatch, unmount } = setupBridge('leader-session');
    act(() => {
      events.emit('memory.contradicted', {
        memoryId: 'mem-2',
        contradicts: ['mem-1'],
        sessionId: 'subagent-session',
      });
    });
    expect(memoryEntries(dispatch)).toHaveLength(0);
    unmount();
  });

  it('filters out memory.hygiene_completed events from other sessions', () => {
    const { events, dispatch, unmount } = setupBridge('leader-session');
    act(() => {
      events.emit('memory.hygiene_completed', {
        examined: 10,
        deduplicated: 2,
        staled: 1,
        archived: 0,
        sessionId: 'other-session',
      });
    });
    expect(memoryEntries(dispatch)).toHaveLength(0);
    unmount();
  });

  it('allows memory.hygiene_completed events from the current session', () => {
    const { events, dispatch, unmount } = setupBridge('leader-session');
    act(() => {
      events.emit('memory.hygiene_completed', {
        examined: 10,
        deduplicated: 2,
        staled: 1,
        archived: 0,
        sessionId: 'leader-session',
      });
    });
    expect(memoryEntries(dispatch)).toHaveLength(1);
    unmount();
  });

  it('filters out memory.accepted lifecycle events from other sessions', () => {
    const { events, dispatch, unmount } = setupBridge('leader-session');
    act(() => {
      events.emit('memory.accepted', {
        memoryId: 'mem-3',
        kind: 'fact',
        sessionId: 'other-session',
      });
    });
    expect(memoryEntries(dispatch)).toHaveLength(0);
    unmount();
  });

  it('allows memory.accepted lifecycle events from the current session', () => {
    const { events, dispatch, unmount } = setupBridge('leader-session');
    act(() => {
      events.emit('memory.accepted', {
        memoryId: 'mem-3',
        kind: 'fact',
        sessionId: 'leader-session',
      });
    });
    expect(memoryEntries(dispatch)).toHaveLength(1);
    unmount();
  });

  it('allows memory events with undefined sessionId (backward compat)', () => {
    const { events, dispatch, unmount } = setupBridge('leader-session');
    act(() => {
      events.emit('memory.accepted', {
        memoryId: 'mem-4',
        kind: 'fact',
        // sessionId intentionally omitted
      });
    });
    expect(memoryEntries(dispatch)).toHaveLength(1);
    unmount();
  });

  it.each([
    ['tool_use', false],
    ['end_turn', true],
  ])('marks assistant entries from a %s response final=%s', (stopReason, expected) => {
    // The gate lives at the response level, not per segment: a `tool_use`
    // stop means the agent loop runs again, so the text committed here is
    // mid-turn prose and must not offer <nextsteps> suggestions.
    const events = new EventBus();
    const dispatch = vi.fn();
    const agent = { ctx: { session: { id: 'session-1' }, todos: [] } };

    const { unmount } = renderHook(() => {
      const streamingTextRef = useRef('');
      const streamSegmentsRef = useRef<Array<{ kind: 'assistant' | 'thinking'; text: string }>>([]);
      const pendingDeltaRef = useRef('');
      const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
      const sessionGenerationRef = useRef(1);
      const activeRunGenerationRef = useRef(1);
      const assistantCommittedThisRunRef = useRef(false);

      useProviderEventBridge({
        events,
        agent: agent as never,
        dispatch,
        streamingTextRef,
        streamSegmentsRef,
        pendingDeltaRef,
        flushTimerRef,
        sessionGenerationRef,
        activeRunGenerationRef,
        assistantCommittedThisRunRef,
        setMemoryContextMonitor: vi.fn(),
      });
    });

    act(() => {
      events.emit('provider.response', {
        ctx: agent.ctx as never,
        model: 'm',
        content: [{ type: 'text', text: 'Let me check that.' }],
        usage: { input: 1, output: 1 },
        stopReason,
      } as never);
    });

    const assistantEntries = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === 'addEntry' && action.entry.kind === 'assistant')
      .map((action) => action.entry);
    expect(assistantEntries).toEqual([
      { kind: 'assistant', text: 'Let me check that.', final: expected },
    ]);

    unmount();
  });
});
