// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGlobalShortcuts } from '../src/hooks/use-global-shortcuts.js';
import type { PendingConfirm } from '../src/types.js';

/**
 * Global shortcuts: Escape closes the topmost panel (diff → settings →
 * mailbox → refine-escape restore), Y/N/A answer the pending permission
 * prompt (inert in editable targets and under modifiers), Ctrl/Cmd+K opens
 * the palette, Ctrl/Cmd+Enter DELEGATES the idle send to the composer's own
 * submitWith dispatcher (one send path — an empty draft is the dispatcher's
 * own no-op), ArrowUp recalls the last user message into an empty composer,
 * and Ctrl/Cmd+L starts a new session. Everything is read through refs at
 * dispatch time; listeners register exactly once.
 */

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function pressKey(key: string, init: KeyboardEventInit = {}): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

interface Harness {
  setDiffFiles: ReturnType<typeof vi.fn>;
  setSettingsOpen: ReturnType<typeof vi.fn>;
  setMailboxOpen: ReturnType<typeof vi.fn>;
  setRefineState: ReturnType<typeof vi.fn>;
  setDraft: ReturnType<typeof vi.fn>;
  setAttachedImages: ReturnType<typeof vi.fn>;
  setCommandPaletteOpen: ReturnType<typeof vi.fn>;
  draftRef: { current: string };
  textareaRef: { current: HTMLTextAreaElement | null };
  runningRef: { current: boolean };
  messagesRef: { current: Array<{ id: string; role: string; text: string }> };
  submitWith: ReturnType<typeof vi.fn>;
  pendingConfirmRef: { current: PendingConfirm | null };
  decideConfirm: ReturnType<typeof vi.fn>;
  refineEpochRef: { current: number };
  socketRef: { current: { send: ReturnType<typeof vi.fn> } | null };
  sessionIdRef: { current: string | null };
  diffFilesRef: { current: Array<{ path: string }> | null };
  settingsOpenRef: { current: boolean };
  mailboxOpenRef: { current: boolean };
  refineStateRef: { current: unknown };
  refineStartFiredRef: { current: boolean };
  submitWithRef: { current: (mode: string) => void };
  decideConfirmRef: { current: ((decision: 'yes' | 'no' | 'always') => void) | undefined };
  root: Root;
}

function renderHarness(): Harness {
  // ArrowUp's guard checks document.activeElement, so the harness textarea
  // must be IN the document to be focusable.
  const textarea = document.createElement('textarea');
  document.body.append(textarea);
  const h: Harness = {
    setDiffFiles: vi.fn(),
    setSettingsOpen: vi.fn(),
    setMailboxOpen: vi.fn(),
    setRefineState: vi.fn(),
    setDraft: vi.fn(),
    setAttachedImages: vi.fn(),
    setCommandPaletteOpen: vi.fn(),
    draftRef: { current: '' },
    textareaRef: { current: textarea },
    runningRef: { current: false },
    messagesRef: { current: [] },
    submitWith: vi.fn(),
    pendingConfirmRef: { current: null },
    decideConfirm: vi.fn(),
    refineEpochRef: { current: 0 },
  };

  const socketRef = { current: { send: vi.fn() } };
  const sessionIdRef = { current: 'session-1' };
  const diffFilesRef = { current: null };
  const settingsOpenRef = { current: false };
  const mailboxOpenRef = { current: false };
  const refineStateRef = { current: null };
  const refineStartFiredRef = { current: false };
  const submitWithRef = { current: h.submitWith };
  const decideConfirmRef = { current: h.decideConfirm };

  function Probe(): null {
    useGlobalShortcuts({
      socketRef: socketRef as never,
      sessionIdRef: sessionIdRef as never,
      diffFilesRef: diffFilesRef as never,
      setDiffFiles: h.setDiffFiles,
      settingsOpenRef: settingsOpenRef as never,
      setSettingsOpen: h.setSettingsOpen,
      mailboxOpenRef: mailboxOpenRef as never,
      setMailboxOpen: h.setMailboxOpen,
      refineStateRef: refineStateRef as never,
      setRefineState: h.setRefineState,
      refineEpochRef: h.refineEpochRef as never,
      refineStartFiredRef: refineStartFiredRef as never,
      draftRef: h.draftRef,
      setDraft: h.setDraft,
      setAttachedImages: h.setAttachedImages,
      textareaRef: h.textareaRef as never,
      setCommandPaletteOpen: h.setCommandPaletteOpen,
      runningRef: h.runningRef,
      messagesRef: h.messagesRef as never,
      submitWithRef: submitWithRef as never,
      pendingConfirmRef: h.pendingConfirmRef,
      decideConfirmRef: decideConfirmRef as never,
    });
    return null;
  }

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(<Probe />);
  });
  // Expose the ref locals the Probe receives — tests mutate them directly.
  return Object.assign(h, {
    root,
    socketRef,
    sessionIdRef,
    diffFilesRef,
    settingsOpenRef,
    mailboxOpenRef,
    refineStateRef,
    refineStartFiredRef,
    submitWithRef,
    decideConfirmRef,
  });
}

