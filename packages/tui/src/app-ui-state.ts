import type { State } from './app-reducer.js';
import type { AgentSwarmPanelMode, Settings } from './app-settings-type.js';
import { computeSidebarContentWidth, computeSidebarWidth } from './components/sidebar.js';
import type { StatuslineItem } from './components/statusline-picker.js';
import { sumSidebarTwinRowCount } from './sidebar-sizing.js';
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
    state.themePicker.open ||
    state.skillPicker.open ||
    state.resourceMenu.open ||
    state.picker.open
  );
}

/**
 * Single authority for "where does panel routing come from?". While the
 * settings picker is open, the picker's draft (updated on every ←/→ press)
 * wins so all surfaces track the user's in-flight edits synchronously; when
 * it is closed, the persisted `liveSettings.panelPositions` is the only
 * source that survives across sessions (the reducer's copy is initialized
 * to defaults on boot and never hydrated from disk outside the picker).
 *
 * Every surface that needs panel routing — the dispatcher (`app.tsx`), the
 * renderer (`app-view.tsx`), and the bottom-region suppression
 * (`app-status-region.tsx`) — must read through this helper (or
 * `resolveAppSidebarLayout`). Reading `liveSettings?.panelPositions`
 * directly re-introduces the split-brain where the sidebar twin mounts from
 * the picker draft while the bottom region still renders from persisted
 * config, double-rendering the panel.
 */
function effectivePanelPositionsInput(
  state: State,
  liveSettings: Settings | undefined,
): Partial<PanelPositionMap> | undefined {
  return state.settingsPicker.open
    ? state.settingsPicker.panelPositions
    : liveSettings?.panelPositions;
}

/** Coerced form of {@link effectivePanelPositionsInput} for direct map reads. */
export function effectivePanelPositions(
  state: State,
  liveSettings: Settings | undefined,
): PanelPositionMap {
  return coercePanelPositionMap(effectivePanelPositionsInput(state, liveSettings));
}

/**
 * Pure dual-source read for the legacy tri-state swarm panel mode: the
 * picker draft wins while the settings picker is open, the persisted value
 * (defaulting to 'bottom') otherwise. Prefer
 * {@link effectiveAgentSwarmPanelMode} at call sites that hold `State`.
 */
export function resolveAgentSwarmPanelVisibility(
  settingsOpen: boolean,
  pickerValue: AgentSwarmPanelMode,
  persistedValue: AgentSwarmPanelMode | undefined,
): AgentSwarmPanelMode {
  return settingsOpen ? pickerValue : (persistedValue ?? 'bottom');
}

/** {@link resolveAgentSwarmPanelVisibility} bound to app state + live settings. */
export function effectiveAgentSwarmPanelMode(
  state: State,
  liveSettings: Settings | undefined,
): AgentSwarmPanelMode {
  return resolveAgentSwarmPanelVisibility(
    state.settingsPicker.open,
    state.settingsPicker.showAgentSwarmPanel,
    liveSettings?.showAgentSwarmPanel,
  );
}

/**
 * Pure dual-source read for the right-sidebar master switch: the picker
 * draft wins while the settings picker is open, the persisted value
 * (defaulting to true) otherwise. Boolean mirror of {@link
 * resolveAgentSwarmPanelVisibility}.
 */
export function resolveShowSidebarVisibility(
  settingsOpen: boolean,
  pickerValue: boolean,
  persistedValue: boolean | undefined,
): boolean {
  return settingsOpen ? pickerValue : (persistedValue ?? true);
}

/** {@link resolveShowSidebarVisibility} bound to app state + live settings. */
export function effectiveShowSidebar(state: State, liveSettings: Settings | undefined): boolean {
  return resolveShowSidebarVisibility(
    state.settingsPicker.open,
    state.settingsPicker.showSidebar,
    liveSettings?.showSidebar,
  );
}

/**
 * Open flags for each routable panel — which twins are candidates for a
 * sidebar slot. Shared by the dispatcher and the renderer so the
 * scroll-clamp reservation in `resolveSidebarLayout` and the actual twin
 * mounting in `app-view.tsx` can never disagree about which panels are
 * open. The agents slot honors the legacy `showAgentSwarmPanel: 'off'`
 * tri-state (an explicitly hidden swarm panel must not occupy a slot), and
 * the coordinator slot stays reachable from both entry points: Ctrl+P
 * (goalRunMonitorToggle) opens the phase monitor WITHOUT setting
 * `coordinator.monitorOpen` — `closePanels` resets the latter.
 */
