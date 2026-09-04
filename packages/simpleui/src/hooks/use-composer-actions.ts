import { useCallback } from 'react';
import { clearComposerDraft } from '../lib/composer-draft.js';
import { composePromptWithFileReferences } from '../lib/file-mention.js';
import {
  enqueueFront,
  enqueueItem,
  type QueuedItem,
  type QueueMode,
  resolveSendPlan,
} from '../lib/queue-model.js';
import {
  parseFallbackRef,
  type RefineDecision,
  type RefineState,
  resolveRefineText,
} from '../lib/refine-model.js';
import type { SimpleSocket } from '../lib/ws.js';

export interface UseComposerActionsOptions {
  sessionIdRef: React.RefObject<string | null>;
  socketRef: React.RefObject<SimpleSocket | null>;
  draftRef: React.RefObject<string>;
  fileRefsRef: React.RefObject<string[]>;
  refineStateRef: React.RefObject<RefineState | null>;
  refineEpochRef: React.RefObject<number>;
  draft: string;
  fileRefs: string[];
  running: boolean;
  /** Caller-provided dispatch — the hook uses this inside submitWith.
   *  This lets the caller keep its own refine-aware startSend logic. */
  startSend: (
    content: string,
    images?: { data: string; mime: string; mediaType?: string }[],
  ) => void;
  /** Direct dispatch that bypasses the refine round-trip. Used by
   *  refineDecision so a panel decision sends immediately instead of
   *  re-entering the refine pipeline (which would loop back into
   *  'refining'). Returns `true` when dispatched, `false` when dropped
   *  (no session / empty content / no socket). */
  dispatchUserMessage: (
    content: string,
    images?: { data: string; mime: string; mediaType?: string }[],
  ) => boolean;
  setQueue: React.Dispatch<React.SetStateAction<QueuedItem[]>>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setFileRefs: React.Dispatch<React.SetStateAction<string[]>>;
  setAttachedImages: React.Dispatch<
    React.SetStateAction<{ id: string; data: string; mime: string; name: string }[]>
  >;
  attachedImagesRef: React.RefObject<{ data: string; mime: string; name: string; id: string }[]>;
  setRefineState: React.Dispatch<React.SetStateAction<RefineState | null>>;
}

export interface UseComposerActionsResult {
  submitWith: (mode: QueueMode) => void;
  refineDecision: (decision: RefineDecision) => void;
  refineRetry: () => void;
  refineRetryFallback: (ref: string) => void;
  abort: () => void;
}

function messageId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Owns the composer dispatch chain: the single `dispatchUserMessage` entry
 * point, the `startSend` guard that checks refine state, the `submitWith`
 * queue-mode router (send/enqueue/steer), the refine decision/retry flow,
 * and the abort action.
 *
 * Behavioural contract (must survive the PR-5 extraction from `app.tsx`):
 *  - `dispatchUserMessage` composes file references into the prompt and
 *    sends a `user_message` frame; it does NOT check running state.
 *  - `startSend` guards on `runningRef` — if a run is in flight, it
 *    routes through the refine flow instead of dispatching directly.
 *  - `submitWith` uses `resolveSendPlan(mode, running)`:
 *    - `send` → `startSend(composedContent, images)`
 *    - `enqueue` → append to queue
 *    - `abort-then-enqueue-front` → `socket.send('abort')` + `enqueueFront`
 *  - `/clear` slash resets draft, fileRefs, images, and sends `session.new`.
 *  - `refineDecision` routes keep/edit/discard.
 *  - `refineRetry` re-sends the same text with `model.refine`.
 *  - `refineRetryFallback` switches provider/model with a 180s timeout.
 *  - `abort` sends `abort` frame.
 */
