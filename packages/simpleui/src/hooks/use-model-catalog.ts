import { useCallback, useEffect, useMemo, useState } from 'react';
import { planModelSwitch } from '../lib/model-switch.js';
import { visibleModelGroups } from '../lib/model-catalog-view.js';
import type { SimpleSocket } from '../lib/ws.js';
import type { ModelDescriptor, SessionInfo } from '../types.js';

export interface PendingModelSwitch {
  provider: string;
  model: string;
  modelName: string;
  currentWindow: number;
  nextWindow: number;
}

export interface UseModelCatalogOptions {
  session: SessionInfo | null;
  contextMaxContext: number;
  running: boolean;
  socketRef: React.RefObject<SimpleSocket | null>;
  requestedModelsRef: React.RefObject<Set<string>>;
}

export interface UseModelCatalogResult {
  models: Record<string, ModelDescriptor[]>;
  setModels: React.Dispatch<React.SetStateAction<Record<string, ModelDescriptor[]>>>;
  providerLabels: Record<string, string>;
  setProviderLabels: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  groupedModels: [string, ModelDescriptor[]][];
  selectedModel: string;
  pendingModelSwitch: PendingModelSwitch | null;
  setPendingModelSwitch: React.Dispatch<React.SetStateAction<PendingModelSwitch | null>>;
  selectModel: (provider: string, model: string) => void;
  confirmModelSwitch: () => void;
  /** Dismiss the pending smaller-context warning without switching. */
  cancelModelSwitch: () => void;
  requestProviderModels: (providerId: string) => void;
}

/**
 * Owns the SimpleUI model catalog: provider model lists, the pending
 * smaller-context switch warning, and the select/confirm/cancel flow.
 *
 * Behavioural contract (must survive the PR-4 extraction from `app.tsx`):
 *  - `groupedModels` filters out providers whose model list is empty.
 *  - `selectedModel` is `""` when no session, otherwise `"provider\tmodel"`.
 *  - `selectModel` routes through `planModelSwitch`:
 *    - `noop` (same model) → nothing happens.
 *    - `send` (larger/equal context) → `model.switch` frame immediately.
 *    - `warn` (smaller context) → `pendingModelSwitch` is set; the user must confirm.
 *  - `running === true` auto-clears the pending warning (the session moved on).
 *  - `Escape` clears the pending warning.
 *  - `requestProviderModels` sends `provider.models` at most once per provider
 *    (guarded by `requestedModelsRef`).
 *  - `setModels` and `setProviderLabels` are exposed for the message handler
 *    so `provider.catalog` / `provider.models` frames can populate the catalog.
 */
export function useModelCatalog(options: UseModelCatalogOptions): UseModelCatalogResult {
  const { session, contextMaxContext, running, socketRef, requestedModelsRef } = options;

  const [models, setModels] = useState<Record<string, ModelDescriptor[]>>({});
  const [providerLabels, setProviderLabels] = useState<Record<string, string>>({});
  const [pendingModelSwitch, setPendingModelSwitch] = useState<PendingModelSwitch | null>(null);

  // Chat-capable + de-duplicated view of the raw catalog (see
  // model-catalog-view): a real install lists 1000+ entries including
  // embeddings, image generators and safety classifiers that can never serve
  // a chat turn, and catalog merges can append a provider list twice.
  const groupedModels = useMemo(() => visibleModelGroups(models), [models]);

  const selectedModel = session ? `${session.provider}\t${session.model}` : '';

  const selectModel = useCallback(
    (provider: string, model: string) => {
      if (!session) return;
      const plan = planModelSwitch({
        models,
        currentProvider: session.provider,
        currentModel: session.model,
        sessionMaxContext: session.maxContext || contextMaxContext,
        nextProvider: provider,
        nextModel: model,
      });
      if (plan.kind === 'noop') return;
      if (plan.kind === 'warn') {
        setPendingModelSwitch({
          provider,
          model,
          modelName: plan.modelName,
          currentWindow: plan.currentWindow,
          nextWindow: plan.nextWindow,
        });
        return;
      }
      socketRef.current?.send('model.switch', { provider, model });
    },
    [session, models, contextMaxContext, socketRef],
  );

  const confirmModelSwitch = useCallback(() => {
    setPendingModelSwitch((current) => {
      if (!current) return null;
      socketRef.current?.send('model.switch', {
        provider: current.provider,
        model: current.model,
      });
      return null;
    });
  }, [socketRef]);

  const cancelModelSwitch = useCallback(() => setPendingModelSwitch(null), []);

  const requestProviderModels = useCallback(
    (providerId: string) => {
      if (requestedModelsRef.current.has(providerId)) return;
      requestedModelsRef.current.add(providerId);
      socketRef.current?.send('provider.models', { providerId });
    },
    [requestedModelsRef, socketRef],
  );

  // The pending smaller-context warning is stale once the session moves on
  // (switch confirmed elsewhere, session resumed) or a run starts.
  useEffect(() => {
    if (!pendingModelSwitch) return;
    if (running) setPendingModelSwitch(null);
  }, [pendingModelSwitch, running]);

  // Escape clears the pending warning.
  useEffect(() => {
    if (!pendingModelSwitch) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        event.preventDefault();
        setPendingModelSwitch(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pendingModelSwitch]);

  return {
    models,
    setModels,
    providerLabels,
    setProviderLabels,
    groupedModels,
    selectedModel,
    pendingModelSwitch,
    setPendingModelSwitch,
    selectModel,
    confirmModelSwitch,
    cancelModelSwitch,
    requestProviderModels,
  };
}
