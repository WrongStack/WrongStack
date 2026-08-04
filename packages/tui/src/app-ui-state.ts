import type { State } from './app-reducer.js';
import { computeSidebarContentWidth, computeSidebarWidth } from './components/sidebar.js';
import type { StatuslineItem } from './components/statusline-picker.js';
import {
  coercePanelPositionMap,
  PANEL_IDS,
  type PanelId,
  type PanelPositionMap,
} from './ui-contracts.js';

export function mergeStatuslineHiddenItems(
  hookHidden: StatuslineItem[],
  reducerHidden: StatuslineItem[],
): StatuslineItem[] {
  const hookHiddenSet = new Set<StatuslineItem>(hookHidden);
  const reducerOnlyHidden = reducerHidden.filter((item) => !hookHiddenSet.has(item));
  return [...hookHidden, ...reducerOnlyHidden];
}

/**
 * True when any of the legacy picker overlays is open. Note: panel flags
 * like `state.sessionsPanelOpen` are intentionally NOT included here so
 * the local `overlayOpen` gate in app-view.tsx can apply its per-panel
 * routing guard (`!anyRoutedToSidebar(id)`) and let the sidebar twin
 * render. Adding a new panel-open flag to this list would silently
 * collapse the sidebar to width 0 and prevent the twin from mounting.
 */
export function isPickerOverlayOpen(state: State): boolean {
  return (
    state.modelPicker.open ||
    state.autonomyPicker.open ||
    state.modePicker.open ||
    state.designPicker.open ||
    state.resumePicker.open ||
    state.promptPicker.open ||
    state.settingsPicker.open ||
    state.slashPicker.open ||
    state.statuslinePicker.open ||
    state.pluginPicker.open ||
    state.mcpPicker.open ||
    state.toolsPicker.open ||
    state.brainPanel.open ||
    state.helpPanel.open ||
    state.shadowPanel.open ||
    state.fKeyPicker.open ||
    state.authPanel.open ||
    state.picker.open
  );
}

export interface SidebarLayoutState {
  panelPositions: PanelPositionMap;
  overlayOpen: boolean;
  sidebarWidth: number;
  /** Width AppView must pass to nested routed sidebar panel frames. */
  sidebarContentWidth: number;
  mainColumnWidth: number;
  /**
   * Whether the swarm panel (`AgentSwarmPanelMode === 'sidebar'`) is
   * effective on the right sidebar using the dual source: picker draft
   * when `state.settingsPicker.open`, persisted `liveSettings.panelPositions`
   * otherwise. Mirrors the renderer-side read in `app-view.tsx` so the
   * scroll-clamp reducer can reserve the mission-queue rows even when
   * the persisted config never went through the picker UI.
   */
  effectiveSwarmOnSidebar: boolean;
  /**
   * Approximate row count for routed sidebar twin panels mounted above
   * `SidebarContent` inside `RightSidebar`. The reducer subtracts this
   * from `viewportHeight` when computing the sidebar scroll clamp so the
   * user can't scroll past the end into blank space when one or more
   * routed twins are mounted. Each twin contributes a per-panel
   * `ESTIMATED_HEIGHT` constant; over-estimation is safe (existing
   * convention — see `SIDEBAR_MISSION_MAX_WRAP_LINES` docstring).
   */
  sidebarTwinRowCount: number;
}

/**
 * Resolve the TUI's right-sidebar layout once from the open-panel flags and
 * persisted panel routing. Both the renderer and input/mouse hit-testing use
 * this so a sidebar-routed panel narrows history consistently instead of
 * being treated as a full-width overlay by one surface.
 */
