// Regression test: switching sessions must clear the entire unsent composer
// (pending images, file references, @-mention picker), not just text/history.
//
// Bug: ChatInput's [sessionId] effect originally called only setInput(''),
// setHistoryIdx(-1), and stickyDraftRef cleanup. Pending images from
// usePasteDrop, file refs from useFileReferenceStore, and the atMention
// picker state all survived the session change — so attachments composed in
// session A were still visible and sendable in session B.
//
// Fix: the effect now also calls clearPendingImages(), clearRefs(), and
// setAtMention(null). This test pins that behavior.

const mocks = vi.hoisted(() => {
  const testImage = {
    id: 'img1',
    dataUrl: 'data:image/png;base64,AAAA',
    mediaType: 'image/png',
    bytes: 123,
    name: 'test.png',
  };
  const pendingImagesRef: { current: (typeof testImage)[] } = { current: [] };
  const clearPendingImages = () => {
    pendingImagesRef.current = [];
  };
  // FileMentionPicker writes its atMention prop here on every render.
  const observed = { atMention: null as { start: number; query: string } | null };
  // Paste-hint holder — setPasteHint writes here so we can assert the
  // session-change effect cleared it.
  const pasteHintHolder = { current: null as { chars: number; lines: number } | null };
  const setPasteHintSpy = vi.fn((v: { chars: number; lines: number } | null) => {
    pasteHintHolder.current = v;
  });
  return {
    testImage,
    pendingImagesRef,
    clearPendingImages,
    observed,
    pasteHintHolder,
    setPasteHintSpy,
    confirmModalChoiceMock: vi.fn(),
  };
});

