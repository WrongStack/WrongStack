import type {
  KanbanBoard,
  KanbanBoardSummary,
  KanbanColumn,
  KanbanQueueHealth,
  KanbanSupervisorSnapshot,
  KanbanTask,
} from '@wrongstack/kanban';
import { create } from 'zustand';
import { isKanbanBoardActive } from '../lib/kanban-board-active.js';

/**
 * A verification spinner older than this is a ghost: its
 * verification_completed either failed, was cancelled, or belongs to a
 * board the user has left. Real verifications finish in seconds.
 */
const VERIFICATION_SPINNER_TTL_MS = 5 * 60 * 1000;

export interface KanbanResultPayload {
  success: boolean;
  data?: unknown;
  error?: string | undefined;
}

interface KanbanState {
  boards: KanbanBoardSummary[];
  boardTotal: number;
  activeBoardTotal: number;
  orphanedBoardTotal: number;
  activeBoardId: string | null;
  activeBoard: KanbanBoard | null;
  loading: boolean;
  error: string | null;
  queueHealth: KanbanQueueHealth | null;
  supervisorSnapshot: KanbanSupervisorSnapshot | null;
  /** Live verification runs keyed by `${boardId}:${taskId}` (spinner state). */
  verificationActivity: Record<string, { startedAt: number }>;
  setLoading: (loading: boolean) => void;
  setActiveBoardId: (id: string | null) => void;
  setError: (error: string | null) => void;
  setQueueHealth: (health: KanbanQueueHealth | null) => void;
  handleResult: (type: string, payload: KanbanResultPayload) => void;
}

