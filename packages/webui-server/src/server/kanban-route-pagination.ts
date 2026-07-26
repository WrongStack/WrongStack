import type { KanbanBoardSummary } from '@wrongstack/kanban';

export interface KanbanBoardPage {
  items: KanbanBoardSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  activeTotal: number;
  orphanedTotal: number;
}

export function paginateKanbanBoards(
  boards: KanbanBoardSummary[],
  input: { page: number; pageSize: number; activeSessionIds?: readonly string[] | undefined },
): KanbanBoardPage {
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)));
  const activeSessionIds = new Set(input.activeSessionIds ?? []);
  const isActive = (board: KanbanBoardSummary) =>
    board.presence?.some((entry) => entry.active) === true ||
    board.tags?.some((tag) => tag.startsWith('session:') && activeSessionIds.has(tag.slice(8))) ===
      true;
  const sorted = [...boards].sort((left, right) => {
    const activityOrder = Number(isActive(right)) - Number(isActive(left));
    return activityOrder || right.updatedAt.localeCompare(left.updatedAt);
  });
  const activeTotal = sorted.filter(isActive).length;
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requestedPage = Number.isFinite(input.page) ? Math.floor(input.page) : 1;
  const page = Math.min(totalPages, Math.max(1, requestedPage));
  const start = (page - 1) * pageSize;
  return {
    items: sorted.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    totalPages,
    activeTotal,
    orphanedTotal: total - activeTotal,
  };
}
