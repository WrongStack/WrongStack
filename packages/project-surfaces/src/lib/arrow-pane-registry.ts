/**
 * Arrow-key pane registry.
 *
 * Opt-in registry of scrollable panes (tree sidebars, virtualized lists, …)
 * that want native ArrowUp/ArrowDown scrolling. A pane registers its scroll
 * container on mount and unregisters on unmount; the global shortcut hook
 * (`useGlobalKeyboardShortcuts`) consults `arrowPaneOwnsFocus()` before
 * hijacking ArrowUp/Down for chat bubble navigation.
 *
 * Semantics (deliberately minimal): a registered pane owns the arrow keys
 * while the document's focused element is inside that pane (or is the pane
 * itself). When focus is elsewhere — or nothing is registered — the existing
 * chat bubble-nav behavior is unchanged. j/k/g/G are never affected.
 *
 * Same module pattern as `open-modal-registry`: a plain set plus a disposer,
 * read synchronously from a native `keydown` listener.
 */

const arrowPanes = new Set<HTMLElement>();

/**
 * Register a scrollable pane container. Returns a disposer that unregisters
 * it (safe to call more than once, and after the element was detached).
 * Re-registering the same element is a no-op.
 */
export function registerArrowPane(element: HTMLElement): () => void {
  arrowPanes.add(element);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    arrowPanes.delete(element);
  };
}

/** Unregister a pane element (no-op when it is not registered). */
export function unregisterArrowPane(element: HTMLElement): void {
  arrowPanes.delete(element);
}

/**
 * True while the currently focused element lives inside a registered pane,
 * meaning ArrowUp/ArrowDown must fall through to native scrolling.
 */
export function arrowPaneOwnsFocus(): boolean {
  const active = document.activeElement;
  if (!active) return false;
  for (const pane of arrowPanes) {
    if (pane === active || pane.contains(active)) return true;
  }
  return false;
}

/** Number of currently-registered panes. */
export function arrowPaneCount(): number {
  return arrowPanes.size;
}

/** Test-only: clear the registry. */
export function resetArrowPaneRegistryForTests(): void {
  arrowPanes.clear();
}
