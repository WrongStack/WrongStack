/**
 * Generic model-pick request — the reusable side of the /model overlay.
 *
 * `requestModelPick(title)` opens the SAME two-step provider→model picker
 * as the /model command, but in purpose 'pick': Enter RESOLVES the returned
 * promise with the selection instead of switching the session model, and
 * every close path (Esc at step 1, global overlay close, a competing open)
 * resolves null. Callers: the Brain panel (pool/voters/judge) — and any
 * future surface that needs a model choice.
 */

import React from 'react';
import type { Action } from '../app-action-type.js';

export type ModelPickSelection = { providerId: string; model: string } | null;

interface UseModelPickRequestOptions {
  dispatch: React.Dispatch<Action>;
  getPickableProviders?:
    | (() => Promise<Array<{ id: string; family: string; models: string[] }>>)
    | undefined;
  /** Live `state.modelPicker.open` — closes without a pick resolve null. */
  pickerOpen: boolean;
}

export interface ModelPickRequestController {
  /** Open the shared picker; resolves with the choice or null on cancel. */
  requestModelPick: (title: string) => Promise<ModelPickSelection>;
  /** Wired into the key hook as `onModelPicked` (purpose 'pick' Enter). */
  handleModelPicked: (providerId: string, modelId: string) => void;
}

export function useModelPickRequest(opts: UseModelPickRequestOptions): ModelPickRequestController {
  const { dispatch, getPickableProviders, pickerOpen } = opts;
  const resolverRef = React.useRef<((sel: ModelPickSelection) => void) | null>(null);

  const requestModelPick = React.useCallback(
    async (title: string): Promise<ModelPickSelection> => {
      if (!getPickableProviders) return null;
      // A pending pick must not leak: a second request cancels the first.
      resolverRef.current?.(null);
      const providers = await getPickableProviders();
      return new Promise((resolve) => {
        resolverRef.current = resolve;
        dispatch({ type: 'modelPickerOpen', providers, purpose: 'pick', title });
      });
    },
    [dispatch, getPickableProviders],
  );

  const handleModelPicked = React.useCallback((providerId: string, modelId: string) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.({ providerId, model: modelId });
  }, []);

  React.useEffect(() => {
    // Any close without an explicit pick (Esc, global overlay close, a
    // /model reopen) cancels the pending request.
    if (!pickerOpen && resolverRef.current) {
      const resolve = resolverRef.current;
      resolverRef.current = null;
      resolve(null);
    }
  }, [pickerOpen]);

  return { requestModelPick, handleModelPicked };
}
