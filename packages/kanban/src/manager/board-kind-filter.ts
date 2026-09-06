import type { KanbanBoard, KanbanBoardKind } from '../types.js';

/**
 * Board-kind filter options shared by queue health, snapshot, ready tasks,
 * and dispatch. When neither include nor exclude is provided, session mirrors
 * and archived boards are excluded by default so global queue operations are
 * not polluted by ephemeral session state.
 */
export interface BoardKindFilter {
  includeBoardKinds?: readonly KanbanBoardKind[] | undefined;
  excludeBoardKinds?: readonly KanbanBoardKind[] | undefined;
}

/**
 * The default exclusion set: session mirrors and archived boards are hidden
 * from global queue operations unless explicitly requested.
 */
export const DEFAULT_EXCLUDED_KINDS: readonly KanbanBoardKind[] = ['session_mirror', 'archive'];

/**
 * Resolve effective include/exclude sets from a filter. When neither is
 * provided, the default excluded set is applied. When `includeBoardKinds` is
 * provided, it takes priority and `excludeBoardKinds` is ignored.
 */
export function resolveKindFilter(filter: BoardKindFilter | undefined): {
  include: Set<KanbanBoardKind> | undefined;
  exclude: Set<KanbanBoardKind>;
} {
  if (filter?.includeBoardKinds?.length) {
    return {
      include: new Set(filter.includeBoardKinds),
      exclude: new Set(),
    };
  }
  const excluded =
    filter?.excludeBoardKinds !== undefined
      ? new Set(filter.excludeBoardKinds)
      : new Set(DEFAULT_EXCLUDED_KINDS);
  return { include: undefined, exclude: excluded };
}

/**
 * Check whether a board passes the kind filter.
 */
export function boardPassesKindFilter(
  board: KanbanBoard,
  resolved: { include: Set<KanbanBoardKind> | undefined; exclude: Set<KanbanBoardKind> },
): boolean {
  const kind = board.kind ?? 'project';
  if (resolved.include) return resolved.include.has(kind);
  return !resolved.exclude.has(kind);
}
