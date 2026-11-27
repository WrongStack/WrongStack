import { create } from 'zustand';

/**
 * Server-confirmed state of the project-wide Kanban Companion switch.
 *
 * Deliberately NOT part of `local-prefs`: the flag lives on the server per
 * project (workspace), so this store is non-optimistic — the UI only mirrors
 * the last `kanban.companion.status` truth and never flips ahead of a reply.
 * All request correlation (requestId, scope epochs, broadcasts) lives in
 * `kanban-companion-wire.ts`; this store holds nothing but rendered state.
 */
export interface KanbanCompanionState {
  /** Server-confirmed switch for the active project; null = not known yet. */
  enabled: boolean | null;
  /** A `kanban.companion.set` is in flight; switches block while true. */
  pending: boolean;
  /** Raw failure message from the last failed get/set; null when healthy.
   *  Empty string = failed without a server message (UI shows a localized
   *  fallback). */
  error: string | null;
  setEnabled: (enabled: boolean | null) => void;
  setPending: (pending: boolean) => void;
  setError: (error: string | null) => void;
}

export const useKanbanCompanionStore = create<KanbanCompanionState>()((set) => ({
  enabled: null,
  pending: false,
  error: null,
  setEnabled: (enabled) => set({ enabled }),
  setPending: (pending) => set({ pending }),
  setError: (error) => set({ error }),
}));
