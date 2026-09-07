import { type RefObject, useEffect } from 'react';
import type { QueueMode } from '../lib/queue-model.js';
import { type RefineState, resolveEscapeRestore } from '../lib/refine-model.js';
import type { SimpleSocket } from '../lib/ws.js';
import type { ChatMessage, FileEditMeta, PendingConfirm } from '../types.js';

export interface UseGlobalShortcutsOptions {
  socketRef: RefObject<SimpleSocket | null>;
  sessionIdRef: RefObject<string | null>;
  diffFilesRef: RefObject<FileEditMeta[] | null>;
  setDiffFiles: (files: FileEditMeta[] | null) => void;
  settingsOpenRef: RefObject<boolean>;
  setSettingsOpen: (open: boolean) => void;
  mailboxOpenRef: RefObject<boolean>;
  setMailboxOpen: (open: boolean) => void;
  refineStateRef: RefObject<RefineState | null>;
  setRefineState: (state: RefineState | null) => void;
  refineEpochRef: RefObject<number>;
  refineStartFiredRef: RefObject<boolean>;
  draftRef: RefObject<string>;
  setDraft: (value: string) => void;
  setAttachedImages: (
    images: Array<{ data: string; mime: string; name: string; id: string }>,
  ) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setCommandPaletteOpen: (open: boolean) => void;
  runningRef: RefObject<boolean>;
  messagesRef: RefObject<ChatMessage[]>;
  /** Live mirror of the composer's own `submitWith` dispatcher. Ctrl/Cmd+Enter
   *  delegates here so the global shortcut and the composer share ONE send
   *  path (compose @file references, forward attached images, clear the
   *  composer + its persisted draft). The inline re-implementation this
   *  replaces drifted from `submitWith` once already — a raw-draft send that
   *  silently stripped references/images. Delegate, never duplicate. */
  submitWithRef: RefObject<(mode: QueueMode) => void>;
  /** Live mirror of the pending permission prompt. When set, Y/N/A answer it —
   *  unless the keystroke lands in an editable target or carries modifiers. */
  pendingConfirmRef?: RefObject<PendingConfirm | null>;
  /** Live mirror of the prompt's decideConfirm dispatcher (recreated per
   *  render upstream, hence the ref instead of a closure). */
  decideConfirmRef?: RefObject<((decision: 'yes' | 'no' | 'always') => void) | undefined>;
}

/**
 * Registers the SimpleUI global keyboard shortcuts: Escape closes the
 * topmost open panel (file diff → settings → mailbox → refine-escape
 * restore), Y/N/A answer the pending permission prompt, Ctrl/Cmd+K opens
 * the command palette, Ctrl/Cmd+Enter delegates the idle send to the
 * composer's own `submitWith` dispatcher, ArrowUp recalls the last user
 * message into an empty composer, and Ctrl/Cmd+L starts a new session.
 * Everything is read through refs or stable state setters at dispatch
 * time, so the listeners never go stale and are registered exactly once.
 */
