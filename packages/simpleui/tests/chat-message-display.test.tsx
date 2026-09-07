// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyScrollAnchoring,
  CHAT_WINDOW_SIZE,
  ChatMessageList,
} from '../src/chat-message-list.js';
import type { ChatMessage } from '../src/types.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Display-layer coverage for ChatMessageList: optional per-message timestamps
 * (the showTimestamps pref) and the per-message copy affordance (assistant
 * AND user messages; hidden for empty and streaming messages).
 */

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'u1',
    role: 'user',
    text: 'please fix the parser',
    ts: '2026-09-07T10:30:00.000Z',
    ...overrides,
  } as ChatMessage;
}

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    text: 'Done — parser fixed.',
    ts: '2026-09-07T10:31:00.000Z',
    final: true,
    ...overrides,
  } as ChatMessage;
}

function renderList(
  messages: ChatMessage[],
  options: { showTimestamps?: boolean } = {},
): {
  host: HTMLElement;
  onCopyMessage: ReturnType<typeof vi.fn>;
  rerender: (next: ChatMessage[]) => void;
} {
  const onCopyMessage = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      <ChatMessageList
        messages={messages}
        copiedMessageId={null}
        running={false}
        activity=""
        emptyState={null}
        theme="dark"
        showTimestamps={options.showTimestamps}
        onCopyMessage={onCopyMessage}
        onSelectNextStep={() => undefined}
        consumedNextSteps={new Set<string>()}
      />,
    );
  });
  const rerender = (next: ChatMessage[]) => {
    act(() => {
      root.render(
        <ChatMessageList
          messages={next}
          copiedMessageId={null}
          running={false}
          activity=""
          emptyState={null}
          theme="dark"
          showTimestamps={options.showTimestamps}
          onCopyMessage={onCopyMessage}
          onSelectNextStep={() => undefined}
          consumedNextSteps={new Set<string>()}
        />,
      );
    });
  };
  return { host, onCopyMessage, rerender };
}

