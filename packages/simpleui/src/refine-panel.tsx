import { Clock, Loader, Pencil, Send, Sparkles, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RefineDecision, RefineState } from './lib/refine-model.js';

interface RefinePanelProps {
  state: RefineState;
  onDecision: (decision: RefineDecision) => void;
  onRetry: () => void;
  onRetryFallback: (ref: string) => void;
  /** Pre-refine countdown elapsed (or "start now") — kick off model.refine. */
  onStartRefine: () => void;
  /** Send a user-edited version of the refined text. */
  onSendEdited: (text: string) => void;
}

/** Seconds for the pre-refine grace countdown (mirrors the WebUI's 3-2-1). */
const PRE_REFINE_SECONDS = 3;

/** Review step for a refined prompt.
 *
 * Four faces, one per status — mirroring the WebUI RefinePanel:
 *  - 'countdown': a 3-2-1 grace period before the refine round-trip starts,
 *    with "start now" and "send as-is" escape hatches;
 *  - 'refining': an in-flight spinner that keeps the original visible;
 *  - 'ready': refined/original comparison with keyboard shortcuts
 *    (Enter=refined, E=English, O=original, T=edit, R=retry)
 *    and an inline edit mode;
 *  - 'failed': a recovery panel. The failure face never silently sends the
 *    original — the user picks. */