export function buildSidebarOpenFlags(
  state: State,
  liveSettings: Settings | undefined,
): Partial<Record<PanelId, boolean>> {
  return {
    projectPicker: state.projectPicker.open,
    fleet: state.monitorOpen,
    agents: state.agentsMonitorOpen && effectiveAgentSwarmPanelMode(state, liveSettings) !== 'off',
    worktree: state.worktreeMonitorOpen,
    plan: state.planPanelOpen,
    todos: state.todosMonitorOpen,
    queue: state.queuePanelOpen,
    processList: state.processListOpen,
    goal: state.goalPanelOpen,
    sessions: state.sessionsPanelOpen,
    coordinator: state.coordinator.monitorOpen || (state.goalRun?.monitorOpen ?? false),
    kanban: state.kanbanPanelOpen,
    connections: state.connectionsPanelOpen,
  };
}

/**
 * The one way to compute the sidebar layout from app state. Bundles the
 * dual-source panel-position read, the shared open-flags map, and the
 * legacy swarm-mode flag so the dispatcher (`app.tsx`) and the renderer
 * (`app-view.tsx`) call `resolveSidebarLayout` with byte-identical inputs.
 * Before this wrapper existed the two sites drifted: the dispatcher never
 * saw the picker draft and the renderer never passed the open flags.
 */
export function resolveAppSidebarLayout(
  state: State,
  termCols: number,
  liveSettings: Settings | undefined,
  mailboxPanelOpen: boolean,
): SidebarLayoutState {
  return resolveSidebarLayout(
    state,
    termCols,
    effectivePanelPositionsInput(state, liveSettings),
    mailboxPanelOpen,
    buildSidebarOpenFlags(state, liveSettings),
    effectiveAgentSwarmPanelMode(state, liveSettings) === 'sidebar',
    effectiveShowSidebar(state, liveSettings),
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
function resolveSidebarLayout(
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
  /**
   * Master visibility switch for the right sidebar, resolved dual-source
   * by {@link resolveAppSidebarLayout} (picker draft while the settings
   * picker is open, persisted `liveSettings.showSidebar` otherwise;
   * default true). When false the sidebar width collapses to 0 so chat
   * history takes the full terminal width, regardless of routed twins
   * or the swarm mode.
   */
  showSidebar?: boolean | undefined,
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
    state.fallbackOverlay != null ||
    state.shellCommandWarning != null ||
    state.confirmQueue.length > 0 ||
    state.clearConfirm != null ||
    state.exitConfirm != null ||
    state.slashConfirm != null ||
    state.escConfirm != null ||
    state.sendModePicker != null ||
    state.enhance != null ||
    state.enhanceBusy ||
    state.topicCheckBusy ||
    state.refineCountdown != null ||
    state.refineFailure != null ||
    state.continueConfirm != null ||
    state.brainPrompt != null ||
    mailboxPanelOpen ||
    ((state.goalRun?.monitorOpen ?? false) && !routedToSidebar('coordinator')) ||
    (state.sddBoard?.monitorOpen ?? false);

  // Dual-source master switch (see the showSidebar param doc): collapsed
  // BEFORE computeSidebarWidth so a hidden sidebar can never reserve
  // columns. `undefined` defaults to visible — old callers that never
  // pass the flag keep the pre-gating behavior.
  const sidebarWidth =
    overlayOpen || showSidebar === false ? 0 : computeSidebarWidth(termCols);
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
    showSidebar !== false &&
    (panelPositions.fleet === 'sidebar' || (legacySwarmOnSidebar ?? false));

  // Sum the conservative natural-height budget for each routed twin mounted
  // above `SidebarContent`. Worklist twins can wrap at the 16-column floor, so
  // one global eight-row estimate under-reserves them and makes lower persistent
  // content unreachable. The per-panel table mirrors each variant's maximum
  // rendered rows while retaining the existing finite wrap ceiling.
  let sidebarTwinRowCount = 0;
  if (sidebarOpenFlags) {
    sidebarTwinRowCount = sumSidebarTwinRowCount(
      PANEL_IDS.filter((id) => routedToSidebar(id) && sidebarOpenFlags[id]),
    );
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

// Per-panel natural-height budgets live in `./sidebar-sizing.js`; import the
// `SIDEBAR_TWIN_HEIGHT_BY_PANEL` constant and `sumSidebarTwinRowCount()` helper
// directly from that module. `SIDEBAR_TWIN_MAX_WRAP_LINES` lives in
// `./ui-contracts.js` next to the routing constants.
