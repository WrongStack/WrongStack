import { Context } from '@wrongstack/core/agent';
import { render } from 'ink-testing-library';
import React, { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useLiveTodos } from '../src/hooks/use-live-todos.js';
import { Text } from '../src/ink.js';

function makeContext(): Context {
  return new Context({
    systemPrompt: [],
    provider: {
      id: 'test',
      capabilities: { maxContext: 10_000, supportsVision: false },
      complete: vi.fn(),
    } as never,
    session: { id: 'session', append: vi.fn() } as never,
    signal: new AbortController().signal,
    tokenCounter: {} as never,
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    model: 'test',
  });
}

function Harness({ context }: { context: Context }): React.ReactElement {
  const todos = useLiveTodos(context);
  return React.createElement(
    Text,
    null,
    todos.map((todo) => `${todo.id}:${todo.content}`).join('|'),
  );
}

describe('useLiveTodos', () => {
  it('rerenders immediately for same-status content and order replacements', () => {
    const context = makeContext();
    context.state.replaceTodos([
      { id: 'a', content: 'Initial A', status: 'pending' },
      { id: 'b', content: 'Initial B', status: 'pending' },
    ]);
    const view = render(React.createElement(Harness, { context }));
    expect(view.lastFrame()).toBe('a:Initial A|b:Initial B');

    act(() => {
      context.state.replaceTodos([
        { id: 'b', content: 'Reassessed B', status: 'pending' },
        { id: 'c', content: 'New C', status: 'pending' },
      ]);
    });

    expect(view.lastFrame()).toBe('b:Reassessed B|c:New C');
    view.unmount();
  });
});
