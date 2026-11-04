import { Sparkles } from 'lucide-react';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useDesktopText } from './desktop-i18n';
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
  const { t } = useDesktopText();
  if (draft.state?.review)
    return (
      <div className="composer-notice" role="alert">
        {t('savedRefine.conflict')}
        <button type="button" className="text-link" onClick={() => draft.resolve('saved')}>
          {t('savedRefine.useSaved')}
        </button>
        <button type="button" className="text-link" onClick={() => draft.resolve('local')}>
          {t('savedRefine.keepLocal')}
        </button>
      </div>
    );
  const saved = draft.saved;
  if (!saved) return null;
  if (saved.pending)
    return (
      <div className="composer-notice" role="status">
        <Sparkles size={13} />
        {t('savedRefine.pending', { at: new Date(saved.savedAt).toLocaleString() })}
        <button type="button" className="text-link" onClick={() => onOpen(saved)}>
          {t('savedRefine.refineAgain')}
        </button>
        <button type="button" className="text-link" onClick={draft.clear}>
          {t('savedRefine.discard')}
        </button>
      </div>
    );
  return (
    <div className="composer-notice" role="status">
      <Sparkles size={13} />
      {t('savedRefine.waiting', { at: new Date(saved.savedAt).toLocaleString() })}
      <button type="button" className="text-link" onClick={() => onOpen(saved)}>
        {t('savedRefine.review')}
      </button>
      <button type="button" className="text-link" onClick={draft.clear}>
        {t('savedRefine.discardRefined')}
      </button>
    </div>
  );
}
