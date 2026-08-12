// Regression: pressing Enter while the @-mention file picker is open must
// not also submit the prompt. Previously, ChatInput's handleKeyDown had an
// Enter-to-submit fallthrough with no gate for `atMention`, so Enter both
// selected the highlighted file (via FilePicker's window listener) AND
// submitted the prompt (via the textarea's bubble-phase handler). The fix
// in ChatInput.handleKeyDown now yields only when the picker's window
// listener has actually consumed the key (e.defaultPrevented === true),
// preserving both the picker-has-results UX and the picker-zero-results
// fallthrough.

// requestAnimationFrame polyfill for jsdom — flush immediately so the
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

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── WS hook mock ──────────────────────────────────────────────────────
// We only care that handleSubmit is or isn't invoked. `sendMessage` is
// the cheapest visible side-effect: it's called from handleSubmit on a
// plain send (and not at all when the picker swallows the Enter key).
const wsMock = {
  sendMessage: vi.fn((_content: string, _imageBase64?: string) => 'msg_id'),
  sendAbort: vi.fn(),
  refineModel: vi.fn(),
  sendMailboxMessage: vi.fn(),
  updatePrefs: vi.fn(),
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
    // FilePicker (and therefore FileMentionPicker) calls
    // ws.client.listFiles() to fetch file matches. We pre-stub the WS
    // client with a listFiles method so FilePicker's useEffect doesn't
    // throw on mount.
    listFiles: vi.fn(() => {
      // No-op — tests that need results install a separate mock.
    }),
  },
};
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => wsMock,
}));
vi.mock('@/components/ConfirmModal', () => ({ confirmModalChoice: vi.fn() }));
vi.mock('@/hooks/useProviderModels', () => ({ useProviderModels: () => [] }));
vi.mock('@/components/RefinePanel', () => ({ RefinePanel: () => null }));

// Force `detectAtMention` to return a non-null state whenever the user
// types `@`. This simulates the picker being open without needing to
// drive the real detection logic.
let atMentionDetection: ReturnType<
  typeof import('../../src/components/ChatInput/slash-commands.js').detectAtMention
>;
vi.mock('@/components/ChatInput/slash-commands', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/components/ChatInput/slash-commands.js')
  >('../../src/components/ChatInput/slash-commands.js');
  return {
    ...actual,
    detectAtMention: (value: string, cursor: number) => {
      const idx = value.lastIndexOf('@', cursor - 1);
      if (idx < 0) {
        atMentionDetection = null;
        return null;
      }
      const result = { start: idx, query: value.slice(idx + 1, cursor) };
      atMentionDetection = result;
      return result;
    },
  };
});

import { useEffect } from 'react';
import { ChatInput } from '../../src/components/ChatInput.js';
import { useChatStore } from '../../src/stores/chat-store.js';
import { useFileReferenceStore } from '../../src/stores/file-reference-store.js';
import { useLocalPrefs } from '../../src/stores/local-prefs.js';
import { useUIStore } from '../../src/stores/ui-store.js';

// ── FilePicker mock with opt-in key consumption ──────────────────────
// We mock FilePicker so the test can drive both halves of the production
// flow exactly:
//   - When the picker has results, its window-level capture-phase listener
//     calls preventDefault() AND onPick(path). This is what happens in
//     packages/webui/src/components/FilePicker.tsx (lines 62-81).
//   - When the picker has no results, the listener returns without calling
//     preventDefault() — also a direct port of production.
//
// `mockFilePicker.shouldConsume` is a test-side flag toggled by the
// individual test cases. Because we use a real window keydown listener
// (capture phase), the preventDefault() call propagates `defaultPrevented
// === true` into the textarea's React onKeyDown handler — the exact
// contract ChatInput.handleKeyDown relies on after the fix.
const mockFilePicker = {
  shouldConsume: false,
};
vi.mock('@/components/FilePicker', () => ({
  FilePicker: ({
    onPick,
    onClose,
  }: {
    query: string;
    onPick: (path: string) => void;
    onClose: () => void;
  }) => {
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (
          e.key === 'Enter' ||
          e.key === 'Tab' ||
          e.key === 'Escape' ||
          e.key === 'ArrowDown' ||
          e.key === 'ArrowUp'
        ) {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
            return;
          }
          if (mockFilePicker.shouldConsume) {
            e.preventDefault();
            if (e.key === 'Enter' || e.key === 'Tab') {
              onPick('src/index.ts');
            }
          }
        }
      };
      window.addEventListener('keydown', onKey, true);
      return () => window.removeEventListener('keydown', onKey, true);
    }, [onPick, onClose]);
    return <div data-testid="mock-file-picker" />;
  },
}));

beforeEach(() => {
  wsMock.sendMessage.mockClear();
  wsMock.sendAbort.mockClear();
  wsMock.refineModel.mockClear();
  wsMock.sendMailboxMessage.mockClear();
  wsMock.updatePrefs.mockClear();
  wsMock.adviseTopic.mockClear();
  wsMock.client.supportsCapability.mockClear();
  wsMock.client.listFiles.mockClear();
  mockFilePicker.shouldConsume = false;
  atMentionDetection = null;
  useChatStore.setState({ messages: [], queue: [], isLoading: false });
  useFileReferenceStore.setState({ refs: [] });
  // Disable the enhance refinement branch so a successful submit would
  // unambiguously route to sendMessage.
  useLocalPrefs.setState({ enhanceEnabled: false });
  useUIStore.setState({ refinePanel: null });
});

afterEach(() => {
  flushRaf();
});

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
}

describe('ChatInput — @-mention Enter does not submit', () => {
  it('pressing Enter while the @-mention picker is open AND the picker consumed the key does NOT submit', () => {
    // Production scenario: user types `@something`, the picker shows
    // matches, the user presses Enter, FilePicker's window listener
    // calls preventDefault() and onPick(...). With the bug, the
    // textarea's bubble-phase handler ALSO ran handleSubmit, double-
    // acting. With the fix, defaultPrevented === true yields the
    // textarea handler.
    mockFilePicker.shouldConsume = true;
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;

    typeInto(textarea, 'look at @index');
    expect(atMentionDetection).not.toBeNull();

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(wsMock.sendMessage).not.toHaveBeenCalled();
  });

  it('pressing Enter with NO active @-mention still submits', () => {
    // Negative control — confirm the gated yield didn't accidentally
    // disable Enter-to-submit in the common case.
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;

    typeInto(textarea, 'plain message no at-sign');
    expect(atMentionDetection).toBeNull();

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(wsMock.sendMessage).toHaveBeenCalledTimes(1);
    expect(wsMock.sendMessage).toHaveBeenCalledWith('plain message no at-sign', undefined);
  });

  it('pressing Enter while the @-mention picker is open but HAS NOT consumed the key still submits', () => {
    // Regression for the chimera review: when atMention is active but the
    // picker has zero results, FilePicker's window listener bails WITHOUT
    // calling preventDefault() — so the textarea's Enter-to-submit must
    // still fire. The fix only yields when the picker has consumed the
    // key, which preserves the prior zero-results behavior.
    mockFilePicker.shouldConsume = false;
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;

    typeInto(textarea, 'look at @index');
    expect(atMentionDetection).not.toBeNull();

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(wsMock.sendMessage).toHaveBeenCalledTimes(1);
    expect(wsMock.sendMessage).toHaveBeenCalledWith('look at @index', undefined);
  });
});
