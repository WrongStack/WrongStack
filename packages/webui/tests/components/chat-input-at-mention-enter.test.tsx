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

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── WS hook mock ──────────────────────────────────────────────────────
// We only care that handleSubmit is or isn't invoked. `sendMessage` is
// the cheapest visible side-effect: it's called from handleSubmit on a
// plain send (and not at all when the picker swallows the Enter key).
const skillListeners = new Set<(message: unknown) => void>();
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
    on: vi.fn((_type: string, callback: (message: unknown) => void) => {
      if (_type === 'skills.list') skillListeners.add(callback);
      return () => {
        skillListeners.delete(callback);
      };
    }),
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
  skillListeners.clear();
  wsMock.client.send.mockClear();
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

  it('pressing Enter that another surface already consumed does NOT submit even after the picker has closed', () => {
    // Real-browser race pinned 2026-09-26 (Playwright check against the
    // real ChatInput): FilePicker's window-capture listener runs
    // preventDefault() + pick(); React 18 flushes that pick's
    // setAtMention(null) between the capture listener and the textarea's
    // bubble-phase handler, so handleKeyDown runs with atMention ALREADY
    // null — but the native event still carries defaultPrevented === true.
    // A key another surface consumed must never submit, in any closure
    // state. Simulated here in two steps: first a consuming pick (clears
    // atMention), then a second consumed Enter with the picker closed.
    mockFilePicker.shouldConsume = true;
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;

    typeInto(textarea, 'look at @index');
    expect(atMentionDetection).not.toBeNull();

    // Step 1: the picker consumes Enter and picks — selection happens,
    // no submit, and the pick clears the @-mention state.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(wsMock.sendMessage).not.toHaveBeenCalled();

    // Step 2: the raced same-event state — atMention already null, but
    // the keydown was consumed by a window-capture listener.
    const consume = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener('keydown', consume, true);
    try {
      fireEvent.keyDown(textarea, { key: 'Enter' });
    } finally {
      window.removeEventListener('keydown', consume, true);
    }

    expect(wsMock.sendMessage).not.toHaveBeenCalled();
    // Leave the shared draft store clean for the next test case.
    useUIStore.setState({ draftInput: '' });
  });

  it('pressing Enter while the @-mention picker is open but HAS NOT consumed the key does NOT submit', () => {
    // Contract update (2026-09-26, explicit user requirement): while the
    // @-mention picker is open, Enter belongs to the picker — it only
    // confirms the mention selection. When the picker has zero results or
    // matches are still loading, FilePicker's window listener bails
    // WITHOUT calling preventDefault(); ChatInput.handleKeyDown must then
    // swallow the key itself. The previous contract let it fall through
    // to Enter-to-submit, which sent the half-typed `@query` draft.
    mockFilePicker.shouldConsume = false;
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;

    typeInto(textarea, 'look at @index');
    expect(atMentionDetection).not.toBeNull();

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(wsMock.sendMessage).not.toHaveBeenCalled();
    // The draft is neither submitted nor polluted with a newline: Enter
    // is a pure no-op until a selection exists.
    expect(textarea.value).toBe('look at @index');
  });
});

describe('ChatInput skill mentions', () => {
  it('inserts a selected skill with Enter without submitting the draft', () => {
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, 'Review $tes');
    const requestId = wsMock.client.send.mock.calls.find(
      (call) => call[0]?.type === 'skills.list',
    )?.[1]?.requestId;
    expect(requestId).toBeTruthy();
    act(() => {
      for (const handler of skillListeners)
        handler({
          type: 'skills.list',
          payload: { requestId, skills: [{ name: 'testing', description: 'Test software' }] },
        });
    });
    expect(screen.getByRole('option', { name: /testing/ })).toBeTruthy();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('Review $testing ');
    expect(wsMock.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox', { name: 'Skills' })).toBeNull();
  });
  it('dismisses the menu with Escape while preserving the typed mention', () => {
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, '$missing');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(wsMock.sendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(textarea.value).toBe('$missing');
    expect(screen.queryByRole('listbox', { name: 'Skills' })).toBeNull();
  });
});

it('restores the insertion caret synchronously in the middle of a draft', () => {
  render(<ChatInput />);
  const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
  typeInto(textarea, 'Use $tes for this');
  textarea.setSelectionRange(8, 8);
  fireEvent.select(textarea);
  const requestId = wsMock.client.send.mock.calls.find(
    (call) => call[0]?.type === 'skills.list',
  )?.[1]?.requestId;
  act(() => {
    for (const handler of skillListeners)
      handler({
        type: 'skills.list',
        payload: { requestId, skills: [{ name: 'testing', description: 'Test software' }] },
      });
  });
  fireEvent.keyDown(textarea, { key: 'Tab' });
  expect(textarea.value).toBe('Use $testing for this');
  expect(textarea.selectionStart).toBe(13);
  expect(wsMock.sendMessage).not.toHaveBeenCalled();
});

