'use client';

import { useCallback, useState } from 'react';

export interface ModelTarget {
  provider: string;
  model: string;
  context: number;
}

/**
 * What choosing a model should do: nothing for the current model, ask first
 * when the target's known context window is smaller than the current one
 * (switching may compact), otherwise switch right away.
 */
export function modelChoiceAction(
  current: { provider: string; model: string; maxContext: number },
  target: ModelTarget,
): 'none' | 'confirm' | 'switch' {
  if (target.provider === current.provider && target.model === current.model) return 'none';
  if (target.context > 0 && current.maxContext > target.context) return 'confirm';
  return 'switch';
}

/** Model picker flow with the smaller-context confirmation step. */
export function useModelChoice(input: {
  provider: string;
  model: string;
  maxContext: number;
  switchModel: (provider: string, model: string) => void;
  send: (type: string) => void;
}) {
  const { provider, model, maxContext, switchModel, send } = input;
  const [pending, setPending] = useState<ModelTarget | null>(null);
  const chooseModel = useCallback(
    (nextProvider: string, nextModel: string, context: number) => {
      const target = { provider: nextProvider, model: nextModel, context };
      const action = modelChoiceAction({ provider, model, maxContext }, target);
      if (action === 'confirm') setPending(target);
      else if (action === 'switch') switchModel(nextProvider, nextModel);
    },
    [provider, model, maxContext, switchModel],
  );
  const refreshModels = useCallback(() => {
    send('providers.saved');
    send('providers.list');
  }, [send]);
  const confirmPending = useCallback(() => {
    if (pending) switchModel(pending.provider, pending.model);
    setPending(null);
  }, [pending, switchModel]);
  const cancelPending = useCallback(() => setPending(null), []);
  return { smallerModel: pending, chooseModel, refreshModels, confirmPending, cancelPending };
}
