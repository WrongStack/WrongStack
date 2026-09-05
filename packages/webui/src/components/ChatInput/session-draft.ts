import type React from 'react';
import { useEffect, useRef } from 'react';
import { useFileReferenceStore, useSessionStore, useUIStore } from '@/stores';
import { onLaneDisposed } from '@/stores/chat-lanes';
import { useConfirmModalStore } from '../ConfirmModal.js';
import type { FileMentionState } from './file-mention-picker.js';
import type { ImageAttachment } from './image-attachments.js';
import type { PasteHintState } from './use-paste-drop.js';

export function resolveCancelInput(prev: string, original: string): string {
  return prev.trim() ? prev : original;
}

export interface SessionDraftRecord {
  input: string;
  images: ImageAttachment[];
  refs: ReturnType<typeof useFileReferenceStore.getState>['refs'];
}

/**
 * One unsent draft per tab: text, image attachments and file chips.
 *
 * There is a single ChatInput for all four tabs (the chat surface is parked,
 * never unmounted), so without this the tab you switch to inherits the text
 * you were typing in the tab you left.
 *
 * Keyed by session id and freed with the lane, so a closed tab's draft cannot
 * come back on a session that is later handed the same id — and the map does
 * not grow for the life of the page.
 */
export const sessionDraftMap = new Map<string, SessionDraftRecord>();

onLaneDisposed((sessionId) => {
  sessionDraftMap.delete(sessionId);
});

export function clearSessionDraft(sessionId?: string | null): void {
  const curId = sessionId ?? useSessionStore.getState().session?.id;
  if (curId) {
    sessionDraftMap.delete(curId);
  }
}

export interface UseSessionDraftOptions {
  sessionId: string | null;
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  pendingImages: ImageAttachment[];
  setPendingImages: (images: ImageAttachment[]) => void;
  clearPendingImages: () => void;
  fileRefs: ReturnType<typeof useFileReferenceStore.getState>['refs'];
  clearRefs: () => void;
  setHistoryIdx: (idx: number) => void;
  stickyDraftRef: React.MutableRefObject<string | null>;
  setAtMention: (mention: FileMentionState | null) => void;
  setPasteHint: (hint: PasteHintState | null) => void;
  stopSpeech: () => void;
  topicCheckAbortRef: React.MutableRefObject<AbortController | null>;
  topicCheckBusyRef: React.MutableRefObject<boolean>;
  setTopicCheckBusy: (busy: boolean) => void;
  refineBackstopTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function useSessionDraft({
  sessionId,
  input,
  setInput,
  pendingImages,
  setPendingImages,
  clearPendingImages,
  fileRefs,
  clearRefs,
  setHistoryIdx,
  stickyDraftRef,
  setAtMention,
  setPasteHint,
  stopSpeech,
  topicCheckAbortRef,
  topicCheckBusyRef,
  setTopicCheckBusy,
  refineBackstopTimerRef,
  textareaRef,
}: UseSessionDraftOptions): void {
  const prevSessionIdRef = useRef<string | null>(sessionId);

  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return;
    const oldId = prevSessionIdRef.current;
    if (oldId) {
      sessionDraftMap.set(oldId, {
        input,
        images: [...pendingImages],
        refs: [...fileRefs],
      });
    }
    prevSessionIdRef.current = sessionId;

    // A refinement in flight belongs to the tab it was typed in. The panel is
    // one global surface over one shared composer, and both of its exits —
    // the user approving it and the 105s timeout firing on its own — dispatch
    // through the FOREGROUND. Left standing across a tab switch it therefore
    // delivers one tab's prompt into another tab's session, the timeout doing
    // so with nobody touching anything. Take it down and hand the text back
    // to the tab that typed it, which still has it when the user returns.
    const panel = useUIStore.getState().refinePanel;
    const panelOwner = panel?.sessionId ?? oldId;
    if (panel && panelOwner !== sessionId) {
      useUIStore.getState().setRefinePanel(null);
      if (panelOwner) {
        const saved = sessionDraftMap.get(panelOwner) ?? { input: '', images: [], refs: [] };
        sessionDraftMap.set(panelOwner, { ...saved, input: panel.original });
      }
    }

    if (sessionId && sessionDraftMap.has(sessionId)) {
      const saved = sessionDraftMap.get(sessionId)!;
      const projectedDraft = useUIStore.getState().draftInput;
      setInput(saved.input.trim() ? saved.input : projectedDraft);
      setPendingImages(saved.images);
      clearRefs();
      for (const r of saved.refs) {
        useFileReferenceStore.getState().addRef(r);
      }
    } else {
      setInput(sessionId ? useUIStore.getState().draftInput : '');
      clearPendingImages();
      clearRefs();
    }
    setHistoryIdx(-1);
    stickyDraftRef.current = null;
    setAtMention(null);
    setPasteHint(null);
    stopSpeech();
    topicCheckAbortRef.current?.abort();
    topicCheckAbortRef.current = null;
    topicCheckBusyRef.current = false;
    setTopicCheckBusy(false);
    // The 30s refine backstop armed by the tab we just left must not fire into
    // the tab we just entered (it clears the shared pending-refinement state).
    if (refineBackstopTimerRef.current !== null) {
      clearTimeout(refineBackstopTimerRef.current);
      refineBackstopTimerRef.current = null;
    }
    useConfirmModalStore.getState().settle(null);
    const ta = textareaRef.current;
    if (ta) ta.style.height = 'auto';
  }, [
    sessionId,
    input,
    pendingImages,
    fileRefs,
    clearRefs,
    clearPendingImages,
    refineBackstopTimerRef,
    setAtMention,
    setHistoryIdx,
    setInput,
    setPasteHint,
    setPendingImages,
    setTopicCheckBusy,
    stickyDraftRef,
    stopSpeech,
    textareaRef,
    topicCheckAbortRef,
    topicCheckBusyRef,
  ]);
}
