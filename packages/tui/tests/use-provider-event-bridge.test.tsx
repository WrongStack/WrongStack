// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { EventBus } from '@wrongstack/core/kernel';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useProviderEventBridge } from '../src/hooks/use-provider-event-bridge.js';

describe('useProviderEventBridge', () => {
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
});