// Regression: the composer textarea had NO aria-label, so its accessible name
// came from `placeholder` alone. A placeholder is not a label — it disappears
// the moment the operator types, leaving the field unnamed for a screen
// reader mid-sentence. The name must be a real attribute wired to the
// composerLabel key.
describe('ChatInput composer accessible name', () => {
  it('names the textarea via activity:chatInput.composerLabel', async () => {
    const en = (await import('../../src/i18n/locales/en/activity.json')).default;
    render(<ChatInput />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    // Assert against the real catalog value, not a hardcoded string, so a
    // reworded label does not need a test edit and a wrong-key wiring still
    // fails (the attribute would be a different string).
    expect(textarea.getAttribute('aria-label')).toBeTruthy();
    expect(textarea.getAttribute('aria-label')).toBe(en.chatInput.composerLabel);
    expect(String(en.chatInput.composerLabel).trim().length).toBeGreaterThan(0);

    // The name must survive content: a placeholder-derived name would be the
    // thing that disappears here.
    typeInto(textarea, 'a draft in progress');
    expect(textarea.getAttribute('aria-label')).toBe(en.chatInput.composerLabel);
    expect(textarea.value).toBe('a draft in progress');
  });
});

describe('ChatInput — # mentions of pull requests and issues', () => {
  const list = (status: string) => ({
    status,
    projectRoot: '/p',
    repository: status === 'ok' ? 'octo/repo' : null,
    tokenSource: 'gh',
    pulls: [
      {
        number: 128,
        title: 'Add GitHub view',
        url: 'https://github.com/octo/repo/pull/128',
        author: 'octocat',
        labels: [],
        comments: 0,
        createdAt: '',
        updatedAt: '',
        draft: false,
        headRef: 'feat',
        baseRef: 'main',
      },
    ],
    issues: [],
    truncated: { pulls: false, issues: false },
    fetchedAt: '',
  });
  const merged = {
    status: 'ok',
    repository: 'octo/repo',
    tokenSource: 'gh',
    item: {
      kind: 'pull',
      number: 453,
      title: 'Ship the release gate',
      url: 'https://github.com/octo/repo/pull/453',
      author: 'releaser',
      labels: [],
      comments: 0,
      createdAt: '',
      updatedAt: '',
      state: 'closed',
      body: '',
      pull: { draft: false, merged: true },
    },
  };
  const stubList = (status: string) => {
    const fetcher = vi.fn(async (url: string) => {
      const item = url.startsWith('/api/github/item')
        ? url.includes('number=453') && url.includes('kind=pull')
          ? merged
          : { status: 'not-found', repository: 'octo/repo', tokenSource: 'gh', item: null }
        : list(status);
      return new Response(JSON.stringify(item), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  };
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });

  afterEach(() => {
    vi.unstubAllGlobals();
    useUIStore.setState({ draftInput: '' });
  });

  it('inserts the picked pull request as its GitHub URL without sending', async () => {
    stubList('ok');
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, 'review #12');
    fireEvent.select(textarea, { target: { selectionStart: 10, selectionEnd: 10 } });
    const option = await screen.findByRole('option', { name: /#128 Add GitHub view/ });
    expect(option).toBeTruthy();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(wsMock.sendMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe('review https://github.com/octo/repo/pull/128 ');
    expect(screen.queryByRole('option', { name: /#128/ })).toBeNull();
  });

  it('stays closed and lets Enter send when nothing matches', async () => {
    stubList('ok');
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, 'step #3');
    fireEvent.select(textarea, { target: { selectionStart: 7, selectionEnd: 7 } });
    await settle();
    expect(screen.queryByRole('listbox', { name: 'Pull requests and issues' })).toBeNull();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(wsMock.sendMessage).toHaveBeenCalledWith('step #3', undefined);
  });

  it('finds a closed or merged item by its exact number', async () => {
    const fetcher = stubList('ok');
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, 'see #453');
    fireEvent.select(textarea, { target: { selectionStart: 8, selectionEnd: 8 } });
    expect(
      await screen.findByRole('option', { name: /#453 Ship the release gate/ }, { timeout: 2000 }),
    ).toBeTruthy();
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).startsWith('/api/github/item?kind=pull&number=453&parts=none'),
      ),
    ).toBe(true);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(wsMock.sendMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe('see https://github.com/octo/repo/pull/453 ');
  });

  it('stays closed and lets Enter send when the project has no GitHub repository', async () => {
    stubList('no-remote');
    render(<ChatInput />);
    const textarea = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;
    typeInto(textarea, 'step #1');
    fireEvent.select(textarea, { target: { selectionStart: 7, selectionEnd: 7 } });
    await settle();
    expect(screen.queryByRole('listbox', { name: 'Pull requests and issues' })).toBeNull();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(wsMock.sendMessage).toHaveBeenCalledWith('step #1', undefined);
  });
});
