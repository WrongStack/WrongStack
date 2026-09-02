import { create } from 'zustand';

// ── Goal Assess Store ──────────────────────────────────────────────────────
// Holds the latest goal realism assessment result, bridged from the WS handler
// to the GoalView component.

export interface GoalAssessResultStore {
  /** Whether the claimed duration is realistic. */
  realistic: boolean;
  /** The exact duration text from the goal, or null. */
  durationClaimed: string | null;
  /** Human-readable explanation. */
  explanation: string;
  /** Suggested alternate duration when unrealistic, else null. */
  recommendedDuration: string | null;
  /** List of concrete concerns. */
  concerns: string[];
  /** True when the LLM response could not be parsed. */
  parseFailed: boolean;
  /** Parser or error message. */
  parseError?: string | undefined;
  /** Echo of the client's request seq for stale-response detection. */
  reqSeq: number;
}

interface GoalAssessState {
  /** The latest assessment result (null = no assessment yet). */
  result: GoalAssessResultStore | null;
  /** True while the assessment request is in flight. */
  loading: boolean;
  /** The seq of the most recent request sent. */
  currentSeq: number;
  /** Set the assessment result from a server message. */
  setResult: (result: GoalAssessResultStore) => void;
  /** Mark a new assessment request as in-flight. */
  setLoading: () => void;
  /** Clear the current assessment. */
  clear: () => void;
  /** Get and increment the seq counter for a new request. */
  nextSeq: () => number;
}

export const useGoalAssessStore = create<GoalAssessState>()((set, get) => ({
  result: null,
  loading: false,
  currentSeq: 0,

  setResult: (result) =>
    // Stale response guard: only accept the result if its reqSeq matches
    // the most recent request (currentSeq). The server rounds may resolve
    // out of order; a stale reqSeq is silently dropped.
    set((state) => {
      if (result.reqSeq !== state.currentSeq) return {};
      return { result, loading: false };
    }),

  setLoading: () => set({ loading: true, result: null }),

  clear: () => set({ result: null, loading: false }),

  nextSeq: () => {
    const seq = get().currentSeq + 1;
    set({ currentSeq: seq });
    return seq;
  },
}));