export function RefinePanel({
  state,
  onDecision,
  onRetry,
  onRetryFallback,
  onStartRefine,
  onSendEdited,
}: RefinePanelProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(state.refined);
  const [countdown, setCountdown] = useState(PRE_REFINE_SECONDS);
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  /** Snapshot of the edit buffer taken when edit mode is entered.
   *  Escape restores this so the user's in-progress draft is not
   *  silently clobbered by `state.refined` / `state.original`. */
  const draftSnapshotRef = useRef<string>('');

  // Stable refs so effects depend only on stable values — a parent
  // re-render must not tear down and restart the interval or the
  // keyboard listener.
  const onStartRefineRef = useRef(onStartRefine);
  onStartRefineRef.current = onStartRefine;
  const onDecisionRef = useRef(onDecision);
  onDecisionRef.current = onDecision;
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;

  // One-shot guard: React 18 StrictMode double-invokes effects. Without this
  // guard the countdown-zero effect would call onStartRefine twice, and
  // refineStartNow's ref-status check wouldn't catch it because
  // refineStateRef.current isn't updated between the two invocations.
  const countdownFiredRef = useRef(false);

  // ── Pre-refine countdown (3-2-1 grace period) ──────────────────────────
  // The interval only decrements state; the zero-reached side effect lives
  // in its own effect so the state updater stays pure.
  //
  // Remount contract: the parent unmounts <RefinePanel> whenever
  // refineState is null, and `startSend` always sets refineState to null
  // before opening a new countdown.  This guarantees `setCountdown`
  // runs as part of a fresh mount — relying on `countdown === 0` from
  // a previous round would otherwise fire the countdown-zero effect
  // immediately on stale state.  If a future code path keeps the
  // panel mounted while flipping back to 'countdown', this effect
  // MUST be reworked to drive `countdown` from the status itself
  // (e.g. a key tied to the countdown round) instead of resetting
  // it inside the body.
  useEffect(() => {
    if (state.status !== 'countdown') return;
    countdownFiredRef.current = false;
    setCountdown(PRE_REFINE_SECONDS);
    const timer = setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [state.status]);

  useEffect(() => {
    if (state.status === 'countdown' && countdown <= 0 && !countdownFiredRef.current) {
      countdownFiredRef.current = true;
      onStartRefineRef.current();
    }
  }, [state.status, countdown]);

  // Keep the edit buffer in sync when a (re)refinement lands,
  // but do NOT clobber text the user is currently editing.
  // `state.status` is in the deps so a status flip that preserves
  // `state.refined` (e.g. 'refining' → 'failed') still resets the
  // buffer — `projectRefineResult` reuses the same refined string.
  useEffect(() => {
    if (!editing) setEditText(state.refined);
  }, [state.refined, state.status, editing]);

  // Focus the textarea when entering edit mode.
  useEffect(() => {
    if (editing) {
      editRef.current?.focus();
      // Snapshot the pre-edit text so Escape can restore the user's
      // in-progress draft instead of clobbering it with state.refined
      // / state.original.
      draftSnapshotRef.current = editText;
    }
  }, [editing]);

  // Reset edit mode when the panel status changes — a new refinement,
  // countdown restart, or failure recovery should not carry stale
  // editing state across faces.
  useEffect(() => {
    setEditing(false);
  }, [state.status]);

  const showEnglish =
    state.status === 'ready' && !!state.english && state.english !== state.refined;

  // ── Keyboard shortcuts — comparison face only ──────────────────────────
  // The countdown/refining/failed faces have their own affordances and must
  // not hijack Enter/E/O/T/R. Keys inside inputs/textareas are left alone.
  useEffect(() => {
    if (state.status !== 'ready' || editing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLButtonElement ||
        (e.target as HTMLElement)?.isContentEditable
      )
        return;
      // Never hijack browser/OS chords — Ctrl/Cmd+R (reload), +T (new tab),
      // +O (open file) must keep their native behaviour.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case 'Enter':
          e.preventDefault();
          onDecisionRef.current('refined');
          break;
        case 'e':
        case 'E':
          if (showEnglish) {
            e.preventDefault();
            onDecisionRef.current('english');
          }
          break;
        case 'o':
        case 'O':
          e.preventDefault();
          onDecisionRef.current('original');
          break;
        case 'r':
        case 'R':
          e.preventDefault();
          onRetryRef.current();
          break;
        case 't':
        case 'T':
          e.preventDefault();
          setEditing(true);
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state.status, editing, showEnglish]);

  const modelLabel =
    state.provider && state.model ? (
      <span className="refine-model-label">
        via {state.provider}/{state.model}
      </span>
    ) : null;

  switch (state.status) {
    case 'countdown':
      return (
        <div className="refine-panel countdown" role="status" aria-live="polite">
          <div className="refine-head">
            <Clock size={13} aria-hidden="true" />
            <strong>Refining in {countdown > 0 ? countdown : ''}…</strong>
            {modelLabel}
          </div>
          <p className="refine-preview">{state.original}</p>
          <div className="refine-actions">
            <button type="button" onClick={() => onDecision('original')}>
              <Send size={11} aria-hidden="true" /> Send as-is
            </button>
            {/* Route through the ref (like the countdown-zero effect) so the
                button and the effect always invoke the same handler version,
                even if a parent passes an unstable closure. */}
            <button type="button" className="primary" onClick={() => onStartRefineRef.current()}>
              <Sparkles size={11} aria-hidden="true" /> Refine now
            </button>
          </div>
        </div>
      );

    case 'refining':
      return (
        <div className="refine-panel refining" role="status" aria-live="polite">
          <Loader size={13} className="refine-spin" aria-hidden="true" />
          <span>
            Refining your prompt
            {state.provider && state.model ? ` on ${state.provider}/${state.model}` : ''}…
          </span>
          <button type="button" onClick={() => onDecision('original')}>
            Send as-is
          </button>
        </div>
      );

    case 'failed':
      return (
        <div className="refine-panel failed" role="alert">
          <div className="refine-head">
            <TriangleAlert size={13} aria-hidden="true" />
            <strong>Refine failed</strong>
            {state.provider && state.model ? (
              <span className="refine-model-label">
                on {state.provider}/{state.model}
              </span>
            ) : null}
            <span>{state.error ?? 'Unknown error'}</span>
          </div>
          <div className="refine-actions">
            <button type="button" onClick={onRetry}>
              Retry
            </button>
            {state.fallbackRef && (
              <button type="button" onClick={() => onRetryFallback(state.fallbackRef ?? '')}>
                Try {state.fallbackRef}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setEditing(true);
                setEditText(state.original);
              }}
            >
              Edit
            </button>
            <button type="button" className="primary" onClick={() => onDecision('original')}>
              Send as-is
            </button>
          </div>
          {editing && (
            <div className="refine-edit">
              <textarea
                ref={editRef}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && editText.trim()) {
                    e.preventDefault();
                    e.stopPropagation();
                    onSendEdited(editText.trim());
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    // Restore the snapshot taken on entering edit mode so
                    // the user's typed draft survives cancellation.
                    setEditing(false);
                    setEditText(draftSnapshotRef.current);
                  }
                }}
                rows={3}
                aria-label="Edit prompt before sending"
              />
              <div className="refine-actions">
                <button type="button" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!editText.trim()}
                  onClick={() => onSendEdited(editText.trim())}
                >
                  Send edited
                </button>
              </div>
            </div>
          )}
        </div>
      );

    case 'ready': {
      if (editing) {
        return (
          <div className="refine-panel ready" role="dialog" aria-label="Edit refined prompt">
            <div className="refine-head">
              <Pencil size={13} aria-hidden="true" />
              <strong>Edit prompt</strong>
              {modelLabel}
            </div>
            <div className="refine-edit">
              <textarea
                ref={editRef}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && editText.trim()) {
                    e.preventDefault();
                    e.stopPropagation();
                    onSendEdited(editText.trim());
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    // Restore the snapshot taken on entering edit mode so
                    // the user's typed draft survives cancellation.
                    setEditing(false);
                    setEditText(draftSnapshotRef.current);
                  }
                }}
                rows={4}
                aria-label="Edit refined prompt"
              />
              <div className="refine-actions">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setEditText(state.refined);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!editText.trim()}
                  onClick={() => onSendEdited(editText.trim())}
                >
                  Send edited
                </button>
              </div>
            </div>
          </div>
        );
      }

      return (
        <div className="refine-panel ready" role="dialog" aria-label="Review refined prompt">
          <div className="refine-head">
            <Sparkles size={13} aria-hidden="true" />
            <strong>Refined prompt</strong>
            {modelLabel}
            <span className="refine-keys" aria-hidden="true">
              Enter send · {showEnglish ? 'E english · ' : ''}O original · T edit · R retry
            </span>
          </div>
          <div className="refine-compare">
            <div className="refine-column">
              <span>ORIGINAL</span>
              <p>{state.original}</p>
            </div>
            <div className="refine-column refined">
              <span>REFINED</span>
              <p>{state.refined}</p>
            </div>
          </div>
          {showEnglish && (
            <div className="refine-english">
              <span>ENGLISH</span>
              <p>{state.english}</p>
            </div>
          )}
          <div className="refine-actions">
            <button type="button" onClick={onRetry}>
              Try again better
            </button>
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" onClick={() => onDecision('original')}>
              Send original
            </button>
            {showEnglish && (
              <button type="button" onClick={() => onDecision('english')}>
                Send English
              </button>
            )}
            <button type="button" className="primary" onClick={() => onDecision('refined')}>
              Send refined
            </button>
          </div>
        </div>
      );
    }

    default:
      return assertNever(state.status);
  }
}

/** Exhaustiveness check — place in the `default` branch of a
 *  switch over a union type to get a compile-time error when a
 *  new variant is added but not handled. */
function assertNever(x: never): never {
  throw new Error(`Unhandled RefineStatus case: ${JSON.stringify(x)}`);
}
