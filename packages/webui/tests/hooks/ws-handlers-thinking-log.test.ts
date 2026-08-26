import { beforeEach, describe, expect, it, vi } from 'vitest';

// ws-handlers reaches for the live socket — stub it so handlers run server-less.
vi.mock('@/lib/ws-client', () => ({
  // `consumeRequestedSwitch` is how the real client tells the handler that
  // THIS surface asked for the swap, so the session may take the foreground.
  // Without it a `session.start` only fills its own lane, which is what keeps
  // a background re-announce from yanking the user out of the tab they are in.
  getWSClient: () => ({ send: vi.fn(), consumeRequestedSwitch: () => true }),
}));

import { handleError, WS_HANDLERS } from '../../src/hooks/ws-handlers';
import { streamCoalescer } from '../../src/lib/stream-coalescer';
import { useChatLanes } from '../../src/stores/chat-lanes';
import { useChatStore } from '../../src/stores/chat-store';
import { useSessionLanes } from '../../src/stores/session-lanes';
import { useSessionStore } from '../../src/stores/session-store';
import type { WSServerMessage } from '../../src/types';

/**
 * Fire a server message the way the server actually sends it: chat events are
 * always session-stamped (the server routes every one through
 * `sessionPayload`), and the client drops untagged ones so a background tab's
 * stream cannot append to the transcript in front. Tests that care about
 * cross-session routing pass an explicit `sessionId`.
 */
function fire(type: WSServerMessage['type'], payload: Record<string, unknown>) {
  const activeSessionId = useSessionStore.getState().session?.id;
  const stamped =
    'sessionId' in payload || !activeSessionId
      ? payload
      : { ...payload, sessionId: activeSessionId };
  WS_HANDLERS[type]?.({ type, payload: stamped } as never);
}

describe('thinking log ws-handlers', () => {
  beforeEach(() => {
    streamCoalescer.flushAll();
    // Each test starts from four empty lanes; a reasoning buffer left in
    // another tab's lane would prepend itself to the next archive.
    useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
    useSessionLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
    useChatStore.getState().clearMessages();
    useChatStore.getState().setLoading(false);
    useSessionStore.setState({ iteration: null });
    useSessionStore
      .getState()
      .setSession({ id: 'sess_thinking', startedAt: Date.now(), model: 'm', provider: 'p' });
  });

  it('preserves pending thinking deltas when provider.response clears the live bubble', () => {
    fire('provider.thinking_delta', { text: 'reasoning trace' });
    fire('provider.response', {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stopReason: 'end_turn',
      messageId: 'msg_1',
    });

    expect(useChatStore.getState().thinkingBuffer).toBe('');
    expect(useChatStore.getState().thinkingLogBuffer).toBe('reasoning trace');

    fire('iteration.completed', { index: 1 });

    const logMessage = useChatStore.getState().messages.find((m) => m.thinkingLog);
    expect(logMessage?.role).toBe('system');
    expect(logMessage?.thinkingLog?.text).toBe('reasoning trace');
    expect(useChatStore.getState().thinkingLogBuffer).toBe('');
  });

  it('drops pending stream deltas on session reset', () => {
    fire('provider.thinking_delta', { text: 'old reasoning' });
    fire('session.start', {
      sessionId: 'next-session',
      model: 'test-model',
      provider: 'test-provider',
      reset: true,
    });
    streamCoalescer.flushAll();

    expect(useChatStore.getState().thinkingBuffer).toBe('');
    expect(useChatStore.getState().thinkingLogBuffer).toBe('');
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it('archives pending thinking before a terminal generic error', () => {
    useSessionStore.setState({ iteration: { index: 4, max: 10 } });
    fire('provider.thinking_delta', { text: 'reasoning before failure' });
    fire('error', { phase: 'agent.run', message: 'boom' });

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.thinkingLog).toMatchObject({
      iteration: 4,
      text: 'reasoning before failure',
    });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: '[agent.run] boom',
      isError: true,
    });
    expect(useChatStore.getState().thinkingBuffer).toBe('');
    expect(useChatStore.getState().thinkingLogBuffer).toBe('');
  });

  it('keeps the legacy exported error handler aligned with the active map handler', () => {
    useSessionStore.setState({ iteration: { index: 2, max: 10 } });
    fire('provider.thinking_delta', { text: 'legacy export reasoning' });

    handleError({ type: 'error', payload: { phase: 'legacy', message: 'boom' } } as never);

    const messages = useChatStore.getState().messages;
    expect(messages[0]?.thinkingLog).toMatchObject({
      iteration: 2,
      text: 'legacy export reasoning',
    });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: '[legacy] boom',
      isError: true,
    });
  });
});