export function useComposerActions(options: UseComposerActionsOptions): UseComposerActionsResult {
  const {
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
  } = options;

  const submitWith = useCallback(
    (mode: QueueMode) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;

      // Slash commands
      if (draft.trim() === '/clear') {
        if (sessionIdRef.current) {
          clearComposerDraft(sessionIdRef.current);
          draftRef.current = '';
          fileRefsRef.current = [];
        }
        setDraft('');
        setFileRefs([]);
        setAttachedImages([]);
        socketRef.current?.send('session.new', { sessionId: sessionIdRef.current });
        return;
      }

      const content = composePromptWithFileReferences(draft, fileRefs);
      const hasImages = (attachedImagesRef.current?.length ?? 0) > 0;
      if (!content && !hasImages) return;

      const plan = resolveSendPlan(mode, running);
      const now = Date.now();

      if (plan === 'send') {
        // WS-055: the server's `IncomingImagePayload` reads `mediaType`, not
        // `mime`. Sending only `mime` meant the declared type was dropped on
        // arrival and `parseIncomingImages` fell back to whatever it could
        // parse out of the data URL — so the field the UI shows and the field
        // the server validates were never the same value. Send both: the
        // canonical key for the server, `mime` retained because the local
        // queue-replay path and its tests read it.
        const currentImages = attachedImagesRef.current.map((img) => ({
          data: img.data,
          mime: img.mime,
          mediaType: img.mime,
        }));
        setDraft('');
        setFileRefs([]);
        setAttachedImages([]);
        if (sessionIdRef.current) {
          clearComposerDraft(sessionIdRef.current);
          draftRef.current = '';
          fileRefsRef.current = [];
        }
        startSend(content, currentImages);
        return;
      }

      if (plan === 'enqueue') {
        const item: QueuedItem = {
          id: messageId('q'),
          text: content,
          mode,
          addedAt: now,
          // The queue must carry the attachments or a queued send silently
          // strips them — same parity as the direct send path above.
          ...(hasImages && {
            images: attachedImagesRef.current.map((img) => ({ data: img.data, mime: img.mime })),
          }),
        };
        setQueue((current) => enqueueItem(current, item));
        setDraft('');
        setFileRefs([]);
        setAttachedImages([]);
        if (sessionIdRef.current) {
          clearComposerDraft(sessionIdRef.current);
          draftRef.current = '';
          fileRefsRef.current = [];
        }
        return;
      }

      // abort-then-enqueue-front
      const item: QueuedItem = {
        id: messageId('q'),
        text: content,
        mode,
        addedAt: now,
        ...(hasImages && {
          images: attachedImagesRef.current.map((img) => ({ data: img.data, mime: img.mime })),
        }),
      };
      setQueue((current) => enqueueFront(current, item));
      setDraft('');
      setFileRefs([]);
      setAttachedImages([]);
      if (sessionIdRef.current) {
        clearComposerDraft(sessionIdRef.current);
        draftRef.current = '';
        fileRefsRef.current = [];
      }
      socketRef.current?.send('abort', { sessionId: sessionIdRef.current });
    },
    [
      sessionIdRef,
      socketRef,
      draft,
      fileRefs,
      running,
      draftRef,
      fileRefsRef,
      setDraft,
      setFileRefs,
      setAttachedImages,
      setQueue,
      startSend,
    ],
  );

  const refineDecision = useCallback(
    (decision: RefineDecision) => {
      const refineState = refineStateRef.current;
      if (!refineState) return;
      const text = resolveRefineText(refineState, decision);
      // Null the ref synchronously so a same-tick startSend flush (which
      // reads refineStateRef.current before the commit) cannot dispatch
      // the original a second time.
      refineStateRef.current = null;
      setRefineState(null);
      // Use dispatchUserMessage (not startSend) so a panel decision sends
      // the resolved text immediately. startSend would re-enter the refine
      // pipeline and loop back into 'refining'. Forward the images captured
      // with the original message so attachments survive the refine detour.
      if (text) {
        if (refineState.images?.length) dispatchUserMessage(text, refineState.images);
        else dispatchUserMessage(text);
      }
    },
    [refineStateRef, setRefineState, dispatchUserMessage],
  );

  const refineRetry = useCallback(() => {
    const refineState = refineStateRef.current;
    if (!refineState) return;
    // Flip back to the in-flight face so the user sees the retry running
    // instead of a stale failed/ready panel.
    // Increment the epoch so any late model.refine_result from the
    // previous attempt is recognised as stale by the message handler's
    // Guard 1 (epoch-mismatch check).
    refineEpochRef.current++;
    setRefineState({
      ...refineState,
      status: 'refining',
      error: undefined,
      errorKind: undefined,
      epoch: refineEpochRef.current,
    });
    socketRef.current?.send('model.refine', {
      text: refineState.original,
      ...(refineState.status === 'ready'
        ? {
            // "Try again better": give the refiner the previous round so it
            // can improve on it rather than restart from scratch.
            previousRefined: refineState.refined,
            previousEnglish: refineState.english,
          }
        : {}),
    });
  }, [refineStateRef, refineEpochRef, setRefineState, socketRef]);

  const refineRetryFallback = useCallback(
    (ref: string) => {
      const parsed = parseFallbackRef(ref);
      if (!parsed) return;
      const refineState = refineStateRef.current;
      if (!refineState) return;
      const { provider, model } = parsed;
      // Reflect the fallback model on the in-flight face immediately.
      // Increment the epoch so any late model.refine_result from the
      // previous attempt is recognised as stale.
      refineEpochRef.current++;
      setRefineState({
        ...refineState,
        status: 'refining',
        error: undefined,
        errorKind: undefined,
        provider,
        model,
        epoch: refineEpochRef.current,
      });
      socketRef.current?.send('model.refine', {
        text: refineState.original,
        provider,
        model,
        timeoutMs: 180_000,
      });
    },
    [refineStateRef, refineEpochRef, setRefineState, socketRef],
  );

  const abort = useCallback(() => {
    socketRef.current?.send('abort', { sessionId: sessionIdRef.current ?? undefined });
  }, [socketRef, sessionIdRef]);

  return {
    submitWith,
    refineDecision,
    refineRetry,
    refineRetryFallback,
    abort,
  };
}