export function useGlobalShortcuts(options: UseGlobalShortcutsOptions): void {
  const {
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
    messagesRef,
    submitWithRef,
    pendingConfirmRef,
    decideConfirmRef,
  } = options;

  // ── Global keyboard shortcuts ──────────────────────────────────
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      // ── Escape: close the topmost open panel ──
      if (event.key === 'Escape') {
        if (diffFilesRef.current) {
          event.preventDefault();
          setDiffFiles(null);
          return;
        }
        if (settingsOpenRef.current) {
          event.preventDefault();
          setSettingsOpen(false);
          return;
        }
        if (mailboxOpenRef.current) {
          event.preventDefault();
          setMailboxOpen(false);
          return;
        }
        if (refineStateRef.current) {
          event.preventDefault();
          // Don't drop the user's text or images — the composer was cleared
          // when the send started (submitWith flushes draft+fileRefs+images),
          // so hand the original back for another edit pass.
          // Guard: never clobber text the user typed after the panel opened
          // (resolveEscapeRestore returns null in that case).
          const images = refineStateRef.current.images;
          // Bump the epoch so any in-flight model.refine result that
          // arrives after Escape (e.g., a slow 180s refineRetryFallback
          // window) is recognised as stale and dropped by the handler
          // — the wire protocol carries no request id, so a slow orphan
          // could otherwise match by epoch coincidence and corrupt a
          // later send.
          refineEpochRef.current++;
          refineStartFiredRef.current = false;
          const restore = resolveEscapeRestore(refineStateRef.current, draftRef.current);
          // Null the ref synchronously so a same-tick startSend flush or
          // panel decision cannot observe the dismissed state and dispatch.
          refineStateRef.current = null;
          setRefineState(null);
          if (restore !== null) {
            setDraft(restore);
            draftRef.current = restore;
          }
          // Restore attached images that were part of the original send.
          // Without this, a re-submit silently drops the images because
          // submitWith clears them before startSend.
          if (images && images.length > 0) {
            setAttachedImages(
              images.map((img, i) => ({
                id: `restored-${Date.now()}-${i}`,
                name: `restored-${i}`,
                data: img.data,
                mime: img.mime,
              })),
            );
          }
          requestAnimationFrame(() => textareaRef.current?.focus());
          return;
        }
        return;
      }

      // ── Y/N/A: answer the pending permission prompt ──
      // Deliberately inert when the keystroke lands in an editable target
      // (typing "y" in the composer must stay typing) or carries modifiers.
      if (pendingConfirmRef?.current && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const target = event.target;
        const editable =
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLSelectElement ||
          (target instanceof HTMLElement && target.isContentEditable);
        if (!editable) {
          const key = event.key.toLowerCase();
          const decision =
            key === 'y' ? 'yes' : key === 'n' ? 'no' : key === 'a' ? 'always' : null;
          if (decision) {
            event.preventDefault();
            decideConfirmRef?.current?.(decision);
            return;
          }
        }
      }

      // ── Ctrl/Cmd+K: open command palette ──
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      // ── Ctrl/Cmd+Enter: send the composer ──
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        if (!runningRef.current) {
          event.preventDefault();
          // Delegate to the composer's own dispatcher (submitWith's idle
          // 'send' plan) instead of re-implementing it: composed @file
          // references, forwarded attached images, cleared composer state
          // and persisted draft. An empty draft is the dispatcher's own
          // no-op, and images-only sends now work from here too — the old
          // inline trim() guard silently dropped them.
          submitWithRef.current('btw');
        }
        return;
      }

      // ── ArrowUp: recall last sent message into empty composer ──
      if (
        event.key === 'ArrowUp' &&
        document.activeElement === textareaRef.current &&
        !draftRef.current.trim() &&
        !runningRef.current
      ) {
        event.preventDefault();
        const lastUser = [...messagesRef.current].reverse().find((m) => m.role === 'user');
        if (lastUser) {
          setDraft(lastUser.text);
          // Move cursor to end on next frame so the textarea has updated.
          requestAnimationFrame(() => {
            const ta = textareaRef.current;
            if (ta) {
              ta.selectionStart = ta.value.length;
              ta.selectionEnd = ta.value.length;
            }
          });
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // Everything the handler reads is a ref or a stable useState setter —
    // register exactly once for the component's lifetime.
  }, []);

  // Ctrl/Cmd+L: new session (second, independent listener).
  useEffect(() => {
    const handleGlobalKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'l' && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
        event.preventDefault();
        if (!runningRef.current && sessionIdRef.current) {
          socketRef.current?.send('session.new', { sessionId: sessionIdRef.current });
        }
        return;
      }
    };
    document.addEventListener('keydown', handleGlobalKey);
    return () => document.removeEventListener('keydown', handleGlobalKey);
  }, []);
}
