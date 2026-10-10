// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useComposerState } from '../src/hooks/use-composer-state.js';
import type { ChatMessage } from '../src/types.js';

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
});

function messagesState() {
  let current: ChatMessage[] = [];
  const setMessages = vi.fn((update: unknown) => {
    current =
      typeof update === 'function'
        ? (update as (prev: ChatMessage[]) => ChatMessage[])(current)
        : (update as ChatMessage[]);
  });
  return { setMessages, read: () => current };
}

function mountComposerState(prefs: Record<string, unknown>) {
  const socket = { send: vi.fn() };
  const messages = messagesState();
  const setRunning = vi.fn();
  const options = {
    session: { id: 'sess-c' },
    sessionIdRef: { current: 'sess-c' },
    socketRef: { current: socket },
    running: false,
    runningRef: { current: false },
    prefsRef: { current: prefs },
    activeModelRef: { current: null },
    setMessages: messages.setMessages,
    setRunning,
    setToolCalls: vi.fn(),
    setActivity: vi.fn(),
    setNotice: vi.fn(),
  };
  const holder: { current: ReturnType<typeof useComposerState> | null } = { current: null };
  function Probe(): null {
    holder.current = useComposerState(options as never);
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<Probe />));
  return { holder, socket, messages, setRunning };
}

describe('useComposerState — send chain', () => {
  it('startSend dispatches directly when enhancement is off', () => {
    const { holder, socket, messages, setRunning } = mountComposerState({
      enhanceEnabled: false,
      confirmExit: false,
    });

    act(() => holder.current!.startSend('hello'));

    expect(socket.send).toHaveBeenCalledWith(
      'user_message',
      expect.objectContaining({ content: 'hello', sessionId: 'sess-c' }),
    );
    expect(setRunning).toHaveBeenCalledWith(true);
    expect(messages.read().at(-1)).toMatchObject({ role: 'user', text: 'hello' });
    expect(holder.current!.refineState).toBeNull();
  });

  it('startSend opens the refine countdown when enhancement is on', () => {
    const { holder, socket } = mountComposerState({
      enhanceEnabled: true,
      refinerFallbackProfile: '',
      fallbackProfiles: {},
      refinerProvider: '',
      refinerModel: '',
      confirmExit: false,
    });

    act(() => holder.current!.startSend('refine me'));

    expect(socket.send).not.toHaveBeenCalled();
    expect(holder.current!.refineState).toMatchObject({
      status: 'countdown',
      original: 'refine me',
    });
  });

  it('refineStartNow defers the model.refine send to post-commit', () => {
    const { holder, socket } = mountComposerState({
      enhanceEnabled: true,
      refinerFallbackProfile: '',
      fallbackProfiles: {},
      refinerProvider: '',
      refinerModel: '',
      confirmExit: false,
    });

    act(() => holder.current!.startSend('refine me'));
    act(() => holder.current!.refineStartNow());

    // The pendingSend effect fires after the 'refining' commit — never from
    // inside the setState updater.
    expect(socket.send).toHaveBeenCalledWith('model.refine', { text: 'refine me' });
    expect(holder.current!.refineState).toMatchObject({ status: 'refining' });
  });
});
