import { Sparkles } from 'lucide-react';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { DurableFormDraft, type FormDraftStorage } from './durable-form-draft';
import { type RefinementDraft, refinementDraftCodec } from './refinement-draft';

const noSubscription = () => () => {};
const noSnapshot = () => null;

/**
 * Keeps a completed refinement review in native session storage until it is applied, sent or
 * discarded. A request still waiting for the refiner cannot survive a restart; only a reply
 * that has arrived is kept.
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
    save: (draft: RefinementDraft) => {
      const target = writable();
      if (target && JSON.stringify(target.snapshot().value) !== JSON.stringify(draft))
        target.edit(draft);
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