export function resolveSidebarLayout(
  state: State,
  termCols: number,
  panelPositionsInput: Partial<Record<PanelId, 'bottom' | 'sidebar'>> | undefined,
  mailboxPanelOpen: boolean,
  /**
   * Open flags for each routable panel, used to compute the visible-twin
   * row count for the scroll-clamp reservation. Panels not listed
   * (or `undefined`) are treated as closed. Should mirror the same
   * `sidebarPanelOpenFlags` map built in `app-view.tsx` so the
   * dispatcher and the renderer agree on which twins are mounted.
   */
  sidebarOpenFlags?: Partial<Record<PanelId, boolean>> | undefined,
  /**
   * Legacy `showAgentSwarmPanel === 'sidebar'` flag from the persisted
   * `liveSettings` config — the same field the renderer at
   * `app-view.tsx:897-899` reads (picker draft when open, persisted
   * `liveSettings.showAgentSwarmPanel` when closed) to decide whether
   * the mission card renders on the sidebar. The scroll-clamp
   * reservation must match this source or a config-only 'sidebar'
   * swarm mode (no recent picker open) renders the mission card but
   * the clamp under-reserves, hiding the bottom mission rows behind
   * `RightSidebar`'s `overflowY="hidden"` viewport. OR'd with
   * `panelPositions.fleet === 'sidebar'` for safety (over-reservation
   * is harmless). Defaults to `false` when omitted so existing call
   * sites stay correct.
   */
  legacySwarmOnSidebar?: boolean | undefined,
): SidebarLayoutState {
  const panelPositions: PanelPositionMap = coercePanelPositionMap(panelPositionsInput);
  const routedToSidebar = (id: PanelId): boolean => panelPositions[id] === 'sidebar';

  const overlayOpen =
    isPickerOverlayOpen(state) ||
    (state.coordinator.monitorOpen && !routedToSidebar('coordinator')) ||
    state.auditPanelOpen ||
    (state.connectionsPanelOpen && !routedToSidebar('connections')) ||
    state.helpOpen ||
    (state.agentsMonitorOpen && !routedToSidebar('agents')) ||
    (state.monitorOpen && !routedToSidebar('fleet')) ||
    state.contextPanelOpen ||
    (state.processListOpen && !routedToSidebar('processList')) ||
    (state.todosMonitorOpen && !routedToSidebar('todos')) ||
    (state.worktreeMonitorOpen && !routedToSidebar('worktree')) ||
    (state.planPanelOpen && !routedToSidebar('plan')) ||
    (state.kanbanPanelOpen && !routedToSidebar('kanban')) ||
    (state.queuePanelOpen && !routedToSidebar('queue')) ||
    (state.goalPanelOpen && !routedToSidebar('goal')) ||
    (state.sessionsPanelOpen && !routedToSidebar('sessions')) ||
    (state.projectPicker.open && !routedToSidebar('projectPicker')) ||
    state.goalKanbanPanelOpen ||
    state.cronMonitorOpen ||
    state.rewindOverlay != null ||
    state.shellCommandWarning != null ||
    state.confirmQueue.length > 0 ||
    state.clearConfirm != null ||
    state.exitConfirm != null ||
    state.slashConfirm != null ||
    state.escConfirm != null ||
    state.sendModePicker != null ||
    state.enhance != null ||
    state.enhanceBusy ||
    state.refineCountdown != null ||
    state.refineFailure != null ||
    state.continueConfirm != null ||
    state.brainPrompt != null ||
    mailboxPanelOpen ||
    ((state.goalRun?.monitorOpen ?? false) && !routedToSidebar('coordinator')) ||
    (state.sddBoard?.monitorOpen ?? false);

  const sidebarWidth = overlayOpen ? 0 : computeSidebarWidth(termCols);
  // The swarm panel is on the sidebar iff EITHER:
  //   - `panelPositions.fleet === 'sidebar'` (new per-panel position map,
  //     fed by both the picker draft and persisted config). This field
  //     gates whether the swarm twin is mounted, NOT whether the
  //     mission card renders.
  //   - the legacy `showAgentSwarmPanel === 'sidebar'` field from
  //     `liveSettings` (tri-state AgentSwarmPanelMode carried over from
  //     the pre-panel-position system). THIS field is the one the
  //     renderer at `app-view.tsx:897-899` reads to decide whether to
  //     show the mission card.
  // The OR is directionally safe (over-reservation is harmless) and
  // matches the renderer's source so a config-only legacy 'sidebar'
  // swarm mode (no recent picker open) gets the full mission-queue
  // scroll budget.
  const effectiveSwarmOnSidebar =
    panelPositions.fleet === 'sidebar' || (legacySwarmOnSidebar ?? false);

  // Sum the natural-height row estimate for each routed twin currently
  // mounted above `SidebarContent`. Over-estimating is safe (existing
  // convention); the scroll-clamp subtracts this from viewportHeight so
  // the user can't scroll past the rendered content end into blank space.
  let sidebarTwinRowCount = 0;
  if (sidebarOpenFlags) {
    for (const id of PANEL_IDS) {
      if (routedToSidebar(id) && sidebarOpenFlags[id]) {
        sidebarTwinRowCount += ESTIMATED_TWIN_HEIGHT;
      }
    }
  }

  return {
    panelPositions,
    overlayOpen,
    sidebarWidth,
    sidebarContentWidth: computeSidebarContentWidth(sidebarWidth),
    mainColumnWidth: termCols - sidebarWidth,
    effectiveSwarmOnSidebar,
    sidebarTwinRowCount,
  };
}

/**
 * Conservative row-height estimate for any routed sidebar twin panel.
 * Each twin renders a 1-row header + a 1-row separator + variable content +
 * optional 1-row footer. 8 rows covers the natural height of the
 * content-rich twins (Todos / Plan / Kanban / Goal / Sessions /
 * Coordinator) without overshooting the simpler ones (Fleet / Worktree /
 * etc.). Over-estimation is safe; the scroll-clamp subtracts this from
 * `viewportHeight`.
 */
export const ESTIMATED_TWIN_HEIGHT = 8;
