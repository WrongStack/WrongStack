// Regression test for the Chimera-flagged "mid-run btw with image
// attachments silently drops the images" bug.
//
// A btw note rides alongside the running agent via the mailbox system, but
// `WSMailboxSendOptions` carries only a string `body` — no image channel —
// and the run.result drain's btw branch is text-only too. So a btw note with
// images can never deliver them: dispatching immediately (chip marked
// alreadyDispatched) makes the drain skip it forever, and draining it later
// sends text-only. The fix degrades btw→queue when images are present so the
// drain forwards the images via toWireImages. This test pins that behavior.

const mocks = vi.hoisted(() => {
  const testImage = {
    id: 'img1',
    dataUrl: 'data:image/png;base64,AAAA',
    mediaType: 'image/png',
    bytes: 123,
    name: 'test.png',
  };
  const pendingImagesRef: { current: (typeof testImage)[] } = { current: [testImage] };
  const clearPendingImages = () => {
    pendingImagesRef.current = [];
  };
  return { testImage, pendingImagesRef, clearPendingImages };
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

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wsMock = {
  sendMessage: vi.fn((_content: string, _imageBase64?: string) => 'msg_id'),
  sendAbort: vi.fn(),
  refineModel: vi.fn(),
  sendMailboxMessage: vi.fn(),
  updatePrefs: vi.fn(),
  client: {
    isConnected: true,
    send: vi.fn(),
    onStatus: () => () => {},
  },
};
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => wsMock }));
vi.mock('@/hooks/useProviderModels', () => ({ useProviderModels: () => [] }));
vi.mock('@/components/RefinePanel', () => ({ RefinePanel: () => null }));
vi.mock('@/components/ChatInput/file-mention-picker', () => ({
  FileMentionPicker: () => null,
  detectAtMention: () => null,
}));
// Inject a single pending image so the submit path exercises the
// btw-with-attachments branch without driving the real paste/drop pipeline.
vi.mock('@/components/ChatInput/use-paste-drop', () => ({
  usePasteDrop: () => ({
    draggingOver: false,
    onDragEnter: () => {},
    onDragLeave: () => {},
    onDragOver: () => {},
    onDrop: () => {},
    onTextPaste: () => {},
    pasteHint: null,
    pendingImagesRef: mocks.pendingImagesRef,
    pendingImages: mocks.pendingImagesRef.current,
    addImageFiles: vi.fn(),
    removeImage: vi.fn(),
    clearPendingImages: mocks.clearPendingImages,
    setPasteHint: () => {},
  }),
}));

import { ChatInput } from '../../src/components/ChatInput.js';
import { useChatStore } from '../../src/stores/chat-store.js';
import { useLocalPrefs } from '../../src/stores/local-prefs.js';
import { useUIStore } from '../../src/stores/ui-store.js';

beforeEach(() => {
  wsMock.sendMessage.mockClear();
  wsMock.sendAbort.mockClear();
  wsMock.sendMailboxMessage.mockClear();
  // Restore the injected image — clearPendingImages emptied it in the prior test.
  mocks.pendingImagesRef.current = [mocks.testImage];
  useChatStore.setState({ messages: [], queue: [], isLoading: false });
  useLocalPrefs.setState({ enhanceEnabled: false });
  useUIStore.setState({ refinePanel: null });
});

afterEach(() => {
  flushRaf();
});

describe('ChatInput — btw with image attachments mid-run', () => {
  it('degrades btw→queue so the drain delivers the images instead of dropping them', () => {
    useChatStore.setState({
      isLoading: true,
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    });
    render(<ChatInput />);

    const textarea = screen.getByPlaceholderText(/Type a btw/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'btw with a screenshot' } });
    fireEvent.click(screen.getByTestId('send-btw'));

    // The mailbox path carries no image channel — it must NOT be used when
    // images are attached, or the images would be silently dropped.
    expect(wsMock.sendMailboxMessage).not.toHaveBeenCalled();
    expect(wsMock.sendMessage).not.toHaveBeenCalled();
    // Instead the note is enqueued as 'queue' WITH its images and WITHOUT the
    // alreadyDispatched mark, so the run.result drain forwards the images via
    // toWireImages on the next run. Use `objectContaining` so the assertion
    // doesn't break when the store adds an internal `itemId` field
    // (monotonic timer key for the dispatched-grace timer). The public
    // surface the panel asserts on is `text`, `mode`, `addedAt`, and
    // `images`.
    expect(useChatStore.getState().queue).toEqual([
      expect.objectContaining({
        text: 'btw with a screenshot',
        mode: 'queue',
        addedAt: expect.any(Number),
        images: [mocks.testImage],
      }),
    ]);
  });
});
