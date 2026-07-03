import { render } from 'ink-testing-library';
import type { TodoItem } from '@wrongstack/core';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Entry, type HistoryEntry } from '../src/components/history.js';

// An assistant message carrying a <next_steps> block. The block is in the
// XML-tag form (strict mode requires the closing tag), with two items.
const ASSISTANT_WITH_NEXT_STEPS: HistoryEntry = {
  id: 1,
  kind: 'assistant',
  text: ['Done reviewing the file.', '', '<next_steps>', '1. Add unit tests for the parser', '2. Run the full suite', '</next_steps>'].join(
    '\n',
  ),
};

interface RenderOpts {
  setSuggestions?: (steps: string[]) => void;
  todos?: readonly TodoItem[];
  autonomyMode?: string;
}

/** Render an assistant Entry with optional suggestion writer + todo list. */
function renderEntry(opts: RenderOpts = {}): { frame: string; setSuggestions: ReturnType<typeof vi.fn> } {
  const setSuggestions = opts.setSuggestions ?? vi.fn();
  const { lastFrame, unmount } = render(
    React.createElement(Entry, {
      entry: ASSISTANT_WITH_NEXT_STEPS,
      termWidth: 100,
      setSuggestions,
      todos: opts.todos,
      autonomyMode: opts.autonomyMode,
    }),
  );
  const frame = lastFrame() ?? '';
  unmount();
  return { frame, setSuggestions: setSuggestions as ReturnType<typeof vi.fn> };
}

describe('<Entry /> <next_steps> todo-gate (b0970387 render-path parity)', () => {
  it('shows the NEXT STEPS panel and writes the store when no todos are open', () => {
    const { frame, setSuggestions } = renderEntry();

    // Panel header + both items render.
    expect(frame).toContain('NEXT STEPS');
    expect(frame).toContain('Add unit tests for the parser');
    expect(frame).toContain('Run the full suite');
    // The raw <next_steps> XML block must never leak into the message body.
    expect(frame).not.toContain('<next_steps>');
    expect(frame).not.toContain('</next_steps>');
    // Store was written with the parsed item texts.
    expect(setSuggestions).toHaveBeenCalledTimes(1);
    expect(setSuggestions).toHaveBeenCalledWith([
      'Add unit tests for the parser',
      'Run the full suite',
    ]);
  });

  it('hides the NEXT STEPS panel and skips the store write while todos are open', () => {
    const openTodos: TodoItem[] = [
      { id: 't1', content: 'finish the refactor', status: 'in_progress' },
    ];
    const { frame, setSuggestions } = renderEntry({ todos: openTodos });

    // Panel is suppressed — suggestions don't compete with in-flight todos.
    expect(frame).not.toContain('NEXT STEPS');
    expect(frame).not.toContain('Add unit tests for the parser');
    // Store is NOT repopulated from the render path (mirrors the host callback
    // clearing it); otherwise it would immediately undo the clear.
    expect(setSuggestions).not.toHaveBeenCalled();
    // But the raw block is still stripped from the body — even when the panel
    // is hidden, the literal <next_steps> tags never show.
    expect(frame).not.toContain('<next_steps>');
    expect(frame).not.toContain('</next_steps>');
  });

  it('treats an all-completed todo list as "no open todos" (panel shows)', () => {
    const completedTodos: TodoItem[] = [
      { id: 't1', content: 'done deal', status: 'completed' },
    ];
    const { frame, setSuggestions } = renderEntry({ todos: completedTodos });

    expect(frame).toContain('NEXT STEPS');
    expect(setSuggestions).toHaveBeenCalledTimes(1);
  });
});
