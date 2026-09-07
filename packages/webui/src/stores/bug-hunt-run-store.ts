import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const PENDING_REQUEST_ID = '__bug_hunt_continuation_pending__';

export interface BugHuntRun {
  scope: string;
  totalRounds: 1 | 2 | 3;
  /** The round currently running, or most recently completed when inactive. */
  currentRound: number;
  /** `null` after recovery; the next completion then claims the resumed run. */
  requestId: string | null;
}

interface BugHuntRunState {
  runs: Record<string, BugHuntRun>;
  start(sessionId: string, run: BugHuntRun): void;
  /** Whether a result with a request id belongs to the active round. */
  ownsRequest(sessionId: string, requestId?: string): boolean;
  /** Claim one completed round and reserve the next send against duplicate results. */
  advance(sessionId: string, requestId?: string): BugHuntRun | null;
  setRequestId(sessionId: string, requestId: string): void;
  stop(sessionId: string, requestId?: string): void;
  recover(sessionId: string, run: Omit<BugHuntRun, 'requestId'>): void;
  clear(sessionId: string): void;
}

/**
 * Session-keyed state for WebUI's one-bug-per-turn hunt loop. Persistence lets
 * a refreshed page recover the active budget; every submitted round also
 * carries durable chat-journal metadata for session replay.
 */
export const useBugHuntRunStore = create<BugHuntRunState>()(
  persist(
    (set, get) => ({
      runs: {},
      start: (sessionId, run) => set((state) => ({ runs: { ...state.runs, [sessionId]: run } })),
      ownsRequest: (sessionId, requestId) => {
        const active = get().runs[sessionId];
        return Boolean(
          active &&
            requestId !== undefined &&
            active.requestId !== null &&
            active.requestId !== PENDING_REQUEST_ID &&
            active.requestId === requestId,
        );
      },
      advance: (sessionId, requestId) => {
        const active = get().runs[sessionId];
        if (
          !active ||
          active.requestId === PENDING_REQUEST_ID ||
          (requestId !== undefined && active.requestId !== null && active.requestId !== requestId)
        ) {
          return null;
        }
        if (active.currentRound >= active.totalRounds) {
          get().clear(sessionId);
          return null;
        }
        const next = {
          ...active,
          currentRound: active.currentRound + 1,
          requestId: PENDING_REQUEST_ID,
        };
        set((state) => ({ runs: { ...state.runs, [sessionId]: next } }));
        return next;
      },
      setRequestId: (sessionId, requestId) =>
        set((state) => {
          const active = state.runs[sessionId];
          if (!active || active.requestId !== PENDING_REQUEST_ID) return state;
          return { runs: { ...state.runs, [sessionId]: { ...active, requestId } } };
        }),
      stop: (sessionId, requestId) => {
        const active = get().runs[sessionId];
        if (!active || (requestId && active.requestId !== null && active.requestId !== requestId))
          return;
        get().clear(sessionId);
      },
      recover: (sessionId, run) =>
        set((state) => ({
          runs: {
            ...state.runs,
            [sessionId]: { ...run, requestId: null },
          },
        })),
      clear: (sessionId) =>
        set((state) => {
          const { [sessionId]: _removed, ...runs } = state.runs;
          return { runs };
        }),
    }),
    {
      name: 'wrongstack-bug-hunt-runs',
      partialize: (state) => ({ runs: state.runs }),
    },
  ),
);
