// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrainPanel } from '../src/brain-panel.js';
import { dispatchSimplePanel } from '../src/lib/panel-events.js';

const roots: Root[] = [];

/** A socket whose `onMessage` subscriber can be driven from the test. */
function socketHarness() {
  const listeners: Array<(msg: { type: string; payload?: unknown }) => void> = [];
  const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  return {
    sent,
    emit: (msg: { type: string; payload?: unknown }) => {
      for (const listener of [...listeners]) listener(msg);
    },
    socket: {
      send: (type: string, payload?: Record<string, unknown>) => void sent.push({ type, payload }),
      onMessage: (fn: (msg: { type: string; payload?: unknown }) => void) => {
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    },
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function renderPanel() {
  const harness = socketHarness();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<BrainPanel socketRef={{ current: harness.socket as never }} />));
  // The panel opens on the shared panel-event bus.
  act(() => dispatchSimplePanel('open-brain-panel'));
  return { container, ...harness };
}

describe('BrainPanel — answers', () => {
  it('shows the decision text, not the word "answer"', () => {
    const { container, emit } = renderPanel();

    act(() =>
      emit({
        type: 'brain.answer',
        payload: {
          question: 'Ship it?',
          decision: { type: 'answer', text: 'Ship behind a flag.', rationale: 'Reversible.' },
        },
      }),
    );

    // The panel read `decision.reason ?? decision.type`, and an `answer`
    // carries neither — so every successful reply rendered as "answer".
    expect(container.textContent).toContain('Ship behind a flag.');
    expect(container.textContent).toContain('Reversible.');
  });

  it('falls back to the chosen option id when the answer carries no text', () => {
    const { container, emit } = renderPanel();

    act(() =>
      emit({
        type: 'brain.answer',
        payload: { question: 'Merge?', decision: { type: 'answer', optionId: 'merge' } },
      }),
    );

    expect(container.textContent).toContain('merge');
  });

  it('shows the reason for a denial', () => {
    const { container, emit } = renderPanel();

    act(() =>
      emit({
        type: 'brain.answer',
        payload: {
          question: 'Force push?',
          decision: { type: 'deny', reason: 'Shared branch — not reversible.' },
        },
      }),
    );

    expect(container.textContent).toContain('Shared branch');
  });

  it('shows the prompt when the Brain escalates instead of deciding', () => {
    const { container, emit } = renderPanel();

    act(() =>
      emit({
        type: 'brain.answer',
        payload: {
          question: 'Deploy?',
          decision: { type: 'ask_human', prompt: 'Pick a deploy window.' },
        },
      }),
    );

    expect(container.textContent).toContain('Pick a deploy window.');
  });
});

describe('BrainPanel — tolerant payloads', () => {
  it('reads a decision that arrived without its type discriminator', () => {
    const { container, emit } = renderPanel();

    act(() =>
      emit({
        type: 'brain.answer',
        payload: { question: 'Proceed?', decision: { reason: 'Yes, guarded.' } },
      }),
    );

    expect(container.textContent).toContain('Yes, guarded.');
  });

  it('falls back to a placeholder rather than rendering nothing', () => {
    const { container, emit } = renderPanel();

    act(() => emit({ type: 'brain.answer', payload: { question: 'Proceed?', decision: {} } }));

    expect(container.textContent).toContain('Decided.');
  });
});