export const useKanbanStore = create<KanbanState>()((set, get) => ({
  boards: [],
  boardTotal: 0,
  activeBoardTotal: 0,
  orphanedBoardTotal: 0,
  activeBoardId: null,
  activeBoard: null,
  loading: false,
  error: null,
  queueHealth: null,
  supervisorSnapshot: null,
  verificationActivity: {},
  setLoading: (loading) => set({ loading }),
  // verificationActivity is per-board ephemera like queueHealth /
  // supervisorSnapshot: without clearing it here, spinners for a board the
  // user left survived the switch and accumulated as ghosts (their
  // verification_completed may never arrive once the board is inactive).
  setActiveBoardId: (id) =>
    set({
      activeBoardId: id,
      queueHealth: null,
      supervisorSnapshot: null,
      verificationActivity: {},
    }),
  setError: (error) => set({ error }),
  setQueueHealth: (health) => set({ queueHealth: health }),
  handleResult: (type, payload) => {
    if (!payload.success) {
      set({ loading: false, error: payload.error ?? 'Kanban request failed' });
      return;
    }
    const data = payload.data;
    if ((type === 'kanban.supervisor.status' || type === 'kanban.supervisor.audit') && data) {
      set({
        supervisorSnapshot: data as KanbanSupervisorSnapshot,
        loading: false,
        error: null,
      });
      return;
    }
    if (type === 'kanban.health' && payload.data) {
      set({ queueHealth: payload.data as KanbanQueueHealth, loading: false, error: null });
      return;
    }
    if (type === 'kanban.list') {
      const paged = isBoardPage(data) ? data : null;
      const boards = paged
        ? paged.items
        : Array.isArray(data)
          ? (data as KanbanBoardSummary[])
          : [];
      set({
        boards,
        boardTotal: paged?.total ?? boards.length,
        activeBoardTotal:
          paged?.activeTotal ?? boards.filter((board) => isActiveSummary(board)).length,
        orphanedBoardTotal:
          paged?.orphanedTotal ?? boards.filter((board) => !isActiveSummary(board)).length,
        loading: false,
        error: null,
      });
      return;
    }
    if (type === 'kanban.delete') {
      const activeBoardId = get().activeBoardId;
      const deleteResult = data as { removed?: boolean; boardId?: string } | null;
      const removed = deleteResult?.removed === true;
      const removedBoardId = deleteResult?.boardId ?? activeBoardId;
      set((state) => {
        // Keep the three totals in step with the filtered list — leaving
        // them untouched showed stale "N boards · M active" numbers until
        // the next kanban.list refresh. When the removed board isn't in the
        // loaded page we can't tell which bucket it was in, so only
        // boardTotal drops; the next list refresh reconciles.
        const removedSummary = removed
          ? state.boards.find((board) => board.id === removedBoardId)
          : undefined;
        const removedActive = removedSummary ? isActiveSummary(removedSummary) : undefined;
        return {
          boards: removed
            ? state.boards.filter((board) => board.id !== removedBoardId)
            : state.boards,
          boardTotal: removed ? Math.max(0, state.boardTotal - 1) : state.boardTotal,
          activeBoardTotal:
            removedActive === true
              ? Math.max(0, state.activeBoardTotal - 1)
              : state.activeBoardTotal,
          orphanedBoardTotal:
            removedActive === false
              ? Math.max(0, state.orphanedBoardTotal - 1)
              : state.orphanedBoardTotal,
          activeBoardId:
            removed && state.activeBoardId === removedBoardId ? null : state.activeBoardId,
          activeBoard:
            removed && state.activeBoard?.id === removedBoardId ? null : state.activeBoard,
          loading: false,
          error: null,
        };
      });
      return;
    }
    if (type === 'kanban.task.remove') {
      const result = data as {
        removed?: boolean;
        boardId?: string;
        taskId?: string;
        board?: unknown;
      } | null;
      set((state) => {
        const board = isBoard(result?.board) ? result.board : null;
        if (board && state.activeBoardId === board.id) {
          return {
            boards: upsertSummary(state.boards, summarize(board)),
            activeBoard: board,
            loading: false,
            error: null,
          };
        }
        const boardId = result?.boardId;
        const taskId = result?.taskId;
        const activeBoard =
          result?.removed === true &&
          taskId &&
          state.activeBoard &&
          (!boardId || state.activeBoard.id === boardId)
            ? {
                ...state.activeBoard,
                tasks: state.activeBoard.tasks.filter((task) => task.id !== taskId),
              }
            : state.activeBoard;
        return {
          activeBoard,
          boards: activeBoard ? upsertSummary(state.boards, summarize(activeBoard)) : state.boards,
          loading: false,
          error: null,
        };
      });
      return;
    }
    if (type === 'kanban.column.remove') {
      const result = data as { board?: unknown } | null;
      if (isBoard(result?.board)) {
        const board = result.board;
        set((state) => ({
          boards: upsertSummary(state.boards, summarize(board)),
          activeBoard: state.activeBoardId === board.id ? board : state.activeBoard,
          loading: false,
          error: null,
        }));
        return;
      }
    }
    if (type === 'kanban.task.verification_started') {
      // Ephemeral spinner state; the payload has no task envelope (and no
      // title), so an explicit branch is required — the catch-all would
      // otherwise swallow it.
      const ref = data as { boardId?: string; taskId?: string } | null;
      if (ref?.boardId && ref.taskId) {
        const key = `${ref.boardId}:${ref.taskId}`;
        set((state) => {
          // TTL prune: verification_completed is the ONLY removal event, so
          // a failed/cancelled verification (whose completion never fires)
          // left its spinner forever. Sweep stale entries whenever a new
          // verification starts — no timer needed, and a spinner older than
          // the TTL is a ghost by definition.
          const now = Date.now();
          const verificationActivity = Object.fromEntries(
            Object.entries(state.verificationActivity).filter(
              ([, value]) => now - value.startedAt < VERIFICATION_SPINNER_TTL_MS,
            ),
          );
          verificationActivity[key] = { startedAt: now };
          return { verificationActivity, loading: false, error: null };
        });
      }
      return;
    }
    if (type === 'kanban.task.verification_completed' && isTaskEnvelope(data)) {
      const key = `${data.boardId}:${data.task.id}`;
      set((state) => {
        const verificationActivity = { ...state.verificationActivity };
        delete verificationActivity[key];
        if (state.activeBoard && state.activeBoard.id === data.boardId) {
          const activeBoard = upsertTask(state.activeBoard, data.task);
          return {
            verificationActivity,
            boards: upsertSummary(state.boards, summarize(activeBoard)),
            activeBoard,
            loading: false,
            error: null,
          };
        }
        return { verificationActivity, loading: false, error: null };
      });
      return;
    }
    if (isBoardEnvelope(data)) {
      const board = data.board;
      set((state) => ({
        boards: upsertSummary(state.boards, summarize(board)),
        activeBoard: state.activeBoardId === board.id ? board : state.activeBoard,
        loading: false,
        error: null,
      }));
      return;
    }
    if (isTaskEnvelope(data)) {
      set((state) => {
        if (state.activeBoard && state.activeBoard.id === data.boardId) {
          const activeBoard = upsertTask(state.activeBoard, data.task);
          return {
            boards: upsertSummary(state.boards, summarize(activeBoard)),
            activeBoard,
            loading: false,
            error: null,
          };
        }
        return { loading: false, error: null };
      });
      return;
    }
    if (isBoard(data)) {
      const summary = summarize(data);
      if (type === 'kanban.get') {
        set((state) => ({
          boards: upsertSummary(state.boards, summary),
          activeBoard: state.activeBoardId === data.id ? data : state.activeBoard,
          loading: false,
          error: null,
        }));
        return;
      }
      set((state) => ({
        boards: upsertSummary(state.boards, summary),
        activeBoardId: data.id,
        activeBoard: data,
        loading: false,
        error: null,
      }));
      return;
    }
    if (isTask(data)) {
      set((state) => ({
        ...(state.activeBoard
          ? (() => {
              const activeBoard = upsertTask(state.activeBoard, data);
              return {
                activeBoard,
                boards: upsertSummary(state.boards, summarize(activeBoard)),
              };
            })()
          : { activeBoard: state.activeBoard }),
        loading: false,
        error: null,
      }));
      return;
    }
    if (Array.isArray(data) && data.every(isColumn)) {
      set((state) => ({
        ...(state.activeBoard
          ? (() => {
              const activeBoard = { ...state.activeBoard, columns: data };
              return {
                activeBoard,
                boards: upsertSummary(state.boards, summarize(activeBoard)),
              };
            })()
          : { activeBoard: state.activeBoard }),
        loading: false,
        error: null,
      }));
      return;
    }
    set({ loading: false, error: null });
  },
}));

