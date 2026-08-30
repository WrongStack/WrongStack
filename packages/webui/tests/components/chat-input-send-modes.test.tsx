// Polyfill requestAnimationFrame for jsdom — flush immediately so the
// post-submit focus/selection side-effects in ChatInput don't queue up
// against the next render.
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

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── WS hook mock ──────────────────────────────────────────────────────
// We don't care about the wire protocol here; we just need to verify
// that the three send-mode buttons call the right client methods in the
// right order. Capture every imperative call so each test can assert.
const wsCalls: Array<{ name: string; args: unknown[] }> = [];
const { confirmModalChoiceMock } = vi.hoisted(() => ({ confirmModalChoiceMock: vi.fn() }));
const wsMock = {
  sendMessage: vi.fn((_content: string, _imageBase64?: string) => 'msg_id'),
  sendAbort: vi.fn(),
  refineModel: vi.fn(),
  // Mirror the full useWebSocket surface ChatInput destructures/calls.
  // `updatePrefs` is invoked by the enhance toggle (ChatInput.tsx:155,988);
  // `sendMailboxMessage` is exposed by the hook for the btw mid-run path.
  // Omitting them leaves `undefined` on the destructure and throws the
  // moment a test exercises those controls.
  sendMailboxMessage: vi.fn(),
  updatePrefs: vi.fn(),
  // Annotated, not `as const`: inferring `source: 'local'` narrowed the mock's
  // return type so cases overriding it with 'model' no longer typechecked.
  adviseTopic: vi.fn(
    async (): Promise<{
      suggestNewContext: boolean;
      confidence: number;
      reason: string;
      nextTopic?: string | undefined;
      source: 'explicit' | 'model' | 'cache' | 'local';
    }> => ({
      suggestNewContext: false,
      confidence: 1,
      reason: 'same topic',
      source: 'local',
    }),
  ),
  client: {
    isConnected: true,
    supportsCapability: vi.fn(() => true),
    send: vi.fn(),
    onStatus: () => () => {},
  },
};
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => wsMock,
}));
vi.mock('@/components/ConfirmModal', () => ({
  confirmModalChoice: confirmModalChoiceMock,
  useConfirmModalStore: { getState: () => ({ settle: vi.fn() }) },
}));
vi.mock('@/hooks/useProviderModels', () => ({ useProviderModels: () => [] }));

// Stub heavy presentational children so the ChatInput test stays focused
// on the send-mode buttons + Stop button.
vi.mock('@/components/RefinePanel', () => ({ RefinePanel: () => null }));
vi.mock('@/components/ChatInput/file-mention-picker', () => ({
  FileMentionPicker: () => null,
  detectAtMention: () => null,
}));

import { ChatInput } from '../../src/components/ChatInput.js';
import { useChatStore } from '../../src/stores/chat-store.js';
import { useFileReferenceStore } from '../../src/stores/file-reference-store.js';
import { useLocalPrefs } from '../../src/stores/local-prefs.js';
import { useSessionStore } from '../../src/stores/session-store.js';
import { useUIStore } from '../../src/stores/ui-store.js';

beforeEach(() => {
  wsCalls.length = 0;
  wsMock.sendMessage.mockClear();
  wsMock.sendAbort.mockClear();
  wsMock.refineModel.mockClear();
  wsMock.sendMailboxMessage.mockClear();
  wsMock.updatePrefs.mockClear();
  wsMock.adviseTopic.mockClear();
  wsMock.client.supportsCapability.mockClear();
  confirmModalChoiceMock.mockReset();
  // Reset the chat store between tests so the queue / loading state
  // from one test doesn't bleed into the next.
  useChatStore.setState({
    messages: [],
    queue: [],
    isLoading: false,
  });
  useFileReferenceStore.setState({ refs: [] });
  // Refinement (enhance) defaults to enabled, but these tests focus on the
  // plain send path. Force it off so the refine branch doesn't swallow our
  // assertions. The enhance gate lives in local-prefs (`enhanceEnabled`); the
  // open-panel state stays in the UI store (`refinePanel`).
  useLocalPrefs.setState({ enhanceEnabled: false });
  useUIStore.setState({ refinePanel: null });
});

afterEach(() => {
  flushRaf();
});

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
}

