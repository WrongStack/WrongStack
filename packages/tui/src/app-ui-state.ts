import type { State } from './app-reducer.js';
import { computeSidebarWidth } from './components/sidebar.js';
import type { StatuslineItem } from './components/statusline-picker.js';
import { coercePanelPositionMap, type PanelId, type PanelPositionMap } from './ui-contracts.js';

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
  mainColumnWidth: number;
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
  return {
    panelPositions,
    overlayOpen,
    sidebarWidth,
    mainColumnWidth: termCols - sidebarWidth,
  };
}
