import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react';
import { usePaneLayout } from './pane-layout-context';

const compactQuery = '(max-width: 619px)';
const compactSnapshot = () => window.matchMedia?.(compactQuery).matches ?? false;
const wideSnapshot = () => false;

function subscribeCompact(notify: () => void) {
  const media = window.matchMedia?.(compactQuery);
  media?.addEventListener('change', notify);
  return () => media?.removeEventListener('change', notify);
}

export function useWorkbenchExplorer(location: string) {
  const id = useId();
  const compact = useSyncExternalStore(subscribeCompact, compactSnapshot, wideSnapshot);
  const [wideOpen, setWideOpen] = useState(true);
  const [overlayFor, setOverlayFor] = useState<string | null>(null);
  const layout = usePaneLayout();
  const dockedOpen = layout?.panes.explorer.open ?? wideOpen;
  const setOpen = layout?.setOpen;
  const open = compact ? overlayFor === location : dockedOpen;
  const dismissOverlay = useCallback(() => setOverlayFor(null), []);
  useEffect(dismissOverlay, [location, compact, dismissOverlay]);

  const toggle = useCallback(() => {
    if (compact) setOverlayFor((current) => (current === location ? null : location));
    else if (setOpen) setOpen('explorer', !dockedOpen);
    else setWideOpen((current) => !current);
  }, [compact, location, setOpen, dockedOpen]);
  return {
    id,
    compact,
    open,
    toggle,
    dismissOverlay,
    width: layout?.panes.explorer.width,
    setWidth: layout?.setWidth,
  };
}

export type WorkbenchExplorer = ReturnType<typeof useWorkbenchExplorer>;