describe('useGlobalShortcuts — Escape panel priority', () => {
  it('closes the settings panel when it is open', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.settingsOpenRef.current = true;
    act(() => pressKey('Escape'));
    expect(h.setSettingsOpen).toHaveBeenCalledWith(false);
  });

  it('closes diff files before settings (topmost panel priority)', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.diffFilesRef.current = [{ path: 'a.ts' }] as never;
    h.settingsOpenRef.current = true;
    act(() => pressKey('Escape'));
    expect(h.setDiffFiles).toHaveBeenCalledWith(null);
    expect(h.setSettingsOpen).not.toHaveBeenCalled();
  });

  it('closes the mailbox when only it is open', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.mailboxOpenRef.current = true;
    act(() => pressKey('Escape'));
    expect(h.setMailboxOpen).toHaveBeenCalledWith(false);
  });

  it('restores the original draft + images and bumps the epoch for an active refine', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.refineEpochRef.current = 3;
    h.refineStateRef.current = {
      status: 'ready',
      epoch: 3,
      original: 'fix the bug',
      refined: 'Please fix the bug properly.',
      images: [
        { data: 'data1', mime: 'image/png' },
        { data: 'data2', mime: 'image/jpeg' },
      ],
    } as never;
    act(() => pressKey('Escape'));
    expect(h.setDraft).toHaveBeenCalledWith('fix the bug');
    expect(h.setRefineState).toHaveBeenCalledWith(null);
    expect(h.refineEpochRef.current).toBe(4);
    expect(h.setAttachedImages).toHaveBeenCalledWith([
      expect.objectContaining({ data: 'data1', mime: 'image/png' }),
      expect.objectContaining({ data: 'data2', mime: 'image/jpeg' }),
    ]);
  });

  it('leaves an in-progress draft untouched when Escape closes refine', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.refineStateRef.current = {
      status: 'ready',
      epoch: 1,
      original: 'original text',
      refined: 'refined text',
    } as never;
    h.draftRef.current = 'user typed more';
    act(() => pressKey('Escape'));
    expect(h.setDraft).not.toHaveBeenCalled();
    expect(h.setRefineState).toHaveBeenCalledWith(null);
    expect(h.setAttachedImages).not.toHaveBeenCalled();
  });
});

