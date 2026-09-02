import { useEffect, useRef } from 'react';
import {
  isChipExpired,
  type ChipMeta,
  type StatuslineItem,
} from '../components/statusline-picker.js';

type StreamChipAction =
  | { type: 'statuslineChipShow'; key: StatuslineItem; expiresIn: number }
  | { type: 'statuslineChipExpire'; key: StatuslineItem };

export function computeStreamChipActions(input: {
  brainPromptNow: boolean;
  brainPromptPrev: boolean;
  enhanceNow: boolean;
  enhancePrev: boolean;
  visibleChipKeys: readonly StatuslineItem[];
}): StreamChipAction[] {
  const actions: StreamChipAction[] = [];
  const visible = new Set(input.visibleChipKeys);

  if (input.brainPromptNow && !input.brainPromptPrev) {
    actions.push({ type: 'statuslineChipShow', key: 'brain', expiresIn: 5 });
  } else if (!input.brainPromptNow && input.brainPromptPrev && visible.has('brain')) {
    actions.push({ type: 'statuslineChipExpire', key: 'brain' });
  }

  if (input.enhanceNow && !input.enhancePrev) {
    actions.push({ type: 'statuslineChipShow', key: 'enhance', expiresIn: 5 });
  } else if (!input.enhanceNow && input.enhancePrev && visible.has('enhance')) {
    actions.push({ type: 'statuslineChipExpire', key: 'enhance' });
  }

  return actions;
}

export function computeExpiredChipKeys(
  chips: readonly ChipMeta[],
  now = Date.now(),
): StatuslineItem[] {
  return chips.filter((chip) => isChipExpired(chip, now)).map((chip) => chip.key);
}

interface UseStreamChipExpirationOptions {
  brainPrompt: unknown;
  enhance: unknown;
  visibleChips: readonly ChipMeta[];
  dispatch: (action: StreamChipAction) => void;
}

export function useStreamChipExpiration({
  brainPrompt,
  enhance,
  visibleChips,
  dispatch,
}: UseStreamChipExpirationOptions): void {
  const prevBrainPromptRef = useRef(brainPrompt);
  const prevEnhanceRef = useRef(enhance);

  useEffect(() => {
    const actions = computeStreamChipActions({
      brainPromptNow: !!brainPrompt,
      brainPromptPrev: !!prevBrainPromptRef.current,
      enhanceNow: !!enhance,
      enhancePrev: !!prevEnhanceRef.current,
      visibleChipKeys: visibleChips.map((chip) => chip.key),
    });
    for (const action of actions) dispatch(action);
    prevBrainPromptRef.current = brainPrompt;
    prevEnhanceRef.current = enhance;
  }, [brainPrompt, enhance, visibleChips, dispatch]);

  useEffect(() => {
    const interval = setInterval(() => {
      const expired = computeExpiredChipKeys(visibleChips, Date.now());
      for (const key of expired) {
        dispatch({ type: 'statuslineChipExpire', key });
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [visibleChips, dispatch]);
}
