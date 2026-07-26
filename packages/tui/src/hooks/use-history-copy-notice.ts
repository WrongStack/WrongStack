import { useCallback, useEffect, useRef, type Dispatch } from 'react';
import type { Action } from '../app-reducer.js';

export function useHistoryCopyNotice(dispatch: Dispatch<Action>): (entryId: number) => void {
  const copiedHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onHistoryCopy = useCallback(
    (entryId: number) => {
      dispatch({ type: 'copiedNotice', text: '✓ Copied', entryId });
      if (copiedHintTimerRef.current) clearTimeout(copiedHintTimerRef.current);
      copiedHintTimerRef.current = setTimeout(() => {
        dispatch({ type: 'copiedNotice', text: '', entryId: null });
        copiedHintTimerRef.current = null;
      }, 2_000);
    },
    [dispatch],
  );

  useEffect(
    () => () => {
      if (copiedHintTimerRef.current) clearTimeout(copiedHintTimerRef.current);
    },
    [],
  );

  return onHistoryCopy;
}
