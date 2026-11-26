import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';
import {
  clampPaneWidth,
  decodePaneLayout,
  defaultPaneLayout,
  type PaneId,
  type PaneLayout,
  paneBounds,
  paneStorageKey,
} from './pane-layout';

type LayoutControls = {
  panes: PaneLayout;
  setOpen: (id: PaneId, open: boolean) => void;
  setWidth: (id: PaneId, width: number) => void;
  apply: (panes: PaneLayout) => void;
  storageFailed: boolean;
  showSettings: () => void;
};

const PaneLayoutContext = createContext<LayoutControls | null>(null);

export function usePaneLayout() {
  return useContext(PaneLayoutContext);
}

export function PaneLayoutProvider({
  scope,
  children,
  showSettings,
}: {
  scope: string;
  children: ReactNode;
  showSettings: () => void;
}) {
  const key = paneStorageKey(scope);
  const [panes, setPanes] = useState(() => {
    try {
      return decodePaneLayout(window.localStorage.getItem(key));
    } catch {
      return defaultPaneLayout;
    }
  });
  const [storageFailed, setStorageFailed] = useState(false);
  // Commit synchronously on explicit layout actions, so immediate reload retains the change.
  // The splitter previews during drag and commits once on release.
  const apply = useCallback(
    (next: PaneLayout) => {
      setPanes(next);
      try {
        window.localStorage.setItem(key, JSON.stringify({ version: 1, panes: next }));
        setStorageFailed(false);
      } catch {
        setStorageFailed(true);
      }
    },
    [key],
  );
  const setOpen = (id: PaneId, open: boolean) => {
    if (panes[id].open !== open) apply({ ...panes, [id]: { ...panes[id], open } });
  };
  const setWidth = (id: PaneId, width: number) => {
    if (!Number.isFinite(width)) return;
    const { min, max } = paneBounds[id];
    const bounded = clampPaneWidth(width, min, max);
    if (panes[id].width !== bounded) apply({ ...panes, [id]: { ...panes[id], width: bounded } });
  };
  return (
    <PaneLayoutContext.Provider
      value={{ panes, setOpen, setWidth, apply, storageFailed, showSettings }}
    >
      {children}
    </PaneLayoutContext.Provider>
  );
}
