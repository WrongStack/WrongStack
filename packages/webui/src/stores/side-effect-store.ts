import { createSessionScopedStore } from './session-scoped-store';

export interface SideEffectEntry {
  toolUseId: string;
  toolName: string;
  ts: string;
  input: Record<string, unknown>;
  outcome?: string | undefined;
  risk: string;
}

interface SideEffectState {
  sideEffects: SideEffectEntry[];
  loading: boolean;
  setSideEffects: (effects: SideEffectEntry[]) => void;
  setLoading: (loading: boolean) => void;
  clear: () => void;
}

/**
 * Side effects RECORDED BY ONE RUN — so, one conversation's.
 *
 * The list used to be global and the handler dropped anything that was not the
 * tab in front, which meant a background tab's `side_effects.list` reply
 * arrived and was thrown away: opening that tab showed an empty timeline for a
 * run that had written files.
 */
export const useSideEffectStore = createSessionScopedStore<SideEffectState>((set) => ({
  sideEffects: [],
  loading: false,
  setSideEffects: (effects) => set({ sideEffects: effects, loading: false }),
  setLoading: (loading) => set({ loading }),
  clear: () => set({ sideEffects: [], loading: false }),
}));
