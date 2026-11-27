import type { MemoryPort } from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { useEffect, useRef } from 'react';
import type { Action } from '../app-reducer.js';

/** Debounce for filter keystrokes, mirroring use-file-search's cadence. */
const MEMORY_FILTER_DEBOUNCE_MS = 150;
/** Ceiling so a huge memory store can't dump thousands of rows into the panel. */
const MEMORY_PANEL_LIMIT = 200;

interface UseMemoryPanelOptions {
  dispatch: React.Dispatch<Action>;
  memoryStore: MemoryPort | undefined;
  open: boolean;
  filter: string;
}

/**
 * Loads the memory browser's entries whenever the panel is open and the filter
 * changes. A generation guard drops stale async results (a slow `search` that
 * resolves after a newer keystroke or after the panel closed must not overwrite
 * fresher state). Filter input is debounced; opening with an empty filter loads
 * immediately. Browse-only: this hook never writes to the store.
 */
export function useMemoryPanel({
  dispatch,
  memoryStore,
  open,
  filter,
}: UseMemoryPanelOptions): void {
  const generationRef = useRef(0);

  useEffect(() => {
    if (!open || !memoryStore) {
      // Invalidate any in-flight load so a result resolving after close is dropped.
      generationRef.current += 1;
      return;
    }
    const store = memoryStore;
    const generation = ++generationRef.current;
    const query = filter.trim();

    const run = async (): Promise<void> => {
      try {
        const entries = query
          ? await store.search(query, undefined, MEMORY_PANEL_LIMIT)
          : await store.list(undefined, MEMORY_PANEL_LIMIT);
        if (generation !== generationRef.current) return;
        dispatch({ type: 'memoryPanelSetEntries', entries });
      } catch (error) {
        if (generation !== generationRef.current) return;
        dispatch({ type: 'memoryPanelSetEntries', entries: [] });
        dispatch({
          type: 'memoryPanelHint',
          text: `Failed to load memory: ${toErrorMessage(error)}`,
        });
      }
    };

    const timer = setTimeout(() => void run(), query ? MEMORY_FILTER_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [open, filter, memoryStore, dispatch]);
}
