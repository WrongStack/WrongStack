import { useEffect, useState } from 'react';
import {
  environmentDraftCodec,
  environmentDraftKey,
  type SavedEnvironmentDraft,
} from './automation-environment-draft';
import type { EnvironmentDraft } from './automation-environment-model';
import { DurableFormDraft } from './durable-form-draft';
import { projectFormDraftStorage } from './platform';
import { sameSetting } from './settings-save-model';

/**
 * Keeps unapplied environment dialog edits for one job in native project storage. Edits made
 * from the environment the job still has are restored; edits made from an older one are offered
 * instead of applied. Applying or discarding removes them.
 */
export function useEnvironmentDraft({
  projectId,
  jobId,
  base,
  draft,
  dirty,
  restore,
}: {
  projectId: string;
  jobId: string | undefined;
  base: EnvironmentDraft;
  draft: EnvironmentDraft;
  dirty: boolean;
  restore: (draft: EnvironmentDraft, savedAt: number | undefined) => void;
}) {
  const [store, setStore] = useState<DurableFormDraft<SavedEnvironmentDraft> | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [older, setOlder] = useState<SavedEnvironmentDraft | null>(null);
  // The dialog binds to the job and environment it opened with.
  useEffect(() => {
    let live = true;
    void environmentDraftKey(projectId, jobId).then(async (key) => {
      const next = new DurableFormDraft(
        projectFormDraftStorage(projectId, key),
        environmentDraftCodec,
      );
      await next.load();
      if (!live) return;
      const saved = next.snapshot();
      if (saved.ready && saved.value) {
        if (sameSetting(saved.value.base, base)) restore(saved.value.draft, saved.updatedAt);
        else setOlder(saved.value);
      }
      setStore(next);
      setHydrated(saved.ready);
    });
    return () => {
      live = false;
    };
  }, [projectId, jobId]);
  useEffect(() => {
    const current = store?.snapshot();
    if (!store || !hydrated || older || !current?.ready || current.review) return;
    const next = dirty ? { base, draft } : null;
    if (JSON.stringify(next) !== JSON.stringify(current.value)) store.edit(next);
  });
  const forget = () => {
    if (store?.snapshot().ready && !store.snapshot().review) store.edit(null);
  };
  return {
    older,
    error: store?.snapshot().error ?? '',
    takeOlder: () => {
      if (older) restore(older.draft, undefined);
      setOlder(null);
    },
    discardOlder: () => {
      setOlder(null);
      forget();
    },
    /** After Apply or an explicit discard of the dialog's edits. */
    forget,
  };
}
