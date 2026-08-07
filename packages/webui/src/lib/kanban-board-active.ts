import type { KanbanBoardSummary } from '@wrongstack/kanban';

/**
 * The single client-side answer to "is this board attached to a live
 * session?": a board is active when EITHER a presence entry is live OR one
 * of its `session:<id>` tags names a session the client currently knows to
 * be running. Callers that cannot know the live session ids (e.g. the
 * kanban store computing fallback totals outside React) pass an empty
 * list — that degrades to the presence-only half of the predicate instead
 * of forking a second, narrower definition.
 *
 * The server-side twin lives in
 * `packages/webui-server/src/server/kanban-route-pagination.ts`
 * (`isActive` inside `paginateKanbanBoards`) and must keep the same shape:
 * the server's `activeTotal`/`orphanedTotal` land in the same store fields
 * these fallbacks feed, so a definition drift between the two shows up as
 * a section heading disagreeing with the list rendered under it.
 */
export function isKanbanBoardActive(
  board: Pick<KanbanBoardSummary, 'presence' | 'tags'>,
  activeSessionIds: readonly string[],
): boolean {
  return (
    board.presence?.some((entry) => entry.active) === true ||
    board.tags?.some(
      (tag) => tag.startsWith('session:') && activeSessionIds.includes(tag.slice(8)),
    ) === true
  );
}
