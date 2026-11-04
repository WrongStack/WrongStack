import { useEffect, useState } from 'react';

/**
 * Quiet period before a search edit reloads the library page. The in-page
 * filter still narrows the loaded rows on every keystroke; only the server
 * round-trip waits for the operator to pause typing.
 */
export const SEARCH_RELOAD_DEBOUNCE_MS = 250;

/**
 * The trimmed query the library page should be loaded for. Typing settles
 * after {@link SEARCH_RELOAD_DEBOUNCE_MS}; clearing the box applies at once.
 */
export function useDebouncedListQuery(searchQuery: string): string {
  const [listQuery, setListQuery] = useState(() => searchQuery.trim());
  useEffect(() => {
    const next = searchQuery.trim();
    if (next.length === 0) {
      setListQuery('');
      return;
    }
    const timer = setTimeout(() => setListQuery(next), SEARCH_RELOAD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  return listQuery;
}