describe('ChatMessageList — timestamps', () => {
  it('hides timestamps by default', () => {
    const { host } = renderList([userMessage()]);
    expect(host.querySelector('.message-time')).toBeNull();
  });

  it('renders a <time> element with dateTime when enabled', () => {
    const { host } = renderList([userMessage()], { showTimestamps: true });
    const time = host.querySelector('time.message-time');
    expect(time).not.toBeNull();
    expect(time?.getAttribute('datetime')).toBe('2026-09-07T10:30:00.000Z');
    expect(time?.textContent).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('ChatMessageList — copy affordance', () => {
  it('offers copy on user messages and forwards the raw text', () => {
    const { host, onCopyMessage } = renderList([userMessage()]);
    const button = host.querySelector('button[aria-label="Copy message"]');
    expect(button).not.toBeNull();
    act(() => (button as HTMLButtonElement).click());
    expect(onCopyMessage).toHaveBeenCalledWith('u1', 'please fix the parser');
  });

  it('keeps the assistant copy affordance', () => {
    const { host, onCopyMessage } = renderList([assistantMessage()]);
    const button = host.querySelector('button[aria-label="Copy response"]');
    expect(button).not.toBeNull();
    act(() => (button as HTMLButtonElement).click());
    expect(onCopyMessage).toHaveBeenCalledWith('a1', 'Done — parser fixed.');
  });

  it('offers no copy button for an image-only user message', () => {
    const { host } = renderList([userMessage({ text: '' })]);
    expect(host.querySelector('button[aria-label="Copy message"]')).toBeNull();
  });

  it('hides copy while the message is streaming', () => {
    const { host } = renderList([assistantMessage({ streaming: true })]);
    expect(host.querySelector('button[aria-label="Copy response"]')).toBeNull();
  });
});

describe('ChatMessageList — windowing', () => {
  function manyMessages(prefix: string, count: number): ChatMessage[] {
    return Array.from({ length: count }, (_, i) =>
      userMessage({ id: `${prefix}${i}`, text: `${prefix} message ${i}` }),
    );
  }

  it('renders only the latest window for long transcripts, with an expander', () => {
    const { host } = renderList(manyMessages('m', 150));
    expect(host.querySelectorAll('article.message').length).toBe(CHAT_WINDOW_SIZE);
    // The window keeps the LATEST entries. (Body text renders via async
    // MarkdownHooks — assert on DOM identity, not textContent.)
    expect(host.querySelector('article[data-message-id="m149"]')).not.toBeNull();
    expect(host.querySelector('article[data-message-id="m0"]')).toBeNull();
    const expander = host.querySelector('button.window-earlier');
    expect(expander?.textContent).toContain('90');
  });

  it('reveals earlier windows progressively until nothing is hidden', () => {
    const { host } = renderList(manyMessages('m', 150));
    const expander = () => host.querySelector('button.window-earlier') as HTMLButtonElement;
    act(() => expander().click());
    expect(host.querySelectorAll('article.message').length).toBe(CHAT_WINDOW_SIZE * 2);
    expect(expander().textContent).toContain('30');
    act(() => expander().click());
    expect(host.querySelectorAll('article.message').length).toBe(150);
    expect(host.querySelector('button.window-earlier')).toBeNull();
  });

  it('leaves short transcripts untouched', () => {
    const { host } = renderList([userMessage()]);
    expect(host.querySelectorAll('article.message').length).toBe(1);
    expect(host.querySelector('button.window-earlier')).toBeNull();
  });

  it('resets the window when the transcript is wholesale-replaced', () => {
    const first = manyMessages('old-', 150);
    const second = manyMessages('new-', 150);
    const { host, rerender } = renderList(first);
    act(() => (host.querySelector('button.window-earlier') as HTMLButtonElement).click());
    expect(host.querySelectorAll('article.message').length).toBe(CHAT_WINDOW_SIZE * 2);
    rerender(second);
    expect(host.querySelectorAll('article.message').length).toBe(CHAT_WINDOW_SIZE);
    expect(host.querySelector('article[data-message-id="new-149"]')).not.toBeNull();
    expect(host.querySelector('article[data-message-id="old-149"]')).toBeNull();
    expect(host.querySelector('button.window-earlier')?.textContent).toContain('90');
  });

  it('compensates the .chat-scroll scroll position after an expansion', () => {
    // jsdom does no layout, so the height delta is simulated with a
    // read-sequence getter: the click handler's read sees the pre-expansion
    // height, the layout effect's read sees the post-expansion height.
    const host = document.createElement('div');
    host.className = 'chat-scroll';
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => {
      root.render(
        <ChatMessageList
          messages={manyMessages('m', 150)}
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

    const setSpy = vi.spyOn(host, 'scrollTop', 'set');
    const convo = host.querySelector('.conversation') as HTMLElement;
    let reads = 0;
    Object.defineProperty(convo, 'scrollHeight', {
      configurable: true,
      get: () => (reads++ === 0 ? 1000 : 1600),
    });

    const expander = host.querySelector('button.window-earlier') as HTMLButtonElement;
    act(() => expander.click());

    expect(setSpy).toHaveBeenCalledWith(600);
  });
});

describe('applyScrollAnchoring', () => {
  it('advances scrollTop by the inserted height', () => {
    const scroller = document.createElement('div');
    const setSpy = vi.spyOn(scroller, 'scrollTop', 'set');
    applyScrollAnchoring(scroller, 1000, 1600);
    expect(setSpy).toHaveBeenCalledWith(600);
  });

  it('leaves the scroller untouched when nothing grew or it shrank', () => {
    const scroller = document.createElement('div');
    const setSpy = vi.spyOn(scroller, 'scrollTop', 'set');
    applyScrollAnchoring(scroller, 1000, 1000);
    applyScrollAnchoring(scroller, 1000, 800);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('tolerates a missing scroller', () => {
    expect(() => applyScrollAnchoring(null, 1000, 1600)).not.toThrow();
  });
});