function isBoard(value: unknown): value is KanbanBoard {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as KanbanBoard).columns) &&
    Array.isArray((value as KanbanBoard).tasks)
  );
}

function isTask(value: unknown): value is KanbanTask {
  return (
    Boolean(value) && typeof value === 'object' && typeof (value as KanbanTask).title === 'string'
  );
}

function isTaskEnvelope(value: unknown): value is { boardId: string; task: KanbanTask } {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { boardId?: unknown }).boardId === 'string' &&
    isTask((value as { task?: unknown }).task)
  );
}

function isBoardEnvelope(value: unknown): value is { board: KanbanBoard } {
  return (
    Boolean(value) && typeof value === 'object' && isBoard((value as { board?: unknown }).board)
  );
}

interface KanbanBoardPage {
  items: KanbanBoardSummary[];
  total: number;
  activeTotal?: number | undefined;
  orphanedTotal?: number | undefined;
}

function isBoardPage(value: unknown): value is KanbanBoardPage {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as KanbanBoardPage).items) &&
    typeof (value as KanbanBoardPage).total === 'number'
  );
}

// Fallback totals reuse the shared board-active predicate. The store runs
// outside React and doesn't know the live session ids, so it passes an
// empty list — presence-only, but the DEFINITION stays single-sourced with
// `KanbanView`'s list split instead of forking a narrower copy here.
function isActiveSummary(board: KanbanBoardSummary): boolean {
  return isKanbanBoardActive(board, []);
}

function isColumn(value: unknown): value is KanbanColumn {
  return (
    Boolean(value) && typeof value === 'object' && typeof (value as KanbanColumn).id === 'string'
  );
}

function summarize(board: KanbanBoard): KanbanBoardSummary {
  return {
    id: board.id,
    title: board.title,
    description: board.description,
    tags: board.tags,
    presence: board.presence,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    columnCount: board.columns.length,
    taskCount: board.tasks.length,
    completedTaskCount: board.tasks.filter((task) => task.status === 'completed').length,
  };
}

function upsertSummary(
  boards: KanbanBoardSummary[],
  summary: KanbanBoardSummary,
): KanbanBoardSummary[] {
  const next = boards.filter((board) => board.id !== summary.id);
  return [summary, ...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function upsertTask(board: KanbanBoard, task: KanbanTask): KanbanBoard {
  const tasks = board.tasks.some((candidate) => candidate.id === task.id)
    ? board.tasks.map((candidate) => (candidate.id === task.id ? task : candidate))
    : [...board.tasks, task];
  return { ...board, tasks };
}