describe('ChatInput — send-mode buttons', () => {
  it('renders only refining + submit before the chat has started', () => {
    render(<ChatInput />);

    // No run-mode trio yet — there's nothing to interrupt, steer, or
    // queue against before the user has even sent a first prompt.
    expect(screen.queryByTestId('send-btw')).toBeNull();
    expect(screen.queryByTestId('send-steer')).toBeNull();
    expect(screen.queryByTestId('send-queue')).toBeNull();
    expect(screen.queryByTestId('stop')).toBeNull();
    expect(screen.queryByTestId('stop-and-edit')).toBeNull();

    // Only the refining toggle and the plain submit button are visible.
    expect(screen.getByTestId('send-submit')).toBeDefined();
  });

  it('reveals btw/steer/queue once the chat has at least one message', () => {
    useChatStore.setState({
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    });
    render(<ChatInput />);

    expect(screen.getByTestId('send-btw')).toBeDefined();
    expect(screen.getByTestId('send-steer')).toBeDefined();
    expect(screen.getByTestId('send-queue')).toBeDefined();
    // Send remains available while chat-mode controls are visible.
    expect(screen.getByTestId('send-submit')).toBeDefined();
    // Stop stays hidden — the agent isn't currently running.
    expect(screen.queryByTestId('stop')).toBeNull();
  });

  it('keeps the Stop button visible while the agent is running', () => {
    useChatStore.setState({
      isLoading: true,
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    });
    render(<ChatInput />);

    expect(screen.getByTestId('stop')).toBeDefined();
    expect(screen.getByTestId('stop-and-edit')).toBeDefined();
    // The three send-mode buttons stay visible while running so the
    // user can still btw/steer/queue follow-ups.
    expect(screen.getByTestId('send-btw')).toBeDefined();
    expect(screen.getByTestId('send-steer')).toBeDefined();
    expect(screen.getByTestId('send-queue')).toBeDefined();
  });

  it('updates the composer controls when switching from a running tab to an empty tab', () => {
    useSessionStore.setState({
      session: { id: 'session-A', startedAt: 1, provider: 'test', model: 'test' },
    });
    useChatStore.setState({
      isLoading: true,
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    });
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Type a btw/) as HTMLTextAreaElement;
    const form = textarea.closest('form');

    expect(form?.getAttribute('data-session-id')).toBe('session-A');
    expect(form?.getAttribute('data-running')).toBe('true');
    expect(screen.getByTestId('stop')).toBeDefined();
    expect(screen.getByTestId('send-btw')).toBeDefined();

    act(() => {
      useSessionStore.setState({
        session: { id: 'session-B', startedAt: 2, provider: 'test', model: 'test' },
      });
    });

    expect(form?.getAttribute('data-session-id')).toBe('session-B');
    expect(form?.getAttribute('data-running')).toBe('false');
    expect(screen.queryByTestId('stop')).toBeNull();
    expect(screen.queryByTestId('stop-and-edit')).toBeNull();
    expect(screen.queryByTestId('send-btw')).toBeNull();
    expect(screen.queryByTestId('send-steer')).toBeNull();
    expect(screen.queryByTestId('send-queue')).toBeNull();
    expect(screen.getByTestId('send-submit')).toBeDefined();
  });

  it('hides the Stop button while idle (no run to interrupt)', () => {
    useChatStore.setState({
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    });
    render(<ChatInput />);
    expect(screen.queryByTestId('stop')).toBeNull();
    expect(screen.queryByTestId('stop-and-edit')).toBeNull();
  });

  it('btw while idle sends the message directly', () => {
    useChatStore.setState({
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    });
    render(<ChatInput />);

    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, 'hello agent');
    fireEvent.click(screen.getByTestId('send-btw'));

    expect(wsMock.sendAbort).not.toHaveBeenCalled();
    expect(wsMock.sendMessage).toHaveBeenCalledTimes(1);
    expect(wsMock.sendMessage).toHaveBeenCalledWith('hello agent', undefined);
  });

  it('offers a same-session fresh context for a detected topic shift', async () => {
    useChatStore.setState({
      messages: Array.from({ length: 5 }, (_, index) => ({
        id: `m${index}`,
        role: 'user' as const,
        content: `authentication task ${index}`,
        timestamp: index,
      })),
    });
    wsMock.adviseTopic.mockResolvedValueOnce({
      suggestNewContext: true,
      confidence: 0.94,
      reason: 'different goal',
      nextTopic: 'deployment planning',
      source: 'model',
    });
    confirmModalChoiceMock.mockResolvedValueOnce('confirm');
    render(<ChatInput />);

    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, 'Plan a Kubernetes deployment for another product.');
    fireEvent.click(screen.getByTestId('send-btw'));

    await waitFor(() => {
      expect(wsMock.sendMessage).toHaveBeenCalledWith(
        'Plan a Kubernetes deployment for another product.',
        undefined,
        true,
      );
    });
    expect(confirmModalChoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmLabel: 'New context',
        cancelLabel: 'Same context',
        defaultAction: 'cancel',
      }),
    );
  });

  it('keeps the draft when the topic choice is dismissed', async () => {
    useChatStore.setState({
      messages: Array.from({ length: 5 }, (_, index) => ({
        id: `m${index}`,
        role: 'user' as const,
        content: `authentication task ${index}`,
        timestamp: index,
      })),
    });
    wsMock.adviseTopic.mockResolvedValueOnce({
      suggestNewContext: true,
      confidence: 0.94,
      reason: 'different goal',
      source: 'model',
    });
    confirmModalChoiceMock.mockResolvedValueOnce('dismiss');
    render(<ChatInput />);

    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, 'Keep this draft if I press Escape.');
    fireEvent.click(screen.getByTestId('send-btw'));

    await waitFor(() => expect(confirmModalChoiceMock).toHaveBeenCalledTimes(1));
    expect(wsMock.sendMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe('Keep this draft if I press Escape.');
  });

  it('steer while idle collapses to a plain send (no abort target)', () => {
    useChatStore.setState({
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    });
    render(<ChatInput />);

    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, 'hi');
    fireEvent.click(screen.getByTestId('send-steer'));

    expect(wsMock.sendAbort).not.toHaveBeenCalled();
    expect(wsMock.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('addQueue while idle always enqueues (does not send)', () => {
    useChatStore.setState({
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    });
    render(<ChatInput />);

    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, 'for later');
    fireEvent.click(screen.getByTestId('send-queue'));

    expect(wsMock.sendMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().queue).toEqual([
      expect.objectContaining({
        text: 'for later',
        mode: 'queue',
        addedAt: expect.any(Number),
      }),
    ]);
  });

  it('submit (plain send) is the only send control visible before the first message', () => {
    render(<ChatInput />);

    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, 'hello agent');
    fireEvent.click(screen.getByTestId('send-submit'));

    expect(wsMock.sendAbort).not.toHaveBeenCalled();
    expect(wsMock.sendMessage).toHaveBeenCalledTimes(1);
    expect(wsMock.sendMessage).toHaveBeenCalledWith('hello agent', undefined);
  });

  it('/fix preserves file refs and sends an explicit complete-read contract', () => {
    useFileReferenceStore.getState().addRef({ kind: 'file', path: 'src/large.ts' });
    render(<ChatInput />);

    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, '/fix');
    fireEvent.click(screen.getByTestId('send-submit'));

    expect(wsMock.sendMessage).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(wsMock.sendMessage).mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('Diagnose and fix this error');
    expect(prompt).toContain('@src/large.ts');
    expect(prompt).toContain('read each complete project file');
    expect(prompt).toContain('until EOF');
    expect(useFileReferenceStore.getState().refs).toEqual([]);
  });

  it('btw while running dispatches immediately via mailbox and marks the chip dispatched', () => {
    useChatStore.setState({
      isLoading: true,
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    });
    render(<ChatInput />);

    const textarea = screen.getByPlaceholderText(/Type a btw/) as HTMLTextAreaElement;
    typeInto(textarea, 'btw consider edge case');
    fireEvent.click(screen.getByTestId('send-btw'));

    // No interrupt, no new run — the note rides alongside the running agent.
    expect(wsMock.sendAbort).not.toHaveBeenCalled();
    expect(wsMock.sendMessage).not.toHaveBeenCalled();
    // Immediate mid-run mailbox dispatch (folds into the next iteration).
    expect(wsMock.sendMailboxMessage).toHaveBeenCalledTimes(1);
    expect(wsMock.sendMailboxMessage).toHaveBeenCalledWith({
      type: 'btw',
      to: 'leader',
      subject: 'btw from WebUI',
      body: 'btw consider edge case',
      priority: 'normal',
      audience: 'all',
    });
    // The chip stays in the queue for visibility, marked alreadyDispatched so
    // the run.result drain skips re-sending it (no double injection).
    // Use `objectContaining` so the assertion doesn't break when the store
    // adds an internal `itemId` field (monotonic timer key for the
    // dispatched-grace timer). The public surface the panel asserts on
    // is `text`, `mode`, `addedAt`, and `alreadyDispatched`.
    expect(useChatStore.getState().queue).toEqual([
      expect.objectContaining({
        text: 'btw consider edge case',
        mode: 'btw',
        addedAt: expect.any(Number),
        alreadyDispatched: true,
      }),
    ]);
  });

  it('steer while running aborts first, then sends', () => {
    useChatStore.setState({
      isLoading: true,
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    });
    render(<ChatInput />);

    const textarea = screen.getByPlaceholderText(/Type a btw/) as HTMLTextAreaElement;
    typeInto(textarea, 'redirect please');
    fireEvent.click(screen.getByTestId('send-steer'));

    expect(wsMock.sendAbort).toHaveBeenCalledTimes(1);
    expect(wsMock.sendMessage).toHaveBeenCalledTimes(1);
    expect(wsMock.sendMessage).toHaveBeenCalledWith('redirect please', undefined);
    expect(useChatStore.getState().queue).toEqual([]);
  });

  it('addQueue while running enqueues with mode "queue"', () => {
    useChatStore.setState({
      isLoading: true,
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    });
    render(<ChatInput />);

    const textarea = screen.getByPlaceholderText(/Type a btw/) as HTMLTextAreaElement;
    typeInto(textarea, 'hold this');
    fireEvent.click(screen.getByTestId('send-queue'));

    expect(wsMock.sendAbort).not.toHaveBeenCalled();
    expect(wsMock.sendMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().queue).toEqual([
      expect.objectContaining({
        text: 'hold this',
        mode: 'queue',
        addedAt: expect.any(Number),
      }),
    ]);
  });

  it('Stop button still aborts the in-flight run', () => {
    useChatStore.setState({
      isLoading: true,
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    });
    render(<ChatInput />);

    fireEvent.click(screen.getByTestId('stop'));

    expect(wsMock.sendAbort).toHaveBeenCalledTimes(1);
  });

  it('Stop and Stop-and-Edit buttons are rendered when isLoading is true even before any messages exist', () => {
    useChatStore.setState({
      isLoading: true,
      messages: [],
    });
    render(<ChatInput />);

    expect(screen.getByTestId('stop')).toBeDefined();
    expect(screen.getByTestId('stop-and-edit')).toBeDefined();

    fireEvent.click(screen.getByTestId('stop'));
    expect(wsMock.sendAbort).toHaveBeenCalledTimes(1);
  });

  it('Btw, Steer and Queue buttons are rendered when isLoading is true even before any messages exist', () => {
    useChatStore.setState({
      isLoading: true,
      messages: [],
    });
    render(<ChatInput />);

    expect(screen.getByTestId('send-btw')).toBeDefined();
    expect(screen.getByTestId('send-steer')).toBeDefined();
    expect(screen.getByTestId('send-queue')).toBeDefined();
  });

  it('Enter (form submit) defaults to btw mode once the chat has started', () => {
    useChatStore.setState({
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    });
    render(<ChatInput />);

    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, 'enter key test');
    fireEvent.submit(textarea.closest('form')!);

    expect(wsMock.sendAbort).not.toHaveBeenCalled();
    expect(wsMock.sendMessage).toHaveBeenCalledTimes(1);
    expect(wsMock.sendMessage).toHaveBeenCalledWith('enter key test', undefined);
  });

  it('Enter (form submit) sends the first message via the submit button before the chat has started', () => {
    render(<ChatInput />);

    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, 'first message');
    fireEvent.submit(textarea.closest('form')!);

    expect(wsMock.sendAbort).not.toHaveBeenCalled();
    expect(wsMock.sendMessage).toHaveBeenCalledTimes(1);
    expect(wsMock.sendMessage).toHaveBeenCalledWith('first message', undefined);
  });
});
