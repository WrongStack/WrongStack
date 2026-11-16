import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { TranscriptMessage } from '../src/TranscriptMessage';

vi.mock('../src/platform', () => ({}));

const render = (state: ReturnType<typeof reduceEngine>) => {
  const message = state.messages.at(-1)!;
  return renderToStaticMarkup(
    createElement(TranscriptMessage, {
      message,
      state,
      onLink: () => {},
      onOpenFile: () => {},
    }),
  );
};

describe('a streaming answer', () => {
  it('keeps its unfinished paragraph as plain text only while text still arrives', () => {
    let state = { ...emptyEngineState, sessionId: 's', connected: true };
    state = reduceEngine(state, {
      type: 'desktop.user_message',
      payload: { id: 'u', content: 'go' },
    });
    state = reduceEngine(state, {
      type: 'provider.text_delta',
      payload: { messageId: 'm', text: 'Done.\n\nSee **the result**' },
    });
    expect(state.activeTextMessageId).toBe(state.messages.at(-1)!.id);
    const streaming = render(state);
    expect(streaming).toContain('markdown-stream-tail');
    expect(streaming).toContain('See **the result**');

    // The run goes on with tools after the answer: the answer is no longer being written.
    state = reduceEngine(state, {
      type: 'tool.started',
      payload: { id: 't1', name: 'bash', input: {} },
    });
    expect(state.running).toBe(true);
    expect(state.activeTextMessageId).toBeNull();
    const settled = render(state);
    expect(settled).not.toContain('markdown-stream-tail');
    expect(settled).toContain('<strong>the result</strong>');
  });
});
