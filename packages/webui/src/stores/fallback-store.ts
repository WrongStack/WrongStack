/**
 * Zustand store for the fallback model modal.
 *
 * Populated by `provider.fallback_pending` WS events and cleared by
 * `provider.fallback` (the switch happened) or explicit dismiss.
 * The modal sends `model.fallback_choice` back to the server.
 */
import { create } from 'zustand';

export interface FallbackCandidate {
  providerId: string;
  model: string;
}

export interface FallbackPendingState {
  requestId: string;
  from: { providerId: string; model: string };
  status: number;
  candidates: FallbackCandidate[];
  autoSwitchSeconds: number;
  timestamp: number;
}

interface FallbackStore {
  pending: FallbackPendingState | null;
  selected: number;
  /** Set the pending state from a WS event. */
  setPending: (state: FallbackPendingState) => void;
  /** Clear the pending state (switch happened or dismissed). */
  clear: () => void;
  /** Move the selection index (wraps). */
  move: (delta: number) => void;
  /** Set selection to a specific index. */
  setSelected: (index: number) => void;
}

export const useFallbackStore = create<FallbackStore>((set) => ({
  pending: null,
  selected: 0,
  setPending: (state) => set({ pending: state, selected: 0 }),
  clear: () => set({ pending: null, selected: 0 }),
  move: (delta) =>
    set((s) => {
      if (!s.pending || s.pending.candidates.length === 0) return s;
      const n = s.pending.candidates.length;
      return { selected: (s.selected + delta + n) % n };
    }),
  setSelected: (index) => set({ selected: Math.max(0, index) }),
}));