describe('useGlobalShortcuts — permission prompt Y/N/A', () => {
  it('answers yes / no / always while a prompt is pending', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.pendingConfirmRef.current = { id: 'c1', toolName: 'bash', input: 'ls' };
    act(() => pressKey('y'));
    expect(h.decideConfirm).toHaveBeenCalledWith('yes');
    act(() => pressKey('n'));
    expect(h.decideConfirm).toHaveBeenCalledWith('no');
    act(() => pressKey('a'));
    expect(h.decideConfirm).toHaveBeenCalledWith('always');
  });

  it('stays inert without a pending prompt', () => {
    const h = renderHarness();
    roots.push(h.root);
    act(() => pressKey('y'));
    expect(h.decideConfirm).not.toHaveBeenCalled();
  });

  it('ignores Y/N/A typed into an editable target', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.pendingConfirmRef.current = { id: 'c1', toolName: 'bash', input: 'ls' };
    act(() => {
      h.textareaRef.current?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'y', bubbles: true }),
      );
    });
    expect(h.decideConfirm).not.toHaveBeenCalled();
  });

  it('ignores modifier-carrying Y/N/A', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.pendingConfirmRef.current = { id: 'c1', toolName: 'bash', input: 'ls' };
    act(() => pressKey('y', { ctrlKey: true }));
    expect(h.decideConfirm).not.toHaveBeenCalled();
    act(() => pressKey('y', { altKey: true }));
    expect(h.decideConfirm).not.toHaveBeenCalled();
  });
});

describe('useGlobalShortcuts — palette, send, recall, new session', () => {
  it('Ctrl+K and Cmd+K open the command palette', () => {
    const h = renderHarness();
    roots.push(h.root);
    act(() => pressKey('k', { ctrlKey: true }));
    expect(h.setCommandPaletteOpen).toHaveBeenCalledWith(true);
    act(() => pressKey('k', { metaKey: true }));
    expect(h.setCommandPaletteOpen).toHaveBeenCalledWith(true);
  });

  it('Ctrl+Enter delegates the send to the composer dispatcher when idle', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.draftRef.current = 'hello';
    act(() => pressKey('Enter', { ctrlKey: true }));
    expect(h.submitWith).toHaveBeenCalledWith('btw');
  });

  it('Ctrl+Enter delegates even with an empty draft — the dispatcher owns the no-op', () => {
    const h = renderHarness();
    roots.push(h.root);
    act(() => pressKey('Enter', { ctrlKey: true }));
    expect(h.submitWith).toHaveBeenCalledWith('btw');
  });

  it('Ctrl+Enter stands down while a send is running', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.draftRef.current = 'hello';
    h.runningRef.current = true;
    act(() => pressKey('Enter', { ctrlKey: true }));
    expect(h.submitWith).not.toHaveBeenCalled();
  });

  it('ArrowUp recalls the last user message into an empty focused composer', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.messagesRef.current = [
      { id: 'u0', role: 'user', text: 'older message' },
      { id: 'a0', role: 'assistant', text: 'reply' },
      { id: 'u1', role: 'user', text: 'recalled message' },
    ];
    h.textareaRef.current?.focus();
    act(() => pressKey('ArrowUp'));
    expect(h.setDraft).toHaveBeenCalledWith('recalled message');
  });

  it('ArrowUp does not recall when the composer already has text', () => {
    const h = renderHarness();
    roots.push(h.root);
    h.messagesRef.current = [{ id: 'u1', role: 'user', text: 'recalled message' }];
    h.draftRef.current = 'already typing';
    h.textareaRef.current?.focus();
    act(() => pressKey('ArrowUp'));
    expect(h.setDraft).not.toHaveBeenCalled();
  });

  it('Ctrl+L starts a new session with the active session id', () => {
    const h = renderHarness();
    roots.push(h.root);
    act(() => pressKey('l', { ctrlKey: true }));
    expect(h.socketRef.current?.send).toHaveBeenCalledWith('session.new', {
      sessionId: 'session-1',
    });
    // The send goes through the socket ref captured in the harness closure.
    expect(h.submitWith).not.toHaveBeenCalled();
  });

  it('Ctrl+L is a no-op without an active session id', () => {
    const h = renderHarness();
    roots.push(h.root);
    // sessionIdRef starts as 'session-1'; a null id is the no-op branch.
    h.sessionIdRef.current = null;
    act(() => pressKey('l', { ctrlKey: true }));
    expect(h.socketRef.current?.send).not.toHaveBeenCalled();
  });

  it('removes its listeners on unmount', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const h = renderHarness();
    act(() => h); // no-op to satisfy lint symmetry with render
    act(() => roots.pop()?.unmount());
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    removeSpy.mockRestore();
  });
});
