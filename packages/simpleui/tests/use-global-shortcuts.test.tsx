// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGlobalShortcuts } from '../src/hooks/use-global-shortcuts.js';
import type { RefineState } from '../src/lib/refine-model.js';
import type { SimpleSocket } from '../src/lib/ws.js';
import type { ChatMessage, FileEditMeta } from '../src/types.js';

/**
 * Behavior coverage for the `useGlobalShortcuts` hook (plan B1 final slice,
 * extracted from simple-ui-session.tsx). Dispatches real `keydown` events on
 * `document` and asserts the panel-priority / wire-op / recall contracts.
 *
 * Harness mirrors the sibling hook tests: jsdom + real `createRoot` + `act`,
 * no testing-library dependency.
 */

interface Harness {
  root: Root;
  socketRef: React.RefObject<SimpleSocket | null>;
  sessionIdRef: React.MutableRefObject<string | null>;
  diffFilesRef: React.MutableRefObject<FileEditMeta[] | null>;
  setDiffFiles: ReturnType<typeof vi.fn>;
  settingsOpenRef: React.MutableRefObject<boolean>;
  setSettingsOpen: ReturnType<typeof vi.fn>;
  mailboxOpenRef: React.MutableRefObject<boolean>;
  setMailboxOpen: ReturnType<typeof vi.fn>;
  refineStateRef: React.MutableRefObject<RefineState | null>;
  setRefineState: ReturnType<typeof vi.fn>;
  refineEpochRef: React.MutableRefObject<number>;
  refineStartFiredRef: React.MutableRefObject<boolean>;
  draftRef: React.MutableRefObject<string>;
  setDraft: ReturnType<typeof vi.fn>;
  setAttachedImages: ReturnType<typeof vi.fn>;
  textareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  setCommandPaletteOpen: ReturnType<typeof vi.fn>;
  runningRef: React.MutableRefObject<boolean>;
  startSend: ReturnType<typeof vi.fn>;
  messagesRef: React.MutableRefObject<ChatMessage[]>;
}

function renderHarness(): Harness {
  const socketSend = vi.fn();
  const socketRef = {
    current: { send: socketSend },
  } as unknown as React.RefObject<SimpleSocket | null>;
  const sessionIdRef = { current: null } as React.MutableRefObject<string | null>;
  const diffFilesRef = { current: null } as React.MutableRefObject<FileEditMeta[] | null>;
  const setDiffFiles = vi.fn();
  const settingsOpenRef = { current: false } as React.MutableRefObject<boolean>;
  const setSettingsOpen = vi.fn();
  const mailboxOpenRef = { current: false } as React.MutableRefObject<boolean>;
  const setMailboxOpen = vi.fn();
  const refineStateRef = { current: null } as React.MutableRefObject<RefineState | null>;
  const setRefineState = vi.fn();
  const refineEpochRef = { current: 0 } as React.MutableRefObject<number>;
  const refineStartFiredRef = { current: false } as React.MutableRefObject<boolean>;
  const draftRef = { current: '' } as React.MutableRefObject<string>;
  const setDraft = vi.fn();
  const setAttachedImages = vi.fn();
  const textarea = document.createElement('textarea');
  document.body.append(textarea);
  const textareaRef = { current: textarea } as React.MutableRefObject<HTMLTextAreaElement | null>;
  const setCommandPaletteOpen = vi.fn();
  const runningRef = { current: false } as React.MutableRefObject<boolean>;
  const startSend = vi.fn();
  const messagesRef = { current: [] } as React.MutableRefObject<ChatMessage[]>;

  const harness: Harness = {
    root: null as unknown as Root,
    socketRef,
    sessionIdRef,
    diffFilesRef,
    setDiffFiles,
    settingsOpenRef,
    setSettingsOpen,
    mailboxOpenRef,
    setMailboxOpen,
    refineStateRef,
    setRefineState,
    refineEpochRef,
    refineStartFiredRef,
    draftRef,
    setDraft,
    setAttachedImages,
    textareaRef,
    setCommandPaletteOpen,
    runningRef,
    startSend,
    messagesRef,
  };

  function Probe(): null {
    useGlobalShortcuts({
      socketRef,
      sessionIdRef,
      diffFilesRef,
      setDiffFiles,
      settingsOpenRef,
      setSettingsOpen,
      mailboxOpenRef,
      setMailboxOpen,
      refineStateRef,
      setRefineState,
      refineEpochRef,
      refineStartFiredRef,
      draftRef,
      setDraft,
      setAttachedImages,
      textareaRef,
      setCommandPaletteOpen,
      runningRef,
      startSend,
      messagesRef,
    });
    return null;
  }

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
  harness.root = root;
  return harness;
}

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function pressKey(key: string, init: KeyboardEventInit = {}): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

