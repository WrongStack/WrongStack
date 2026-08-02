// requestAnimationFrame polyfill for jsdom — flush immediately
const rafCallbacks: FrameRequestCallback[] = [];
(globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame = (
  cb: FrameRequestCallback,
) => {
  rafCallbacks.push(cb);
  return rafCallbacks.length;
};
(globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame }).cancelAnimationFrame = (
  handle: number,
) => {
  rafCallbacks[handle - 1] = undefined as never as FrameRequestCallback;
};
function flushRaf() {
  const cbs = rafCallbacks.splice(0, rafCallbacks.length);
  for (const cb of cbs) if (cb) cb(performance.now());
}

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileMentionPicker } from '../../src/components/ChatInput/file-mention-picker.js';
import { QueuedMessages } from '../../src/components/ChatInput/queued-messages.js';
import type { QueuedItem } from '../../src/stores/chat-store.js';
import { useFileReferenceStore } from '../../src/stores/file-reference-store.js';

// Helper for test readability — wrap a string in the new queue-item shape.
// `addedAt` is the index in the source list so tests can keep a stable
// display order without having to mock `Date.now`.
function makeQueue(items: ReadonlyArray<{ text: string; mode: QueuedItem['mode'] }>): QueuedItem[] {
  return items.map((item, idx) => ({
    text: item.text,
    mode: item.mode,
    addedAt: idx,
    itemId: idx,
  }));
}

function _mockTextarea(): HTMLTextAreaElement {
  return {
    focus: vi.fn(),
    setSelectionRange: vi.fn(),
    selectionStart: 0,
    selectionEnd: 0,
  } as never as HTMLTextAreaElement;
}

