/**
 * Sidebar sizing — shared scroll-clamp budgets for routed sidebar panels.
 *
 * The right sidebar in `RightSidebar` (`packages/tui/src/components/sidebar.tsx`)
 * owns viewport clipping; individual routed panels still size naturally and
 * `RightSidebar` discards rows beyond its `maxHeight`. To keep the focused
 * `sidebarScroll` ↑↓ clamp from under-reserving scroll budget for tall
 * worklist panels, this module publishes a single source-of-truth table that
 * every routed panel can be added to once and reused in:
 *
 *   - `app-ui-state.ts#resolveAppSidebarLayout` — accumulates `sidebarTwinRowCount`.
 *   - `reducers/workspace-panels.ts#computeMaxSidebarScroll` — subtracts the
 *     total from the scroll viewport.
 *
 * Values are computed at the minimum 16-column content width and over-estimate
 * intentionally: miscounting under is the failure mode we want to defend
 * against (lower persistent content becoming unreachable), while miscounting
 * over is harmless (a small amount of blank space at the end of the scroll).
 */
import type { PanelId } from './ui-contracts.js';
import { SIDEBAR_TWIN_MAX_WRAP_LINES } from './ui-contracts.js';

/**
 * Natural-height budget for each routed sidebar panel at the minimum
 * 16-column content width. Worklist panels reserve their maximum item count
 * × the bounded wrap ceiling; connections reserve two rows per service.
 */
export const SIDEBAR_TWIN_HEIGHT_BY_PANEL: Readonly<Record<PanelId, number>> = Object.freeze({
  projectPicker: 18,
  fleet: 14,
  agents: 29,
  worktree: 14,
  plan: 7 + 9 * SIDEBAR_TWIN_MAX_WRAP_LINES,
  todos: 4 + 12 * SIDEBAR_TWIN_MAX_WRAP_LINES,
  queue: 4 + 10 * SIDEBAR_TWIN_MAX_WRAP_LINES,
  processList: 12,
  goal: 11 + 6 * SIDEBAR_TWIN_MAX_WRAP_LINES,
  sessions: 13,
  coordinator: 13,
  kanban: 14 + 6 * SIDEBAR_TWIN_MAX_WRAP_LINES,
  connections: 6 + 10 * 2,
});

/**
 * Sum the conservative budgets for a set of routed twins currently mounted
 * above `SidebarContent`. Identical math to the inline loop previously in
 * `app-ui-state.ts`; exported here so future routed panels only need to
 * import the helper rather than re-implement the freeze and the lookup.
 */
export function sumSidebarTwinRowCount(panels: Iterable<PanelId>): number {
  let total = 0;
  for (const id of panels) total += SIDEBAR_TWIN_HEIGHT_BY_PANEL[id];
  return total;
}
