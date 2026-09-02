/**
 * Disclosure state for transcript cards, held OUTSIDE the card.
 *
 * The transcript is virtualized (virtua `VList`), so scrolling a card out of
 * view unmounts it. While the open/closed flag lived in the card's own
 * `useState`, that unmount silently discarded it: an operator who expanded a
 * tool result, scrolled up to re-read the plan, and scrolled back found every
 * card closed again.
 *
 * The flag therefore lives in a provider above the list, keyed by the same
 * stable turn key the list already uses for its React keys. Without a provider
 * (unit tests rendering a single turn) each card falls back to local state, so
 * the component still works standalone.
 */
import type * as React from 'react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

type TranscriptExpansion = {
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
};

const TranscriptExpansionContext = createContext<TranscriptExpansion | null>(null);

export function TranscriptExpansionProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = useCallback((key: string) => {
    setOpen((current) => ({ ...current, [key]: current[key] !== true }));
  }, []);
  const value = useMemo<TranscriptExpansion>(
    () => ({ isOpen: (key) => open[key] === true, toggle }),
    [open, toggle],
  );
  return (
    <TranscriptExpansionContext.Provider value={value}>
      {children}
    </TranscriptExpansionContext.Provider>
  );
}

/**
 * `[open, toggle]` for one card. Shared through the provider when a stable key
 * is available, local otherwise. Cards are always collapsed to begin with.
 */
export function useTranscriptDisclosure(key: string | undefined): [boolean, () => void] {
  const shared = useContext(TranscriptExpansionContext);
  const [local, setLocal] = useState(false);
  const toggleLocal = useCallback(() => setLocal((current) => !current), []);
  if (shared !== null && key !== undefined) {
    return [shared.isOpen(key), () => shared.toggle(key)];
  }
  return [local, toggleLocal];
}