// Mock FilePicker so we can test FileMentionPicker logic without file-tree rendering
vi.mock('../../src/components/FilePicker', () => ({
  FilePicker: ({
    query,
    onClose,
    onPick,
  }: {
    query: string;
    onClose: () => void;
    onPick: (path: string) => void;
  }) => (
    <div data-testid="file-picker">
      <span data-testid="fp-query">{query}</span>
      <button type="button" onClick={() => onPick('src/index.ts')}>
        Pick src/index.ts
      </button>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

describe('QueuedMessages', () => {
  it('renders nothing when queue is empty', () => {
    const { container } = render(
      <QueuedMessages queue={[]} onClear={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(container.children.length === 0 || container.firstChild === null).toBe(true);
  });

  it('renders queue count and items', () => {
    render(
      <QueuedMessages
        queue={makeQueue([
          { text: 'first', mode: 'btw' },
          { text: 'second', mode: 'queue' },
        ])}
        onClear={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText(/Queue \(2\)/)).toBeDefined();
    expect(screen.getByText('first')).toBeDefined();
    expect(screen.getByText('second')).toBeDefined();
  });

  it('renders a mode badge per item showing btw/steer/queue', () => {
    render(
      <QueuedMessages
        queue={makeQueue([
          { text: 'a', mode: 'btw' },
          { text: 'b', mode: 'steer' },
          { text: 'c', mode: 'queue' },
        ])}
        onClear={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getAllByText('btw')).toHaveLength(1);
    expect(screen.getAllByText('steer')).toHaveLength(1);
    expect(screen.getAllByText('queue')).toHaveLength(1);
  });

  it('calls onClear when Clear all is clicked', () => {
    const onClear = vi.fn();
    render(
      <QueuedMessages
        queue={makeQueue([{ text: 'msg', mode: 'queue' }])}
        onClear={onClear}
        onRemove={vi.fn()}
      />,
    );

    // The clear-all control is icon-only (its label lives in the i18n
    // title attribute) — target the stable testid rather than display text.
    fireEvent.click(screen.getByTestId('inline-queue-clear-all'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('calls onRemove with the source-array index even when sorted newest-first', () => {
    const onRemove = vi.fn();
    // Source order: [a@0, b@1, c@2]. addedAt is set so newest-first
    // reorders the rendered list to [c, b, a] — but the × buttons must
    // still pass the *source* index (1 for "b") so the store stays sane.
    const queue = makeQueue([
      { text: 'a', mode: 'btw' },
      { text: 'b', mode: 'steer' },
      { text: 'c', mode: 'queue' },
    ]);
    render(<QueuedMessages queue={queue} onClear={vi.fn()} onRemove={onRemove} />);

    // Flip the sort to newest-first so the rendered order no longer
    // matches the source order.
    fireEvent.click(screen.getByTestId('inline-queue-sort'));

    // The × button for the *middle* item in the source list ("b")
    // is now rendered in a different position, but its data-testid
    // stays tied to the source index.
    fireEvent.click(screen.getByTestId('inline-queue-remove-1'));
    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it('calls onRemove with the source-array index when not sorted', () => {
    const onRemove = vi.fn();
    render(
      <QueuedMessages
        queue={makeQueue([
          { text: 'a', mode: 'btw' },
          { text: 'b', mode: 'steer' },
          { text: 'c', mode: 'queue' },
        ])}
        onClear={vi.fn()}
        onRemove={onRemove}
      />,
    );

    const removeButtons = screen.getAllByTitle('Remove from queue');
    expect(removeButtons).toHaveLength(3);

    fireEvent.click(removeButtons[1]!);
    expect(onRemove).toHaveBeenCalledWith(1);
  });
});

describe('FileMentionPicker', () => {
  const mockTextarea = (overrides: Partial<HTMLTextAreaElement> = {}) =>
    ({
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
      style: { height: '' },
      scrollHeight: 100,
      ...overrides,
    }) as never as HTMLTextAreaElement;

  beforeEach(() => {
    useFileReferenceStore.setState({ refs: [] });
  });

  it('renders nothing when atMention is null', () => {
    const { container } = render(
      <FileMentionPicker
        atMention={null}
        input=""
        textareaRef={{ current: null }}
        setInput={vi.fn()}
        setAtMention={vi.fn()}
      />,
    );
    expect(container.children.length === 0 || container.firstChild === null).toBe(true);
  });

  it('renders FilePicker with the current query', () => {
    render(
      <FileMentionPicker
        atMention={{ start: 5, query: 'compo' }}
        input="test @compo rest"
        textareaRef={{ current: null }}
        setInput={vi.fn()}
        setAtMention={vi.fn()}
      />,
    );

    expect(screen.getByTestId('fp-query').textContent).toBe('compo');
  });

  it('calls setAtMention(null) when FilePicker is closed', () => {
    const setAtMention = vi.fn();
    render(
      <FileMentionPicker
        atMention={{ start: 0, query: 'test' }}
        input="@test"
        textareaRef={{ current: null }}
        setInput={vi.fn()}
        setAtMention={setAtMention}
      />,
    );

    fireEvent.click(screen.getByText('Close'));
    expect(setAtMention).toHaveBeenCalledWith(null);
  });

  it('removes the @query token, clears atMention, and adds a file ref', () => {
    const setInput = vi.fn();
    const setAtMention = vi.fn();

    render(
      <FileMentionPicker
        atMention={{ start: 0, query: 'com' }}
        input="@com rest"
        textareaRef={{ current: null }}
        setInput={setInput}
        setAtMention={setAtMention}
      />,
    );

    fireEvent.click(screen.getByText('Pick src/index.ts'));

    // before = "" (slice 0..0), after = " rest" (slice 0+1+3=4..end),
    // collapsed + trimmed → "rest". The `@query` token is removed from the
    // textarea; the chosen file is added as a reference chip instead.
    expect(setInput).toHaveBeenCalledWith('rest');
    expect(setAtMention).toHaveBeenCalledWith(null);
    const refs = useFileReferenceStore.getState().refs;
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: 'file', path: 'src/index.ts' });
  });

  it('restores cursor position and textarea height after pick', () => {
    const textarea = mockTextarea();
    const setInput = vi.fn();
    const setAtMention = vi.fn();

    render(
      <FileMentionPicker
        atMention={{ start: 0, query: 'x' }}
        input="@x end"
        textareaRef={{ current: textarea }}
        setInput={setInput}
        setAtMention={setAtMention}
      />,
    );

    fireEvent.click(screen.getByText('Pick src/index.ts'));

    // Flush requestAnimationFrame
    flushRaf();

    expect(textarea.focus).toHaveBeenCalledTimes(1);
    expect(textarea.setSelectionRange).toHaveBeenCalled();
  });
});
