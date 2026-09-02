import { render } from 'ink-testing-library';
import type { TodoItem } from '@wrongstack/core/agent';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Entry, type HistoryEntry } from '../src/components/history.js';

// An assistant message carrying a <nextsteps> block. The block is in the
// XML-tag form (strict mode requires the closing tag), with two items.
const NEXT_STEPS_TEXT = [
  'Done reviewing the file.',
  '',
  '<nextsteps>',
  '1. Add unit tests for the parser',
  '2. Run the full suite',
  '</nextsteps>',
].join('\n');

/** The turn's final assistant message — eligible to offer suggestions. */
const ASSISTANT_WITH_NEXT_STEPS: HistoryEntry = {
  id: 1,
  kind: 'assistant',
  text: NEXT_STEPS_TEXT,
  final: true,
};

interface RenderOpts {
  setSuggestions?: (steps: string[]) => void;
  todos?: readonly TodoItem[];
  autonomyMode?: string;
  /** Override the entry to render (defaults to the final-message entry). */
  entry?: HistoryEntry;
}

/** Render an assistant Entry with optional suggestion writer + todo list. */
function renderEntry(opts: RenderOpts = {}): {
  frame: string;
  setSuggestions: ReturnType<typeof vi.fn>;
} {
  const setSuggestions = opts.setSuggestions ?? vi.fn();
  const { lastFrame, unmount } = render(
    React.createElement(Entry, {
      entry: opts.entry ?? ASSISTANT_WITH_NEXT_STEPS,
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

describe('<Entry /> <nextsteps> todo-gate (b0970387 render-path parity)', () => {
  it('shows the NEXT STEPS panel and writes the store when no todos are open', () => {
    const { frame, setSuggestions } = renderEntry();

    // Panel header + both items render.
    expect(frame).toContain('NEXT STEPS');
    expect(frame).toContain('Add unit tests for the parser');
    expect(frame).toContain('Run the full suite');
    // The raw <nextsteps> XML block must never leak into the message body.
    expect(frame).not.toContain('<nextsteps>');
    expect(frame).not.toContain('</nextsteps>');
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
    // is hidden, the literal <nextsteps> tags never show.
    expect(frame).not.toContain('<nextsteps>');
    expect(frame).not.toContain('</nextsteps>');
  });

  it('treats an all-completed todo list as "no open todos" (panel shows)', () => {
    const completedTodos: TodoItem[] = [{ id: 't1', content: 'done deal', status: 'completed' }];
    const { frame, setSuggestions } = renderEntry({ todos: completedTodos });

    expect(frame).toContain('NEXT STEPS');
    expect(setSuggestions).toHaveBeenCalledTimes(1);
  });
});

describe('<Entry /> <nextsteps> final-message gate', () => {
  it('hides the panel and skips the store write for mid-turn prose', () => {
    // `final: false` — the model wrote this on its way to a tool call, so the
    // agent loop is still running and the suggestions are not its answer.
    const { frame, setSuggestions } = renderEntry({
      entry: { id: 2, kind: 'assistant', text: NEXT_STEPS_TEXT, final: false },
    });

    expect(frame).not.toContain('NEXT STEPS');
    expect(frame).not.toContain('Add unit tests for the parser');
    expect(setSuggestions).not.toHaveBeenCalled();
    // The block is still stripped — raw XML never reaches the user, whether
    // or not the panel is allowed.
    expect(frame).not.toContain('<nextsteps>');
    expect(frame).not.toContain('</nextsteps>');
    // The surrounding prose still renders.
    expect(frame).toContain('Done reviewing the file.');
  });

  it('hides the panel when the entry carries no final flag at all', () => {
    // Every construction site sets `final`. An entry without it comes from a
    // path we do not control, so it fails closed rather than leaking mid-turn
    // suggestions.
    const { frame, setSuggestions } = renderEntry({
      entry: { id: 3, kind: 'assistant', text: NEXT_STEPS_TEXT },
    });

    expect(frame).not.toContain('NEXT STEPS');
    expect(setSuggestions).not.toHaveBeenCalled();
    expect(frame).not.toContain('<nextsteps>');
  });
});
