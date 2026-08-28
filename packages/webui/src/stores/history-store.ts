import { create } from 'zustand';
import type { SessionHistoryEntry } from './types.js';

// ============================================
// History Store
// ============================================

interface HistoryState {
  entries: SessionHistoryEntry[];
  loading: boolean;
  error: string | null;
  setEntries: (entries: SessionHistoryEntry[], error?: string | null) => void;
  setLoading: (loading: boolean) => void;
  removeEntry: (id: string) => void;
  /** Optimistically patch an entry's name (cleared when `name` is empty). */
  updateEntryName: (id: string, name: string) => void;
  /**
   * Re-point the `isCurrent` flag at the tab now in front.
   *
   * The list itself is project-wide, but `isCurrent` is not: it disables the
   * resume button, drives the "active" filter, and spares a row from the
   * empty-session sweep. The server can only answer one session per frame,
   * and `session.new` BROADCASTS a list to every socket — so the flag is
   * settled here, where the foreground session is known, instead of trusting
   * whichever session the last frame happened to be about.
   */
  rebindCurrent: (sessionId: string | null) => void;
  clearHistory: () => void;
}

export const useHistoryStore = create<HistoryState>()((set) => ({
  entries: [],
  loading: false,
  error: null,
  setEntries: (entries, error = null) => set({ entries, error, loading: false }),
  setLoading: (loading) => set({ loading }),
  removeEntry: (id) =>
    set((state) => ({
      entries: state.entries.filter((e) => e.id !== id),
    })),
  updateEntryName: (id, name) =>
    set((state) => ({
      entries: state.entries.map((e) => {
        if (e.id !== id) return e;
        const trimmed = name.trim();
        if (!trimmed) {
          const { name: _omit, ...rest } = e;
          return rest as SessionHistoryEntry;
        }
        return { ...e, name: trimmed };
      }),
    })),
  rebindCurrent: (sessionId) =>
    set((state) => {
      if (state.entries.every((e) => e.isCurrent === (e.id === sessionId))) return {};
      return { entries: state.entries.map((e) => ({ ...e, isCurrent: e.id === sessionId })) };
    }),
  clearHistory: () => set({ entries: [] }),
}));
