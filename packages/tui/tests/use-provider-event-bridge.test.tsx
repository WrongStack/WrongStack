// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { EventBus } from '@wrongstack/core/kernel';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useProviderEventBridge } from '../src/hooks/use-provider-event-bridge.js';

describe('useProviderEventBridge', () => {
  it('keeps provider deltas render-neutral until the canonical response arrives', () => {
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
    expect(result.current.flushTimerRef.current).toBeNull();
    expect(dispatch.mock.calls.some(([action]) => action.type === 'streamDelta')).toBe(false);

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
