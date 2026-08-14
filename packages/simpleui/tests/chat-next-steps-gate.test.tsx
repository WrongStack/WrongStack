// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatMessageList } from '../src/chat-message-list.js';
import type { ChatMessage } from '../src/types.js';

/**
 * The NEXT STEPS panel may only come from the final message of a turn.
 * `message.final` is set from the provider's stop reason (and from the
 * message's blocks on replay), so prose the model wrote on its way to a tool
 * call stays silent. Either way the `<nextsteps>` block is stripped from the
 * body — only the panel is gated.
 */

const roots: Array<ReturnType<typeof createRoot>> = [];

const WITH_NEXT_STEPS = [
  'Working on it.',
  '',
  '<nextsteps>',
  '1. Run the focused tests',
  '2. Review the diff',
  '</nextsteps>',
].join('\n');

function assistantMessage(
  text: string,
  final: boolean | undefined,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: 'msg_1',
    role: 'assistant',
    text,
    ts: '2026-07-31T12:00:00.000Z',
    final,
    ...overrides,
  } as ChatMessage;
}

function renderList(final: boolean | undefined): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      <ChatMessageList
        messages={[assistantMessage(WITH_NEXT_STEPS, final)]}
        copiedMessageId={null}
        running={false}
        activity=""
        emptyState={null}
        theme="dark"
        onCopyMessage={() => undefined}
        onSelectNextStep={() => undefined}
        consumedNextSteps={new Set<string>()}
      />,
    );
  });
  return host;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

describe('SimpleUI next-steps final-message gate', () => {
  it('hides the panel for mid-turn prose', () => {
    const host = renderList(false);

    expect(host.querySelector('.next-steps')).toBeNull();
    // The raw block never renders, panel or not.
    expect(host.textContent).not.toContain('<nextsteps>');
    expect(host.textContent).not.toContain('Run the focused tests');
  });

  it('hides the panel when the message carries no final flag at all', () => {
    const host = renderList(undefined);

    expect(host.querySelector('.next-steps')).toBeNull();
    expect(host.textContent).not.toContain('<nextsteps>');
  });

  it('shows the panel on the turn-final message', () => {
    const host = renderList(true);

    const panel = host.querySelector('.next-steps');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Run the focused tests');
    expect(panel?.textContent).toContain('Review the diff');
    expect(host.textContent).not.toContain('<nextsteps>');
  });

  it('renders structured nextsteps tool input with no XML fallback text', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => {
      root.render(
        <ChatMessageList
          messages={[
            {
              ...assistantMessage('', true),
              nextSteps: [{ index: 1, text: 'Run the focused tests', auto: true }],
            },
          ]}
          copiedMessageId={null}
          running={false}
          activity=""
          emptyState={null}
          theme="dark"
          onCopyMessage={() => undefined}
          onSelectNextStep={() => undefined}
          consumedNextSteps={new Set<string>()}
        />,
      );
    });

    expect(host.querySelector('.next-steps')?.textContent).toContain('Run the focused tests');
    expect(host.textContent).not.toContain('<nextsteps>');
  });

  it('shows next steps only for the latest assistant response', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => {
      root.render(
        <ChatMessageList
          messages={[
            assistantMessage(WITH_NEXT_STEPS, true),
            assistantMessage(
              WITH_NEXT_STEPS.replace('Run the focused tests', 'Inspect the final diff'),
              true,
              {
                id: 'msg_2',
                ts: '2026-07-31T12:01:00.000Z',
              },
            ),
          ]}
          copiedMessageId={null}
          running={false}
          activity=""
          emptyState={null}
          theme="dark"
          onCopyMessage={() => undefined}
          onSelectNextStep={() => undefined}
          consumedNextSteps={new Set<string>()}
        />,
      );
    });

    expect(host.textContent).not.toContain('Run the focused tests');
    expect(host.textContent).toContain('Inspect the final diff');
  });
});
