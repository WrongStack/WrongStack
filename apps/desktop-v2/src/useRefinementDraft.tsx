import { Sparkles } from 'lucide-react';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { DurableFormDraft, type FormDraftStorage } from './durable-form-draft';
import { type RefinementDraft, refinementDraftCodec } from './refinement-draft';

const noSubscription = () => () => {};
const noSnapshot = () => null;

/**
 * Keeps a refinement review in native session storage until it is applied, sent or discarded.
 * A request still waiting for the refiner is kept as pending, so after a restart it can be run
 * again; the reply itself is lost with the window that was waiting for it.
 */
export function useRefinementDraft(storage: FormDraftStorage | undefined) {
  const store = useMemo(
    () => (storage ? new DurableFormDraft(storage, refinementDraftCodec) : null),
    [storage],
  );
  const state = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.snapshot ?? noSnapshot,
  );
  useEffect(() => {
    void store?.load();
  }, [store]);
  const writable = () => {
    const current = store?.snapshot();
    return current?.ready && !current.review ? store : null;
  };
  return {
    saved: state?.ready ? state.value : null,
    state,
    /** False when the draft was not taken: a new request never replaces a saved reply. */
    save: (draft: RefinementDraft): boolean => {
      const target = writable();
      if (draft.pending && target?.snapshot().value?.result) return false;
      if (target && JSON.stringify(target.snapshot().value) !== JSON.stringify(draft))
        target.edit(draft);
      return true;
    },
    clear: () => {
      const target = writable();
      if (target?.snapshot().value) target.edit(null);
    },
    resolve: (choice: 'local' | 'saved') => void store?.resolve(choice),
  };
}

/** The saved review offered in the composer while no refinement dialog is open. */
export function SavedRefinementNotice({
  draft,
  onOpen,
}: {
  draft: ReturnType<typeof useRefinementDraft>;
  onOpen: (saved: RefinementDraft) => void;
}) {
  if (draft.state?.review)
    return (
      <div className="composer-notice" role="alert">
        Another window changed the saved refinement review.
        <button type="button" className="text-link" onClick={() => draft.resolve('saved')}>
          Use saved review
        </button>
        <button type="button" className="text-link" onClick={() => draft.resolve('local')}>
          Keep this window’s
        </button>
      </div>
    );
  const saved = draft.saved;
  if (!saved) return null;
  if (saved.pending)
    return (
      <div className="composer-notice" role="status">
        <Sparkles size={13} />A prompt refinement started {new Date(saved.savedAt).toLocaleString()}{' '}
        was interrupted before the refiner answered.
        <button type="button" className="text-link" onClick={() => onOpen(saved)}>
          Refine again
        </button>
        <button type="button" className="text-link" onClick={draft.clear}>
          Discard
        </button>
      </div>
    );
  return (
    <div className="composer-notice" role="status">
      <Sparkles size={13} />A refined prompt from {new Date(saved.savedAt).toLocaleString()} is
      waiting for review.
      <button type="button" className="text-link" onClick={() => onOpen(saved)}>
        Review refined prompt
      </button>
      <button type="button" className="text-link" onClick={draft.clear}>
        Discard refined prompt
      </button>
    </div>
  );
}
