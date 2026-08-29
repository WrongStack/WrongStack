import { create } from 'zustand';

/**
 * Tabs the boot reconciliation set aside for the user to decide about.
 *
 * The tab strip lives in `localStorage`, so it outlives the process that made
 * it. Restoring it blindly meant a fresh `wstack --webui` came up wearing the
 * previous run's tabs and paid for a full journal resume — todo board included
 * — before the user had typed anything. Dropping it silently is the other
 * extreme: work the user meant to come back to disappears without a word.
 *
 * So neither. A WebUI that starts fresh IS fresh — one new session, one tab —
 * and the sessions that were in the strip are OFFERED. Resuming is then what it
 * should always have been: an explicit act, on named sessions, that the user
 * chose.
 *
 * The offer holds ids only. Titles come from `useHistoryStore`, which fills in
 * from the `sessions.list` frame that arrives moments later; the modal renders
 * with ids until it does rather than blocking on it.
 */
interface RestoreTabsState {
  /** Stale slots awaiting an answer. Empty means no offer is pending. */
  candidates: string[];
  /** Present the offer. A second offer replaces the first (boot happens once). */
  offer: (sessionIds: readonly string[]) => void;
  /** Dismiss without restoring anything. */
  dismiss: () => void;
}

export const useRestoreTabsStore = create<RestoreTabsState>()((set) => ({
  candidates: [],
  offer: (sessionIds) => {
    const unique = [...new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0))];
    set({ candidates: unique });
  },
  dismiss: () => set({ candidates: [] }),
}));
