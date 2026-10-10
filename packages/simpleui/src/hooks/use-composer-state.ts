import { useCallback, useEffect, useRef, useState } from 'react';
import { retainSimpleChatMessages } from '../lib/chat-model.js';
import { pruneStaleComposerDrafts, writeComposerDraft } from '../lib/composer-draft.js';
import { removeFileMention } from '../lib/file-mention.js';
import { isVisionModel } from '../lib/model-capabilities.js';
import type { QueuedItem } from '../lib/queue-model.js';
import type { RefineState } from '../lib/refine-model.js';
import { restoreRefineToComposer } from '../lib/refine-restore.js';
import { messageId } from '../lib/session-helpers.js';
import type { SimpleSocket } from '../lib/ws.js';
import type { ChatMessage, PendingConfirm, SessionInfo, ToolCallInfo } from '../types.js';
import { useComposerActions } from './use-composer-actions.js';
import { useF5Resilience } from './use-f5-resilience.js';
import { useFileMention } from './use-file-mention.js';
import { useImageAttachments } from './use-image-attachments.js';
import type { UseSettingsResult } from './use-settings.js';
import type { UseStatusNoticeResult } from './use-status-notice.js';

export interface UseComposerStateOptions {
  session: SessionInfo | null;
  sessionIdRef: React.RefObject<string | null>;
  socketRef: React.RefObject<SimpleSocket | null>;
  running: boolean;
  runningRef: React.RefObject<boolean>;
  prefsRef: UseSettingsResult['prefsRef'];
  activeModelRef: React.RefObject<{ provider: string; model: string } | null>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setRunning: React.Dispatch<React.SetStateAction<boolean>>;
  setToolCalls: React.Dispatch<React.SetStateAction<ToolCallInfo[]>>;
  setActivity: React.Dispatch<React.SetStateAction<string>>;
  setNotice: UseStatusNoticeResult['showNotice'];
}

/**
 * Composer state for the SimpleUI session: draft, file references, message
 * queue, refine round-trip, pending permission prompts and image
 * attachments — plus the single send chain (`dispatchUserMessage` /
 * `startSend` / refine decisions) and the composer-adjacent effects
 * (autosize, draft persistence, rejected-image notices, F5 resilience).
 * Extracted from `use-simple-ui-session.tsx` unchanged (facade contract
 * preserved); session-domain setters arrive as parameters from the
 * composition root.
 */
