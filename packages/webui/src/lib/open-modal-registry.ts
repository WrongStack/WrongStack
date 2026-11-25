/**
 * Open-modal registry.
 *
 * A tiny pub/sub set of the modal dialogs that are currently open. Modal
 * hosts register on open and unregister on close/unmount; the global Esc
 * handler (`useGlobalKeyboardShortcuts`) consults `hasOpenModal()` to decide
 * whether a dialog owns Escape — a registered open modal blocks the global
 * session-abort so the dialog's own focus-trap / Esc handling wins.
 *
 * This replaces the previous manual enumeration of per-overlay ui-store flags
 * (searchOpen / paletteOpen / shortcutsOpen / modelSwitcherOpen /
 * promptLibraryOpen) plus a DOM query: a new modal only has to call
 * `registerOpenModal` while it is open, and it can never be bypassed or
 * accidentally aborted underneath.
 *
 * Plain module (no store) because the Esc path reads it synchronously from a
 * native `keydown` listener; the subscribe hook exists for UI that wants to
 * react to modal-open changes.
 */

const openModals = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Register an open modal. Returns a disposer that unregisters it (safe to
 * call more than once). Re-registering an already-registered id is a no-op.
 */
export function registerOpenModal(id: string): () => void {
  const added = !openModals.has(id);
  openModals.add(id);
  if (added) notify();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unregisterOpenModal(id);
  };
}

/** Unregister a modal by id (no-op when it is not registered). */
export function unregisterOpenModal(id: string): void {
  if (openModals.delete(id)) notify();
}

/** True while at least one modal is registered as open. */
export function hasOpenModal(): boolean {
  return openModals.size > 0;
}

/** Number of currently-registered open modals. */
export function openModalCount(): number {
  return openModals.size;
}

/**
 * Subscribe to open/close transitions. Returns an unsubscribe function.
 * Notifications fire only on actual set membership changes.
 */
export function subscribeToOpenModals(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: clear the registry and its listeners. */
export function resetOpenModalRegistryForTests(): void {
  openModals.clear();
  listeners.clear();
}