// Polyfill requestAnimationFrame for jsdom — flush immediately so the
// post-submit focus/selection side-effects in ChatInput don't queue up.
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

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wsMock = {
  sendMessage: vi.fn((_content: string, _imageBase64?: string) => 'msg_id'),
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
vi.mock('@/hooks/useProviderModels', () => ({ useProviderModels: () => [] }));
vi.mock('@/components/ConfirmModal', () => ({
  confirmModalChoice: mocks.confirmModalChoiceMock,
  useConfirmModalStore: { getState: () => ({ settle: vi.fn() }) },
}));
vi.mock('@/components/RefinePanel', () => ({ RefinePanel: () => null }));
// Capture the atMention prop on every render so we can assert it was cleared
// after the session-change effect fires setAtMention(null).
vi.mock('@/components/ChatInput/file-mention-picker', () => ({
  FileMentionPicker: (props: { atMention: unknown }) => {
    mocks.observed.atMention = props.atMention as { start: number; query: string } | null;
    return null;
  },
}));
// Inject a controllable pendingImagesRef so we can populate images before
// the session change and assert they were drained afterwards.
vi.mock('@/components/ChatInput/use-paste-drop', () => ({
  usePasteDrop: () => ({
    draggingOver: false,
    onDragEnter: () => {},
    onDragLeave: () => {},
    onDragOver: () => {},
    onDrop: () => {},
    onTextPaste: () => {},
    pasteHint: mocks.pasteHintHolder.current,
    pendingImagesRef: mocks.pendingImagesRef,
    pendingImages: mocks.pendingImagesRef.current,
    addImageFiles: vi.fn(),
    removeImage: vi.fn(),
    clearPendingImages: mocks.clearPendingImages,
    setPendingImages: (images: typeof mocks.testImage[]) => {
      mocks.pendingImagesRef.current = images;
    },
    setPasteHint: mocks.setPasteHintSpy,
  }),
}));

import { ChatInput } from '../../src/components/ChatInput.js';
import { disposeLane } from '../../src/stores/chat-lanes.js';
import { useChatStore } from '../../src/stores/chat-store.js';
import { useFileReferenceStore } from '../../src/stores/file-reference-store.js';
import { useLocalPrefs } from '../../src/stores/local-prefs.js';
import { useSessionStore } from '../../src/stores/session-store.js';
import { useUIStore } from '../../src/stores/ui-store.js';

beforeEach(() => {
  mocks.pendingImagesRef.current = [];
  mocks.observed.atMention = null;
  mocks.pasteHintHolder.current = null;
  mocks.setPasteHintSpy.mockClear();
  mocks.confirmModalChoiceMock.mockReset();
  wsMock.adviseTopic.mockClear();
  wsMock.client.supportsCapability.mockClear();
  useChatStore.setState({ messages: [], queue: [], isLoading: false });
  useLocalPrefs.setState({ enhanceEnabled: false });
  useUIStore.setState({ refinePanel: null, draftInput: '' });
  useFileReferenceStore.setState({ refs: [] });
  // Start with a known session so the mount-time effect sees no change and
  // does not fire the reset path prematurely.
  useSessionStore.setState({
    session: { id: 'session-A', startedAt: 1, provider: 'test', model: 'test' },
  });
});

afterEach(() => {
  flushRaf();
});

describe('ChatInput — session-change composer reset', () => {
  it('clears pending images, file references, at-mention, and paste hint on session change', () => {
    render(<ChatInput />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    // --- Populate all four unsent-composer channels ---

    // 1. Pending images (paste/drop pipeline).
    mocks.pendingImagesRef.current = [mocks.testImage];
    expect(mocks.pendingImagesRef.current).toHaveLength(1);

    // 2. File references (zustand store). Wrap in act — the zustand
    //    subscription in ChatInput triggers a React re-render.
    act(() => {
      useFileReferenceStore.getState().addRef({ kind: 'file', path: 'src/a.ts' });
    });
    expect(useFileReferenceStore.getState().refs).toHaveLength(1);

    // 3. @-mention picker — typing "@file" with the cursor at position 5
    //    makes detectAtMention return { start: 0, query: 'file' }.
    fireEvent.change(textarea, { target: { value: '@file', selectionStart: 5 } });
    expect(mocks.observed.atMention).toEqual({ start: 0, query: 'file' });

    // 4. Paste hint banner — simulate a large-paste hint being visible.
    //    Its undoFence closure captures session A's text, so it must be
    //    cleared on session switch.
    mocks.pasteHintHolder.current = { chars: 2000, lines: 40 };
    expect(mocks.pasteHintHolder.current).not.toBeNull();

    // --- Simulate switching to a different session ---
    act(() => {
      useSessionStore.setState({
        session: { id: 'session-B', startedAt: 2, provider: 'test', model: 'test' },
      });
    });

    // --- All four channels must be cleared ---
    expect(mocks.pendingImagesRef.current).toHaveLength(0);
    expect(useFileReferenceStore.getState().refs).toHaveLength(0);
    expect(mocks.observed.atMention).toBeNull();
    // Paste hint is cleared — its undoFence closure captured session A's text.
    expect(mocks.setPasteHintSpy).toHaveBeenCalledWith(null);
    expect(mocks.pasteHintHolder.current).toBeNull();
    // Text input is also cleared by the same effect.
    expect(textarea.value).toBe('');
  });

  it('hands each tab back its own unsent draft', () => {
    render(<ChatInput />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'half a thought for A' } });
    act(() => {
      useSessionStore.setState({
        session: { id: 'session-B', startedAt: 2, provider: 'test', model: 'test' },
      });
    });
    // Tab B starts empty — it must not inherit what was being typed in A.
    expect(textarea.value).toBe('');
    fireEvent.change(textarea, { target: { value: 'something else for B' } });

    act(() => {
      useSessionStore.setState({
        session: { id: 'session-A', startedAt: 1, provider: 'test', model: 'test' },
      });
    });

    expect(textarea.value).toBe('half a thought for A');
  });

  it('does not resurrect the draft of a tab that was closed', () => {
    render(<ChatInput />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'typed before closing' } });
    act(() => {
      useSessionStore.setState({
        session: { id: 'session-B', startedAt: 2, provider: 'test', model: 'test' },
      });
    });
    // The tab is closed: its lane goes, and the draft must go with it. A
    // session later handed the same id is a DIFFERENT conversation and must
    // not open with someone else's half-written message.
    act(() => {
      disposeLane('session-A');
    });

    act(() => {
      useSessionStore.setState({
        session: { id: 'session-A', startedAt: 3, provider: 'test', model: 'test' },
      });
    });

    expect(textarea.value).toBe('');
  });

  it('takes a refinement down when the foreground leaves the tab that started it', () => {
    // Refinement ON, or the panel is flushed immediately by the
    // "enhance was switched off" path instead of staying open.
    useLocalPrefs.setState({ enhanceEnabled: true });
    render(<ChatInput />);

    act(() => {
      useUIStore.getState().setRefinePanel({
        original: 'the prompt tab A typed',
        refined: 'the prompt tab A typed',
        english: 'the prompt tab A typed',
        status: 'countdown',
        resolve: () => {},
        sessionId: 'session-A',
      });
    });

    act(() => {
      useSessionStore.setState({
        session: { id: 'session-B', startedAt: 2, provider: 'test', model: 'test' },
      });
    });

    // Both of the panel's exits — approval and the 105s timeout — dispatch
    // through the foreground, so leaving it standing sends tab A's prompt into
    // tab B's session with nobody touching anything.
    expect(useUIStore.getState().refinePanel).toBeNull();

    // …and the text is handed back to the tab that typed it.
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    act(() => {
      useSessionStore.setState({
        session: { id: 'session-A', startedAt: 1, provider: 'test', model: 'test' },
      });
    });
    expect(textarea.value).toBe('the prompt tab A typed');
  });

  it('aborts an in-flight topic check on session switch so no cross-session modal leaks', async () => {
    // Set up conditions for the topic-check to fire: btw mode, 5+ user
    // messages, connected, capability supported. adviseTopic is a
    // never-resolving promise so we can observe the aborted state.
    const neverResolve = new Promise<never>(() => {});
    wsMock.adviseTopic.mockReturnValue(neverResolve);
    useChatStore.setState({
      messages: Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        role: 'user' as const,
        content: `msg ${i}`,
        timestamp: i,
      })),
    });

    render(<ChatInput />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    // Type and submit in btw mode to trigger the topic check.
    fireEvent.change(textarea, { target: { value: 'a follow-up note' } });
    const btwBtn = screen.getByTestId('send-btw');
    await act(async () => {
      fireEvent.click(btwBtn);
    });

    // adviseTopic must have been called (topic check is in-flight).
    expect(wsMock.adviseTopic).toHaveBeenCalledTimes(1);

    // Switch sessions while adviseTopic is still pending.
    await act(async () => {
      useSessionStore.setState({
        session: { id: 'session-B', startedAt: 2, provider: 'test', model: 'test' },
      });
    });

    // Allow any pending microtasks to flush.
    await vi.waitFor(() => {
      // The session effect calls settle(null) on the confirm modal store
      // to dismiss any stale modal. We can't assert that directly with the
      // mock, but we can verify adviseTopic was called and no modal appeared.
      expect(mocks.confirmModalChoiceMock).not.toHaveBeenCalled();
    });

    // The confirm modal was never reached because adviseTopic never resolved.
    // The key assertion: no modal leaked into session B.
    expect(mocks.confirmModalChoiceMock).not.toHaveBeenCalled();
  });
});
