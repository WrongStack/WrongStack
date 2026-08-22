import { listBoardSummaries } from '../storage.js';
import type { KanbanBoard } from '../types.js';
import type { BoardKindFilter } from './board-kind-filter.js';
import { boardPassesKindFilter, resolveKindFilter } from './board-kind-filter.js';
import { getBoard } from './boards.js';

/**
 * Read-only board collection kept outside the mutation helper layer.
 * When no boardId is given, boards are filtered by kind — session mirrors
 * and archived boards are excluded by default.
 */
export async function collectBoardsForHealth(
  projectRoot: string,
  boardId: string | undefined,
  kindFilter?: BoardKindFilter | undefined,
): Promise<KanbanBoard[]> {
  if (boardId !== undefined) {
    const board = await getBoard(projectRoot, boardId);
    return board ? [board] : [];
  }
  const resolved = resolveKindFilter(kindFilter);
  const summaries = await listBoardSummaries(projectRoot);
  const boards: KanbanBoard[] = [];
  for (const summary of summaries) {
    // Filter by kind using the summary's kind field (set during normalization).
    // Boards are already normalized on read, so kind is always present.
    const summaryKind = summary.kind ?? 'project';
    if (resolved.include) {
      if (!resolved.include.has(summaryKind)) continue;
    } else if (resolved.exclude.has(summaryKind)) continue;
    const board = await getBoard(projectRoot, summary.id);
    if (board && boardPassesKindFilter(board, resolved)) boards.push(board);
  }
  return boards;
}
