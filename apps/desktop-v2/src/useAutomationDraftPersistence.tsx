import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  type AutomationDraft,
  activeDrafts,
  automationDraftCodec,
  automationDraftKey,
  jobDrafts,
  projectAutomationDrafts,
  type SavedAutomationDrafts,
} from './automation-draft';
import { useDesktopText } from './desktop-i18n';
import { DurableFormDraft } from './durable-form-draft';
import { projectFormDraftStorage } from './platform';

const stores = new Map<string, DurableFormDraft<SavedAutomationDrafts>>();
function automationDraftStore(projectId: string) {
  let store = stores.get(projectId);
  if (!store) {
    store = new DurableFormDraft(
      projectFormDraftStorage(projectId, 'automation-drafts'),
      automationDraftCodec,
    );
    stores.set(projectId, store);
  }
  return store;
}

/** Replace this window's drafts for the project with a saved set. */
function adopt(projectId: string, saved: SavedAutomationDrafts | null, keepExisting: boolean) {
  if (!keepExisting)
    for (const key of [...jobDrafts.keys()])
      if ((JSON.parse(key) as string[])[0] === projectId) jobDrafts.delete(key);
  for (const [id, draft] of Object.entries(saved?.drafts ?? {})) {
    const key = automationDraftKey(projectId, id);
    if (!keepExisting || !jobDrafts.has(key)) jobDrafts.set(key, draft);
  }
}

/**
 * Keeps the project's unsaved automation job drafts in native storage. A new window restores
 * the job that was open; drafts are removed as their saves succeed or they are discarded.
 * Call after the effect that records the in-window drafts.
 */
export function useAutomationDraftPersistence({
  projectId,
  activeId,
  restore,
}: {
  projectId: string;
  activeId: string | undefined;
  restore: (draft: AutomationDraft, updatedAt: number | undefined) => void;
}) {
  const store = useMemo(() => automationDraftStore(projectId), [projectId]);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const freshWindow = useRef(!activeDrafts.has(projectId)).current;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  // Nothing is written until the saved drafts were merged, so a load never erases them.
  const [hydrated, setHydrated] = useState<DurableFormDraft<SavedAutomationDrafts> | null>(null);
  useEffect(() => {
    let live = true;
    void store.load().then(() => {
      const saved = store.snapshot();
      if (!live || !saved.ready) return;
      if (saved.value) {
        adopt(projectId, saved.value, true);
        const open = saved.value.drafts[saved.value.active];
        if (freshWindow && open) restoreRef.current(open, saved.updatedAt);
      }
      setHydrated(store);
    });
    return () => {
      live = false;
    };
  }, [store, projectId, freshWindow]);
  // The in-window drafts live outside React state, so compare after every render.
  useEffect(() => {
    const current = store.snapshot();
    if (hydrated !== store || !current.ready || current.review) return;
    const next = projectAutomationDrafts(projectId, activeId);
    if (JSON.stringify(next) !== JSON.stringify(current.value)) store.edit(next);
  });
  const resolve = async (choice: 'local' | 'saved') => {
    const review = state.review?.value ?? null;
    if (!(await store.resolve(choice)) || choice === 'local') return;
    adopt(projectId, review, false);
    const open = review?.drafts[review.active];
    if (open) restoreRef.current(open, Date.now());
  };
  return { state, resolve, retry: () => void store.load() };
}

/** Load, save-failure and other-window states of the saved automation drafts. */
export function AutomationDraftPersistenceStatus({
  state,
  resolve,
  retry,
}: ReturnType<typeof useAutomationDraftPersistence>) {
  const { t } = useDesktopText();
  if (state.review)
    return (
      <div className="automation-draft-review" role="alert">
        <p className="automation-draft-review-text">
          {t('automation.otherWindow', {
            drafts: Object.keys(state.review.value?.drafts ?? {}).length,
          })}
        </p>
        <button type="button" className="button secondary" onClick={() => void resolve('local')}>
          {t('automation.keepWindow')}
        </button>
        <button type="button" className="button secondary" onClick={() => void resolve('saved')}>
          {t('automation.useSaved')}
        </button>
      </div>
    );
  if (state.error)
    return (
      <p className="session-error" role="alert">
        {state.error}{' '}
        {!state.ready && (
          <button type="button" className="text-link" onClick={retry}>
            {t('automation.retryDrafts')}
          </button>
        )}
      </p>
    );
  return null;
}
