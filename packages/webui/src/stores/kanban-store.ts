import type {
  KanbanBoard,
  KanbanBoardSummary,
  KanbanColumn,
  KanbanQueueHealth,
  KanbanSupervisorSnapshot,
  KanbanTask,
} from '@wrongstack/kanban';
import { create } from 'zustand';

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
  setActiveBoardId: (id) => set({ activeBoardId: id, queueHealth: null, supervisorSnapshot: null }),
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
      set((state) => ({
        boards: removed
          ? state.boards.filter((board) => board.id !== removedBoardId)
          : state.boards,
        activeBoardId:
          removed && state.activeBoardId === removedBoardId ? null : state.activeBoardId,
        activeBoard: removed && state.activeBoard?.id === removedBoardId ? null : state.activeBoard,
        loading: false,
        error: null,
      }));
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
        set((state) => ({
          verificationActivity: { ...state.verificationActivity, [key]: { startedAt: Date.now() } },
          loading: false,
          error: null,
        }));
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

function isActiveSummary(board: KanbanBoardSummary): boolean {
  return board.presence?.some((entry) => entry.active) === true;
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
