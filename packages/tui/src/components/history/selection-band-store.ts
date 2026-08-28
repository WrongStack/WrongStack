/**
 * Minimal external store for the drag-selection highlight band.
 *
 * Why an external store instead of React state: the selection gesture must
 * not re-render the history cards. Selection coordinates already live in a
 * ref (see use-history-controller) precisely so a drag causes zero renders;
 * this store gives the one leaf that DOES need to update — the right-edge
 * rail — a subscription channel. The controller publishes on every selection
 * mutation, and only components that call useSyncExternalStore on the store
 * re-render. Cards never subscribe, so they never re-render mid-drag, and
 * because the band renders inside the rail's already-reserved columns the
 * layout (and the fixed-height overflow-hidden viewport) cannot change.
 *
 * Snapshots are immutable; `publish` suppresses value-identical updates so a
 * drag that holds the same row span doesn't spam listeners.
 */

/** Row span of an in-progress drag, in viewport rows (0-based, inclusive). */
interface SelectionBand {
  readonly topRow: number;
  readonly bottomRow: number;
  /** Row under the live drag head — rendered denser so the user can see
   * where the gesture currently points. */
  readonly headRow: number;
}

type SelectionBandSnapshot = SelectionBand | null;

export interface SelectionBandStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SelectionBandSnapshot;
  publish(next: SelectionBandSnapshot): void;
}

function sameBand(a: SelectionBandSnapshot, b: SelectionBandSnapshot): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.topRow === b.topRow && a.bottomRow === b.bottomRow && a.headRow === b.headRow;
}

/** Band covering the anchor..head row span of an in-progress drag. */
export function bandFromSelection(
  anchor: { row: number },
  head: { row: number },
): SelectionBand {
  return {
    topRow: Math.min(anchor.row, head.row),
    bottomRow: Math.max(anchor.row, head.row),
    headRow: head.row,
  };
}

export function createSelectionBandStore(): SelectionBandStore {
  let snapshot: SelectionBandSnapshot = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    publish(next) {
      if (sameBand(snapshot, next)) return;
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}
