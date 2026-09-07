// Polyfill requestAnimationFrame for jsdom — flush immediately so the
// post-submit focus/height side-effects in ChatInput don't queue against
// the next render (same harness shape as chat-input-send-modes).
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on the session-draft clear WITHOUT replacing the rest of the module —
// `useSessionDraft` must stay real. The single-call assertions below are the
// no-double-clear regression guard for the resetComposerState extraction in
// use-chat-submit.ts: a double call would mean the reset path re-implemented
// what clearTextarea already owns.
const { clearSessionDraftMock } = vi.hoisted(() => ({ clearSessionDraftMock: vi.fn() }));
vi.mock('../../src/components/ChatInput/session-draft.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/components/ChatInput/session-draft.js')>();
  return { ...actual, clearSessionDraft: clearSessionDraftMock };
});

const wsMock = {
  sendMessage: vi.fn(() => 'msg_id'),
  sendAbort: vi.fn(),
  refineModel: vi.fn(),
  sendMailboxMessage: vi.fn(),
  updatePrefs: vi.fn(),
  adviseTopic: vi.fn(async () => ({
    suggestNewContext: false,
    confidence: 1,
    reason: 'same topic',
    source: 'local' as const,
  })),
  client: {
    isConnected: true,
    supportsCapability: vi.fn(() => true),
    send: vi.fn(),
    onStatus: () => () => {},
  },
};
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => wsMock }));
vi.mock('@/components/ConfirmModal', () => ({
  confirmModalChoice: vi.fn(),
  useConfirmModalStore: { getState: () => ({ settle: vi.fn() }) },
}));
vi.mock('@/hooks/useProviderModels', () => ({ useProviderModels: () => [] }));
vi.mock('@/components/RefinePanel', () => ({ RefinePanel: () => null }));
vi.mock('@/components/ChatInput/file-mention-picker', () => ({
  FileMentionPicker: () => null,
  detectAtMention: () => null,
}));

import { ChatInput } from '../../src/components/ChatInput.js';
import { useChatStore } from '../../src/stores/chat-store.js';
import { useFileReferenceStore } from '../../src/stores/file-reference-store.js';
import { useLocalPrefs } from '../../src/stores/local-prefs.js';
import { useUIStore } from '../../src/stores/ui-store.js';

beforeEach(() => {
  clearSessionDraftMock.mockClear();
  wsMock.sendMessage.mockClear();
  useChatStore.setState({ messages: [], queue: [], isLoading: false });
  useFileReferenceStore.setState({ refs: [] });
  useLocalPrefs.setState({ enhanceEnabled: false });
  useUIStore.setState({ refinePanel: null });
});

afterEach(() => {
  flushRaf();
});

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
}

describe('ChatInput — submit composer clear (resetComposerState)', () => {
  it('clears the composer exactly once on send: session draft, input, height', () => {
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, 'hello there');
    fireEvent.submit(textarea.closest('form')!);

    // Exactly ONE session-draft clear per submit — a double call would mean
    // the reset path re-implemented what clearTextarea already owns.
    expect(clearSessionDraftMock).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('');
    // The height reset lives in clearTextarea; jsdom scrollHeight is 0, so
    // the reset contract lands at min(scrollHeight, 200) === '0px'.
    expect(textarea.style.height).toBe('0px');
    expect(wsMock.sendMessage).toHaveBeenCalledWith('hello there', undefined);
  });

  it('routes the /clear slash branch through the same single reset', () => {
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, '/clear');
    fireEvent.submit(textarea.closest('form')!);

    expect(clearSessionDraftMock).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('');
    // The slash branch never dispatches the prompt to the model.
    expect(wsMock.sendMessage).not.toHaveBeenCalled();
  });
});
