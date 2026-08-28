import { DefaultSecretScrubber } from '@wrongstack/core/security';
import { INPUT_HISTORY_DEFAULT_MAX, InputHistoryStore } from '@wrongstack/core/storage';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { useEffect, useMemo, useRef } from 'react';
import type { Action, State } from '../app-reducer.js';

interface UseInputHistoryPersistenceOptions {
  projectRoot: string;
  inputHistory: State['inputHistory'];
  dispatch: React.Dispatch<Action>;
}

/**
 * Per-project prompt history persistence.
 *
 * Loads prompt history from `projectInputHistory` on mount and saves it back
 * with a 200ms debounce whenever the in-memory list changes.
 */
export function useInputHistoryPersistence({
  projectRoot,
  inputHistory,
  dispatch,
}: UseInputHistoryPersistenceOptions): void {
  const inputHistoryStore = useMemo(() => {
    if (!projectRoot) return null;
    const file = resolveWstackPaths({ projectRoot }).projectInputHistory;
    return new InputHistoryStore(file, new DefaultSecretScrubber(), INPUT_HISTORY_DEFAULT_MAX);
  }, [projectRoot]);

  const inputHistoryLoadedRef = useRef(false);
  const inputHistorySaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputHistoryLastSavedRef = useRef<string>('');

  useEffect(() => {
    if (!inputHistoryStore) return;
    let cancelled = false;
    inputHistoryStore
      .load()
      .then((entries) => {
        if (cancelled) return;
        inputHistoryLoadedRef.current = true;
        inputHistoryLastSavedRef.current = JSON.stringify(entries);
        if (entries.length === 0) return;
        dispatch({ type: 'setInputHistory', entries });
      })
      .catch(() => {
        if (!cancelled) inputHistoryLoadedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [inputHistoryStore, dispatch]);

  useEffect(() => {
    if (!inputHistoryStore || !inputHistoryLoadedRef.current) return;
    const snapshot = JSON.stringify(inputHistory);
    if (snapshot === inputHistoryLastSavedRef.current) return;
    if (inputHistorySaveTimerRef.current) clearTimeout(inputHistorySaveTimerRef.current);
    inputHistorySaveTimerRef.current = setTimeout(() => {
      inputHistoryLastSavedRef.current = snapshot;
      inputHistoryStore.save(inputHistory).catch(() => {
        // Best-effort persistence; a failed write does not disrupt the UI.
        // The next change will retry.
      });
    }, 200);
    return () => {
      if (inputHistorySaveTimerRef.current) clearTimeout(inputHistorySaveTimerRef.current);
    };
  }, [inputHistory, inputHistoryStore]);
}
