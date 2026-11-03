/**
 * Live log of Brain council panels.
 *
 * The council is the most expensive Brain tier — one provider call PER SEAT,
 * with a ~90s ceiling. `brain.council_vote` / `brain.council_resolved` already
 * reached the browser over `brain.event`, but nothing consumed them, so a slow,
 * costly multi-model decision was indistinguishable from a free policy one.
 *
 * Seat votes arrive BEFORE the resolution (both are emitted from inside
 * `council.decide()`), so a panel is assembled incrementally: it appears as
 * soon as its first seat votes and flips to `resolved` when the tally lands.
 * That ordering is also why a panel can legitimately sit in `voting` forever —
 * a council that throws mid-flight never resolves — hence the ring buffer.
 *
 * The question text is NOT on either council event; it lives on the
 * `brain.decision_*` events for the same request id. `noteQuestion` folds it in
 * whenever it becomes known, in either order.
 */
import {
  applyCouncilResolution,
  applyCouncilVote,
  type CouncilPanelEntry,
  noteCouncilQuestion,
} from '@wrongstack/project-surfaces/council/panels';
import { createSessionScopedStore } from './session-scoped-store';

export {
  type CouncilPanelEntry,
  isCouncilPanelAdverse,
  MAX_COUNCIL_PANELS,
  summarizeCouncilPanel,
  toCouncilSeatVote,
} from '@wrongstack/project-surfaces/council/panels';

interface CouncilLogState {
  /** Newest first. */
  panels: CouncilPanelEntry[];
  /** Bounded, session-local questions received before the first ballot. */
  questions: Map<string, string>;
  recordVote: (payload: Record<string, unknown>) => void;
  recordResolution: (payload: Record<string, unknown>) => void;
  noteQuestion: (requestId: string, question: string) => void;
  clear: () => void;
}

/**
 * One log per conversation: a council convened for tab 3's decision is tab 3's
 * record, and must not appear in — or be lost because of — tab 1's panel.
 */
export const useCouncilLogStore = createSessionScopedStore<CouncilLogState>((set) => ({
  panels: [],
  questions: new Map(),
  recordVote: (payload) => set((state) => fold(state, applyCouncilVote(state, payload))),
  recordResolution: (payload) =>
    set((state) => fold(state, applyCouncilResolution(state, payload))),
  noteQuestion: (requestId, question) =>
    set((state) => fold(state, noteCouncilQuestion(state, requestId, question))),
  clear: () => set({ panels: [], questions: new Map() }),
}));

/** Keep the store's state object when nothing changed, so subscribers stay quiet. */
function fold(
  state: CouncilLogState,
  next: { panels: CouncilPanelEntry[]; questions: Map<string, string> },
): Partial<CouncilLogState> | CouncilLogState {
  if (next.panels === state.panels && next.questions === state.questions) return state;
  return { panels: next.panels, questions: next.questions };
}
