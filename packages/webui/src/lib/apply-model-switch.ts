import { memorySessionSnapshots, useSessionStore } from '@/stores/session-store';

export interface ModelSwitchTarget {
  provider: string;
  model: string;
  /** Effort levels the picked model documents, when the catalog knows them. */
  reasoningEffortLevels?: string[] | undefined;
  effortSupported?: boolean | undefined;
}

/**
 * Mirror an accepted `model.switch` into this tab's session state, so the composer chip and
 * the effort control follow the new model before the authoritative snapshot arrives. Shared
 * by the composer's quick switcher and the full model switcher.
 */
export function applyModelSwitch(target: ModelSwitchTarget): void {
  const store = useSessionStore.getState();
  const current = store.session;
  if (!current) return;
  store.setSession({ ...current, provider: target.provider, model: target.model });
  // The route-change reset in setSession cleared the previous model's effort vocabulary.
  if (target.reasoningEffortLevels || target.effortSupported !== undefined) {
    store.setEnv({
      reasoningEffortLevels: target.reasoningEffortLevels,
      effortSupported: target.effortSupported,
    });
  }
  const snapshot = memorySessionSnapshots.get(current.id);
  if (snapshot) {
    snapshot.provider = target.provider;
    snapshot.model = target.model;
    if (snapshot.session) {
      snapshot.session.provider = target.provider;
      snapshot.session.model = target.model;
    }
  }
}
