import { create } from 'zustand';
import type { PhaseItem } from '@/components/PhasePanel';

// ── Goal Run Store ─────────────────────────────────────────────────────────

type GoalRunStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';

/** A persisted kanban board (one Goal graph JSON per board on disk). */
interface GoalRunBoardSummary {
  id: string;
  title: string;
  updatedAt: number;
  status: string;
}

interface GoalRunState {
  phases: PhaseItem[];
  activePhaseId: string | null;
  overallPercent: number;
  autonomous: boolean;
  title: string | null;
  /** Full operator prompt that started the run (title is only a short heading). */
  goal: string | null;
  status: GoalRunStatus;
  /** Split goal across multiple kanban boards (one per phase). */
  multiBoard: boolean;
  lastEvent: string | null;
  lastError: string | null;
  /** All persisted boards for this project (from goal.list). */
  graphs: GoalRunBoardSummary[];
  progress: {
    totalPhases: number;
    completed: number;
    failed: number;
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
  } | null;

  setState: (s: {
    phases?: PhaseItem[] | undefined;
    activePhaseId?: string | null | undefined;
    overallPercent?: number | undefined;
    autonomous?: boolean | undefined;
    title?: string | null | undefined;
    goal?: string | null | undefined;
    status?: GoalRunStatus | undefined;
    multiBoard?: boolean | undefined;
    lastEvent?: string | null | undefined;
    lastError?: string | null | undefined;
    graphs?: GoalRunBoardSummary[] | undefined;
    progress?: GoalRunState['progress'] | undefined;
  }) => void;
  clear: () => void;
  /** Request state from server on mount. */
  hydrateFromServer: (send: (msg: unknown) => void) => void;
}

export const useGoalRunStore = create<GoalRunState>()((set) => ({
  phases: [],
  activePhaseId: null,
  overallPercent: 0,
  autonomous: false,
  title: null,
  goal: null,
  status: 'idle',
  multiBoard: false,
  lastEvent: null,
  lastError: null,
  graphs: [],
  progress: null,

  setState: (patch) =>
    set((prev) => ({
      phases: patch.phases ?? prev.phases,
      activePhaseId: patch.activePhaseId !== undefined ? patch.activePhaseId : prev.activePhaseId,
      overallPercent: patch.overallPercent ?? prev.overallPercent,
      autonomous: patch.autonomous ?? prev.autonomous,
      title: patch.title !== undefined ? patch.title : prev.title,
      goal: patch.goal !== undefined ? patch.goal : prev.goal,
      status: patch.status ?? prev.status,
      multiBoard: patch.multiBoard ?? prev.multiBoard,
      lastEvent: patch.lastEvent !== undefined ? patch.lastEvent : prev.lastEvent,
      lastError: patch.lastError !== undefined ? patch.lastError : prev.lastError,
      graphs: patch.graphs ?? prev.graphs,
      progress: patch.progress !== undefined ? patch.progress : prev.progress,
    })),
  clear: () =>
    set({
      phases: [],
      activePhaseId: null,
      overallPercent: 0,
      autonomous: false,
      title: null,
      goal: null,
      status: 'idle',
      multiBoard: false,
      lastEvent: null,
      lastError: null,
      graphs: [],
      progress: null,
    }),
  /**
   * Request state hydration from the server. Call on mount to populate
   * store from persisted disk state before live WS events arrive.
   */
  hydrateFromServer: (send: (msg: unknown) => void) => {
    send({ type: 'goal.list' });
    send({ type: 'goal.state' });
  },
}));