describe('useGlobalShortcuts — Escape panel priority', () => {
  it('closes the settings panel when it is open', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.settingsOpenRef.current = true;
    act(() => {
      pressKey('Escape');
    });
    expect(h.setSettingsOpen).toHaveBeenCalledWith(false);
  });

  it('closes diff files before settings (topmost panel priority)', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.diffFilesRef.current = [{ path: 'a.ts', replacements: 1 }];
    h.settingsOpenRef.current = true;
    act(() => {
      pressKey('Escape');
    });
    expect(h.setDiffFiles).toHaveBeenCalledWith(null);
    expect(h.setSettingsOpen).not.toHaveBeenCalled();
  });

  it('closes the mailbox when only it is open', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.mailboxOpenRef.current = true;
    act(() => {
      pressKey('Escape');
    });
    expect(h.setMailboxOpen).toHaveBeenCalledWith(false);
  });

  it('restores the original draft + images and bumps the epoch for an active refine', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.refineStateRef.current = {
      original: 'original text',
      refined: 'refined',
      english: 'english',
      status: 'ready',
      images: [{ data: 'd', mime: 'image/png' }],
    };
    act(() => {
      pressKey('Escape');
    });
    expect(h.setRefineState).toHaveBeenCalledWith(null);
    expect(h.refineEpochRef.current).toBe(1);
    expect(h.refineStartFiredRef.current).toBe(false);
    expect(h.setDraft).toHaveBeenCalledWith('original text');
    expect(h.draftRef.current).toBe('original text');
    expect(h.setAttachedImages).toHaveBeenCalledWith([
      { id: expect.stringMatching(/^restored-/), name: 'restored-0', data: 'd', mime: 'image/png' },
    ]);
  });

  it('leaves an in-progress draft untouched when Escape closes refine', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.refineStateRef.current = {
      original: 'original text',
      refined: 'refined',
      english: 'english',
      status: 'ready',
    };
    h.draftRef.current = 'typed by user';
    act(() => {
      pressKey('Escape');
    });
    expect(h.setRefineState).toHaveBeenCalledWith(null);
    expect(h.setDraft).not.toHaveBeenCalled();
  });
});

describe('useGlobalShortcuts — palette / send / recall / new session', () => {
  it('Ctrl+K and Cmd+K open the command palette', () => {
    const h = renderHarness();
    roots.push(h.root);
    act(() => {
      pressKey('k', { ctrlKey: true });
    });
    expect(h.setCommandPaletteOpen).toHaveBeenCalledWith(true);
    h.setCommandPaletteOpen.mockClear();
    act(() => {
      pressKey('K', { metaKey: true });
    });
    expect(h.setCommandPaletteOpen).toHaveBeenCalledWith(true);
  });

  it('Ctrl+Enter sends the composer draft when non-empty and idle', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.draftRef.current = 'hello';
    act(() => {
      pressKey('Enter', { ctrlKey: true });
    });
    expect(h.startSend).toHaveBeenCalledWith('hello');
  });

  it('Ctrl+Enter is a no-op when the draft is empty or a send is running', () => {
    const h = renderHarness();
    roots.push(h.root);
    act(() => {
      pressKey('Enter', { ctrlKey: true });
    });
    expect(h.startSend).not.toHaveBeenCalled();
    h.draftRef.current = 'hello';
    h.runningRef.current = true;
    act(() => {
      pressKey('Enter', { ctrlKey: true });
    });
    expect(h.startSend).not.toHaveBeenCalled();
  });

  it('ArrowUp recalls the last user message into an empty focused composer', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.messagesRef.current = [
      { id: 'm1', role: 'user', text: 'last user msg' },
      { id: 'm2', role: 'assistant', text: 'reply' },
    ];
    h.textareaRef.current?.focus();
    act(() => {
      pressKey('ArrowUp');
    });
    expect(h.setDraft).toHaveBeenCalledWith('last user msg');
  });

  it('ArrowUp does not recall when the composer already has text', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.messagesRef.current = [{ id: 'm1', role: 'user', text: 'last' }];
    h.draftRef.current = 'in progress';
    h.textareaRef.current?.focus();
    act(() => {
      pressKey('ArrowUp');
    });
    expect(h.setDraft).not.toHaveBeenCalled();
  });

  it('Ctrl+L starts a new session with the active session id', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.sessionIdRef.current = 's-1';
    act(() => {
      pressKey('l', { ctrlKey: true });
    });
    expect(h.socketRef.current?.send).toHaveBeenCalledWith('session.new', { sessionId: 's-1' });
  });

  it('Ctrl+L is a no-op without an active session id', () => {
    const h = renderHarness();
    roots.push(h.root);
    act(() => {
      pressKey('l', { ctrlKey: true });
    });
    expect(h.socketRef.current?.send).not.toHaveBeenCalled();
  });
});

describe('useGlobalShortcuts — listener lifecycle', () => {
  it('removes its listeners on unmount', () => {
    const h = renderHarness();
    act(() => {
      h.root.unmount();
    });
    h.settingsOpenRef.current = true;
    act(() => {
      pressKey('Escape');
    });
    expect(h.setSettingsOpen).not.toHaveBeenCalled();
  });
});
