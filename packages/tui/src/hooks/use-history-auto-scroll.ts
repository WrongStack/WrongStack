import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { HistoryScrollController } from '../components/scrollable-history.js';

/**
 * Gives a reader a short window to inspect older chat output, then returns
 * the managed history viewport to the live tail. Keeping this in App makes
 * the timeout independent of ScrollableHistory remounts and layout changes.
 */
export const HISTORY_AUTO_SCROLL_DELAY_MS = 30_000;

export function useHistoryAutoScroll({
  historyScrolled,
  historyScrollRef,
}: {
  historyScrolled: boolean;
  historyScrollRef: MutableRefObject<HistoryScrollController | null>;
}): () => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      historyScrollRef.current?.scrollToBottom();
    }, HISTORY_AUTO_SCROLL_DELAY_MS);
  }, [historyScrollRef]);

  useEffect(() => {
    if (!historyScrolled) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      return undefined;
    }

    schedule();
    return undefined;
  }, [historyScrolled, schedule]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return useCallback(() => {
    if (historyScrolled) schedule();
  }, [historyScrolled, schedule]);
}
