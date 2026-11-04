import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { type DesignEditDraft, designEditCodec, designEditEmpty } from './design-edit-draft';
import { useDesktopText } from './desktop-i18n';
import { DurableFormDraft, type FormDraftSnapshot } from './durable-form-draft';
import { request } from './platform';

type Edits = Omit<DesignEditDraft, 'kit'>;
const drafts = new Map<string, DurableFormDraft<DesignEditDraft>>();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Keeps unsaved Design Studio edits in this project's native storage. Edits for
 * the active kit come back after a reload; edits for a kit that is no longer
 * active are reported and never applied to the new kit.
 */
export function useDesignEditDraft(
  projectId: string,
  activeKit: string,
  edits: Edits,
  apply: (edits: Edits) => void,
) {
  const controller = useMemo(() => {
    let draft = drafts.get(projectId);
    if (!draft) {
      const place = { projectId, formKey: 'design-edits' };
      draft = new DurableFormDraft(
        {
          get: () => request<FormDraftSnapshot>('form-draft.get', place),
          save: async (value, expectedRevision) =>
            (
              await request<{ revision: number }>('form-draft.save', {
                ...place,
                value,
                expectedRevision,
              })
            ).revision,
        },
        designEditCodec,
      );
      drafts.set(projectId, draft);
    }
    return draft;
  }, [projectId]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [hydrated, setHydrated] = useState(false);
  const [restored, setRestored] = useState(false);
  const [stale, setStale] = useState<DesignEditDraft | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (!activeKit || hydrated) return;
    let active = true;
    void controller.load().then(() => {
      if (!active || !controller.snapshot().ready) return;
      const saved = controller.snapshot().value;
      if (saved?.kit === activeKit) {
        applyRef.current({ colors: saved.colors, baseline: saved.baseline, tune: saved.tune });
        setRestored(true);
      } else if (saved) setStale(saved);
      setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [controller, activeKit, hydrated]);
  // Persist after every change, including the clears that follow a verified save or discard.
  useEffect(() => {
    if (!hydrated || stale || !activeKit || state.review) return;
    const next = designEditEmpty(edits) ? null : { kit: activeKit, ...edits };
    if (same(next, controller.snapshot().value)) return;
    controller.edit(next);
  }, [hydrated, stale, activeKit, edits, state.review, controller]);
  return {
    state,
    restored: restored && !designEditEmpty(edits),
    stale,
    discardStale: () => {
      setStale(null);
      controller.edit(null);
    },
    resolve: async (choice: 'local' | 'saved') => {
      const saved = state.review?.value;
      const ok = await controller.resolve(choice);
      if (ok && choice === 'saved')
        applyRef.current(
          saved && saved.kit === activeKit
            ? { colors: saved.colors, baseline: saved.baseline, tune: saved.tune }
            : { colors: {}, baseline: null, tune: {} },
        );
    },
  };
}

export function DesignEditDraftNotice({ draft }: { draft: ReturnType<typeof useDesignEditDraft> }) {
  const { state, stale, restored } = draft;
  const { t } = useDesktopText();
  return (
    <>
      {state.error && (
        <p className="composer-error" role="alert">
          {state.error}
        </p>
      )}
      {state.review && (
        <section className="design-draft-notice" aria-label={t('designStudio.conflictLabel')}>
          <span>{t('designStudio.conflict')}</span>
          <button
            type="button"
            className="button secondary small"
            onClick={() => void draft.resolve('local')}
          >
            {t('designStudio.keepLocal')}
          </button>
          <button
            type="button"
            className="button secondary small"
            onClick={() => void draft.resolve('saved')}
          >
            {t('designStudio.useSaved')}
          </button>
        </section>
      )}
      {stale && (
        <section className="design-draft-notice" aria-label={t('designStudio.staleLabel')}>
          <span>{t('designStudio.stale', { kit: stale.kit })}</span>
          <button type="button" className="button secondary small" onClick={draft.discardStale}>
            {t('designStudio.discardStale')}
          </button>
        </section>
      )}
      {restored && !stale && !state.review && (
        <p className="design-draft-status" role="status">
          {t('designStudio.restored')}
        </p>
      )}
    </>
  );
}
