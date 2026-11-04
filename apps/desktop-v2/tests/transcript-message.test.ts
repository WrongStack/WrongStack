import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { type MessageAction, TranscriptMessage } from '../src/TranscriptMessage';

// The message's tool summary reaches the native bridge, which needs a window.
vi.mock('../src/platform', () => ({}));

const render = (
  message: { id: string; role: 'user' | 'assistant'; text: string },
  actions: { edit?: MessageAction; askAgain?: MessageAction } = {},
) =>
  renderToStaticMarkup(
    createElement(TranscriptMessage, {
      message,
      state: { turnActivity: {}, turnStats: {} },
      onLink: () => {},
      onOpenFile: () => {},
      ...actions,
    }),
  );

describe('transcript message actions', () => {
  it('offers Edit in composer on a prompt, disabled with its reason', () => {
    const run = render({ id: 'u', role: 'user', text: 'fix it' }, { edit: { run: () => {} } });
    expect(run).toContain('Edit in composer');
    expect(run).not.toContain('Source');
    const blocked = render(
      { id: 'u', role: 'user', text: 'fix it' },
      { edit: { reason: 'Send or clear the composer draft first' } },
    );
    expect(blocked).toMatch(/disabled="" title="Send or clear the composer draft first"/);
  });

  it('offers Ask again and the Markdown source on an answer', () => {
    const html = render(
      { id: 'a', role: 'assistant', text: '**done**' },
      { askAgain: { run: () => {} } },
    );
    expect(html).toContain('Ask again');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('<strong>done</strong>');
    expect(render({ id: 'a', role: 'assistant', text: 'x' })).not.toContain('Ask again');
  });
});

describe('transcript message find marks', () => {
  it('marks the current match apart from the others', () => {
    const html = (mark: 'current' | 'match' | undefined) =>
      renderToStaticMarkup(
        createElement(TranscriptMessage, {
          message: { id: 'm1', role: 'assistant', text: 'x' },
          state: { turnActivity: {}, turnStats: {} },
          onLink: () => {},
          onOpenFile: () => {},
          mark,
        }),
      );
    expect(html('current')).toContain(
      'class="chat-message assistant find-current" data-message-id="m1"',
    );
    expect(html('match')).toContain('chat-message assistant find-match');
    expect(html(undefined)).toContain('class="chat-message assistant" data-message-id="m1"');
  });
});
