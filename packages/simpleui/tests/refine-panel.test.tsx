// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RefinePanel } from '../src/refine-panel.js';
import type { RefineDecision, RefineState } from '../src/lib/refine-model.js';

const roots: Root[] = [];

interface Handlers {
  onDecision: (decision: RefineDecision) => void;
  onRetry: () => void;
  onRetryFallback: (ref: string) => void;
  onStartRefine: () => void;
  onSendEdited: (text: string) => void;
}

function makeState(overrides: Partial<RefineState> = {}): RefineState {
  return {
    original: 'fix the bug',
    refined: 'Fix the null-pointer bug in the parser',
    english: 'Fix the NPE in the parser',
    status: 'ready',
    ...overrides,
  };
}

function renderPanel(
  state: RefineState,
  overrides: Partial<Handlers> = {},
): { host: HTMLElement; handlers: Handlers; rerender: (next: RefineState) => void } {
  const handlers: Handlers = {
    onDecision: vi.fn(),
    onRetry: vi.fn(),
    onRetryFallback: vi.fn(),
    onStartRefine: vi.fn(),
    onSendEdited: vi.fn(),
    ...overrides,
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (s: RefineState) =>
    act(() =>
      root.render(
        <RefinePanel
          state={s}
          onDecision={handlers.onDecision}
          onRetry={handlers.onRetry}
          onRetryFallback={handlers.onRetryFallback}
          onStartRefine={handlers.onStartRefine}
          onSendEdited={handlers.onSendEdited}
        />,
      ),
    );
  render(state);
  return { host, handlers, rerender: render };
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('element not found');
  act(() => {
    (el as HTMLElement).click();
  });
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(label),
  );
  if (!button) throw new Error(`button "${label}" not found`);
  return button;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RefinePanel — countdown face', () => {
  it('fires onStartRefine exactly once when the countdown elapses', () => {
    const { handlers } = renderPanel(makeState({ status: 'countdown' }));
    expect(handlers.onStartRefine).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(handlers.onStartRefine).toHaveBeenCalledTimes(1);
    // Further ticks must not re-fire the request (one-shot guard).
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(handlers.onStartRefine).toHaveBeenCalledTimes(1);
  });

  it('"Refine now" skips the countdown and starts immediately', () => {
    const { host, handlers } = renderPanel(makeState({ status: 'countdown' }));
    click(findButton(host, 'Refine now'));
    expect(handlers.onStartRefine).toHaveBeenCalledTimes(1);
  });

  it('"Send as-is" resolves the original without starting a refine', () => {
    const { host, handlers } = renderPanel(makeState({ status: 'countdown' }));
    click(findButton(host, 'Send as-is'));
    expect(handlers.onDecision).toHaveBeenCalledWith('original');
    expect(handlers.onStartRefine).not.toHaveBeenCalled();
  });

  it('does not fire onStartRefine after the panel leaves the countdown face', () => {
    const { handlers, rerender } = renderPanel(makeState({ status: 'countdown' }));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    rerender(makeState({ status: 'refining' }));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(handlers.onStartRefine).not.toHaveBeenCalled();
  });
});

describe('RefinePanel — edit mode', () => {
  it('sends the edited text through onSendEdited', () => {
    const { host, handlers } = renderPanel(makeState());
    click(findButton(host, 'Edit'));
    const textarea = host.querySelector('textarea');
    if (!textarea) throw new Error('edit textarea not rendered');
    act(() => {
      // React 19 textarea value tracking: use the native setter so the
      // change event isn't swallowed by the controlled-input dedupe.
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'my hand-tuned prompt');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(findButton(host, 'Send edited'));
    expect(handlers.onSendEdited).toHaveBeenCalledWith('my hand-tuned prompt');
    expect(handlers.onDecision).not.toHaveBeenCalled();
  });

  it('prefills the edit buffer with the refined text', () => {
    const { host } = renderPanel(makeState({ refined: 'refined text here' }));
    click(findButton(host, 'Edit'));
    const textarea = host.querySelector('textarea');
    expect(textarea?.value).toBe('refined text here');
  });

  it('disables "Send edited" when the buffer is blank', () => {
    const { host } = renderPanel(makeState({ refined: 'x' }));
    click(findButton(host, 'Edit'));
    const textarea = host.querySelector('textarea');
    if (!textarea) throw new Error('edit textarea not rendered');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '   ');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(findButton(host, 'Send edited').disabled).toBe(true);
  });
});

describe('RefinePanel — keyboard shortcuts (ready face)', () => {
  function pressKey(key: string) {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  }

  it('Enter sends the refined text', () => {
    const { handlers } = renderPanel(makeState());
    pressKey('Enter');
    expect(handlers.onDecision).toHaveBeenCalledWith('refined');
  });

  it('O sends the original', () => {
    const { handlers } = renderPanel(makeState());
    pressKey('o');
    expect(handlers.onDecision).toHaveBeenCalledWith('original');
  });

  it('R triggers a retry', () => {
    const { handlers } = renderPanel(makeState());
    pressKey('r');
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
  });

  it('E sends English only when a distinct English version exists', () => {
    const { handlers } = renderPanel(makeState({ english: 'Fix the NPE in the parser' }));
    pressKey('e');
    expect(handlers.onDecision).toHaveBeenCalledWith('english');
  });

  it('E is inert when English matches the refined text', () => {
    const { handlers } = renderPanel(
      makeState({ english: 'Fix the null-pointer bug in the parser' }),
    );
    pressKey('e');
    expect(handlers.onDecision).not.toHaveBeenCalled();
  });

  it('shortcuts are inert on the refining face', () => {
    const { handlers } = renderPanel(makeState({ status: 'refining' }));
    pressKey('Enter');
    pressKey('o');
    expect(handlers.onDecision).not.toHaveBeenCalled();
  });
});
