/** Generation counter for codebase-index → CodeMap cache invalidation. */
import { create } from 'zustand';

interface CodemapIndexState {
  /** Bumps when the server reports a finished index run. */
  generation: number;
  lastUpdatedAt: number | null;
  notifyIndexUpdated: (at?: number) => void;
}

export const useCodemapIndexStore = create<CodemapIndexState>((set) => ({
  generation: 0,
  lastUpdatedAt: null,
  notifyIndexUpdated(at = Date.now()) {
    set((state) => ({
      generation: state.generation + 1,
      lastUpdatedAt: at,
    }));
  },
}));