export function useComposerState({
  session,
  sessionIdRef,
  socketRef,
  running,
  runningRef,
  prefsRef,
  activeModelRef,
  setMessages,
  setRunning,
  setToolCalls,
  setActivity,
  setNotice,
}: UseComposerStateOptions) {
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const [refineState, setRefineState] = useState<RefineState | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [draft, setDraft] = useState('');
  const [fileRefs, setFileRefs] = useState<string[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const draftRef = useRef('');
  const fileRefsRef = useRef<string[]>([]);
  // handleServerMessage is a stable []-callback, so the drain and refine
  // paths it triggers read live state through refs rather than closing over
  // a stale render.
  const refineStateRef = useRef<RefineState | null>(null);
  /** Monotonically increasing epoch attached to each `model.refine` request
   *  so the handler can detect and drop stale results that arrive after the
   *  user flushed the panel and started a new round-trip. */
  const refineEpochRef = useRef(0);
  /** Stash the original text when kicking off a refine round-trip so the
   *  socket send can happen post-commit in a useEffect, decoupling the
   *  send from the setRefineState updater and preventing a race where the
   *  status flips to 'refining' without a request in flight. */
  const pendingSendRef = useRef<string | null>(null);
  /** One-shot guard for refineStartNow. The RefinePanel's `countdownFiredRef`
   *  only protects the timer-path effect; a click racing the timer (or
   *  StrictMode double-invoke) can call refineStartNow twice in the same
   *  batch, and `refineStateRef.current` does not update between those two
   *  calls. Without this guard the second call would bump the epoch again
   *  (making the eventual result look stale → spinner stuck forever) and
   *  re-stash `pendingSendRef` after the effect already consumed it
   *  (leaking a duplicate `model.refine` on the next unrelated refineState
   *  change). Reset at the start of every countdown round by startSend. */
  const refineStartFiredRef = useRef(false);
  const queueRef = useRef<QueuedItem[]>([]);
  const attachedImagesRef = useRef<{ data: string; mime: string; name: string; id: string }[]>([]);
  const pendingConfirmRef = useRef<PendingConfirm | null>(null);
  pendingConfirmRef.current = pendingConfirm;
  draftRef.current = draft;
  fileRefsRef.current = fileRefs;
  refineStateRef.current = refineState;
  queueRef.current = queue;

  const visionSupported = isVisionModel(session?.model ?? '');

  const {
    fileMention,
    setFileMention,
    fileMatches,
    setFileMatches,
    filePickerIndex,
    setFilePickerIndex,
    fileSearching,
    setFileSearching,
  } = useFileMention({ socketRef });

  const { attachedImages, attachImages, removeImage, setAttachedImages, rejectedImages } =
    useImageAttachments();
  attachedImagesRef.current = attachedImages;

  useEffect(() => {
    if (rejectedImages.length > 0) {
      const first = rejectedImages[0];
      setNotice({
        id: messageId('notice'),
        text: `Image rejected: ${first?.name} (${first?.reason})`,
        tone: 'error',
      });
    }
  }, [rejectedImages, setNotice]);

  /** Send a message to the agent and reflect it locally. The single send
   *  path — the composer, the queue drain, and every refine decision all
   *  funnel through here.
   *
   *  Returns `true` when the message was actually dispatched, `false` when it
   *  was dropped (no session, empty content, or no live socket). Callers that
   *  advance a queue MUST gate on this: a drop must not consume the queued
   *  item, or the user's held message is silently lost. */
  const dispatchUserMessage = useCallback(
    (content: string, images?: { data: string; mime: string; mediaType?: string }[]): boolean => {
      const sessionId = sessionIdRef.current;
      const socket = socketRef.current;
      if ((!content && (!images || images.length === 0)) || !sessionId || !socket) return false;
      setMessages((current) =>
        retainSimpleChatMessages([
          ...current,
          {
            id: messageId('user'),
            role: 'user',
            text: content,
            // Live entries need a real timestamp or the timeline orders them
            // against tool calls incorrectly (see ChatMessageList).
            ts: new Date().toISOString(),
            ...(images && images.length > 0 ? { images } : {}),
          },
        ]),
      );
      setRunning(true);
      setToolCalls([]);
      setActivity('Thinking');
      const payload: Record<string, unknown> = {
        sessionId,
        id: messageId('prompt'),
        content,
        timestamp: Date.now(),
      };
      if (images && images.length > 0) payload['images'] = images;
      socket.send('user_message', payload);
      return true;
    },
    [],
  );

  /** Open the refine round-trip, or send straight through when refine is off. */
  const startSend = useCallback(
    (content: string, images?: { data: string; mime: string; mediaType?: string }[]) => {
      // Flush any pending refine state before starting a new one.  If a
      // previous send is still in countdown/refining, dispatch its original
      // immediately so the user's first message isn't silently dropped.
      // Increment the epoch so any in-flight model.refine result is
      // recognised as stale and dropped by the message handler.
      // Note: auto-dispatch is restricted to countdown/refining — for
      // 'ready'/'failed' the user has already seen the panel and may be
      // reviewing or deciding what to do, so we must not silently
      // re-send the unrefined original.
      const pending = refineStateRef.current;
      if (pending && (pending.status === 'countdown' || pending.status === 'refining')) {
        refineEpochRef.current++;
        // Null the ref synchronously — refineStateRef.current is otherwise
        // only refreshed on commit, so between here and the setRefineState
        // commit a same-tick Escape/decision handler would still see the
        // flushed state and could dispatch the original a second time.
        refineStateRef.current = null;
        setRefineState(null);
        dispatchUserMessage(pending.original, pending.images);
      }
      // Reset the one-shot refineStartNow guard so the new countdown round
      // can fire once on timer-zero / "Refine now" click.
      refineStartFiredRef.current = false;

      if (!prefsRef.current.enhanceEnabled) {
        dispatchUserMessage(content, images);
        return;
      }
      const active = activeModelRef.current;
      const profileRef = prefsRef.current.refinerFallbackProfile
        ? prefsRef.current.fallbackProfiles[prefsRef.current.refinerFallbackProfile]?.[0]
        : undefined;
      const slash = profileRef?.indexOf('/') ?? -1;
      const displayedProvider = profileRef
        ? slash > 0
          ? profileRef.slice(0, slash)
          : active?.provider
        : prefsRef.current.refinerProvider || active?.provider;
      const displayedModel = profileRef
        ? slash > 0
          ? profileRef.slice(slash + 1)
          : profileRef
        : prefsRef.current.refinerModel || active?.model;
      // Reset the one-shot guard so the new countdown round can fire
      // refineStartNow. Without this, a second startSend while a previous
      // refine is still in-flight would leave refineStartFiredRef=true and
      // the new message would never be refined.
      refineStartFiredRef.current = false;
      // Open with a 3-2-1 grace countdown (mirrors the WebUI): the refine
      // request itself is deferred until the countdown elapses or the user
      // clicks "Refine now" — refineStartNow fires it.
      setRefineState({
        original: content,
        refined: content,
        english: content,
        status: 'countdown',
        provider: displayedProvider,
        model: displayedModel,
        images,
      });
    },
    [dispatchUserMessage],
  );

  /** Countdown elapsed (or "Refine now") — kick off the refine round-trip. */
  const refineStartNow = useCallback(() => {
    const cur = refineStateRef.current;
    if (cur?.status !== 'countdown' || !cur.original) return;
    if (refineStartFiredRef.current) return;
    refineStartFiredRef.current = true;
    refineEpochRef.current++;
    pendingSendRef.current = cur.original;
    setRefineState((prev) =>
      prev?.status === 'countdown'
        ? { ...prev, status: 'refining', epoch: refineEpochRef.current }
        : prev,
    );
  }, []);

  /** Send a user-edited version of the refined text straight through. */
  const refineSendEdited = useCallback(
    (text: string) => {
      if (!text) return;
      // 'Send edited' exits the refine round-trip like every other decision —
      // replay the images captured with the original send instead of dropping
      // them (refineDecision, Escape-restore and the pending flush all do).
      const images = refineStateRef.current?.images;
      setRefineState(null);
      if (images?.length) dispatchUserMessage(text, images);
      else dispatchUserMessage(text);
    },
    [dispatchUserMessage],
  );

  /** Post-commit: fire the model.refine send when the status transitions
   *  to 'refining'. The original text is stashed in pendingSendRef by
   *  refineStartNow so the send is driven by the committed state, not by
   *  a side effect inside the setState updater. */
  useEffect(() => {
    const text = pendingSendRef.current;
    if (text) {
      pendingSendRef.current = null;
      socketRef.current?.send('model.refine', { text });
    }
  }, [refineState]);

  // F5 / tab-close resilience: exit confirmation + draft flush.
  useF5Resilience({
    confirmExitRef: prefsRef,
    runningRef,
    sessionIdRef,
    draftRef,
    fileRefsRef,
    writeComposerDraft,
  });

  const { submitWith, refineDecision, refineRetry, refineRetryFallback, abort } =
    useComposerActions({
      sessionIdRef,
      socketRef,
      draftRef,
      fileRefsRef,
      refineStateRef,
      refineEpochRef,
      draft,
      fileRefs,
      running,
      startSend,
      dispatchUserMessage,
      setQueue,
      setDraft,
      setFileRefs,
      setAttachedImages,
      attachedImagesRef,
      setRefineState,
    });
  /** Live mirror of the composer dispatcher — the global Ctrl/Cmd+Enter
   *  shortcut delegates here so both paths share ONE send implementation. */
  const submitWithRef = useRef(submitWith);
  submitWithRef.current = submitWith;

  /** Answer the pending permission prompt on the wire and clear it. Reads
   *  through pendingConfirmRef (not the render closure) so the dispatch is
   *  correct regardless of when the ref mirror last refreshed. */
  const decideConfirm = (
    decision: 'yes' | 'no' | 'always' | 'always-exact' | 'always-command' | 'always-tool',
  ) => {
    const confirm = pendingConfirmRef.current;
    if (!confirm) return;
    socketRef.current?.send('tool.confirm_result', {
      sessionId: sessionIdRef.current ?? undefined,
      id: confirm.id,
      decision,
    });
    setPendingConfirm(null);
  };
  /** Mirror for the global Y/N/A shortcut — decideConfirm is recreated per
   *  render, and the shortcut listener must not re-register on every render. */
  const decideConfirmRef = useRef<
    | ((
        decision: 'yes' | 'no' | 'always' | 'always-exact' | 'always-command' | 'always-tool',
      ) => void)
    | undefined
  >(undefined);
  decideConfirmRef.current = decideConfirm;

  /** Countdown "Edit": hand the message back to the composer instead of
   *  sending it. The panel is the only place the text lives at that point
   *  (submitWith flushed draft + images before the round-trip), so this runs
   *  the same restore the global Escape shortcut does — one path, two
   *  triggers, no drift. */
  const refineEditInComposer = useCallback(() => {
    restoreRefineToComposer({
      refineStateRef,
      setRefineState,
      refineEpochRef,
      refineStartFiredRef,
      draftRef,
      setDraft,
      setAttachedImages,
      textareaRef,
    });
  }, [setRefineState, setDraft, setAttachedImages]);

  const selectFile = (path: string) => {
    if (!fileMention) return;
    const cursor = fileMention.start;
    setDraft((current) => removeFileMention(current, fileMention));
    setFileRefs((current) => (current.includes(path) ? current : [...current, path]));
    setFileMention(null);
    setFileMatches([]);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(cursor, cursor);
    });
  };

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(180, Math.max(48, element.scrollHeight))}px`;
  }, [draft]);

  useEffect(() => {
    if (!session?.id) return;
    const timer = setTimeout(() => {
      writeComposerDraft(session.id, { text: draft, fileRefs });
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, fileRefs, session?.id]);

  // Drafts for abandoned sessions would otherwise accumulate forever.
  useEffect(() => {
    pruneStaleComposerDrafts();
  }, []);

  return {
    draft,
    setDraft,
    fileRefs,
    setFileRefs,
    queue,
    setQueue,
    refineState,
    setRefineState,
    pendingConfirm,
    setPendingConfirm,
    textareaRef,
    draftRef,
    fileRefsRef,
    refineStateRef,
    refineEpochRef,
    refineStartFiredRef,
    queueRef,
    pendingConfirmRef,
    fileMention,
    setFileMention,
    fileMatches,
    setFileMatches,
    filePickerIndex,
    setFilePickerIndex,
    fileSearching,
    setFileSearching,
    attachedImages,
    attachImages,
    removeImage,
    setAttachedImages,
    visionSupported,
    dispatchUserMessage,
    startSend,
    submitWith,
    submitWithRef,
    refineDecision,
    refineRetry,
    refineRetryFallback,
    refineStartNow,
    refineSendEdited,
    refineEditInComposer,
    abort,
    selectFile,
    decideConfirm,
    decideConfirmRef,
  };
}
