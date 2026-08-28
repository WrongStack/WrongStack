/**
 * Data-driven table of panels/pickers that should close when the user presses
 * Esc. Replaces a hand-maintained `if/if/if` cascade in `app.tsx` that was
 * prone to drift — every new panel had to be added in two places (here and
 * `closePanels`) and several were forgotten.
 *
 * The table is checked in priority order (first match wins). In practice only
 * one panel is open at a time because `closePanels()` enforces mutual
 * exclusivity on open.
 *
 * Panels that own their own Esc handler via a child `useInput` are
 * intentionally absent. Dispatching the toggle from the parent too would
 * double-fire on a single keypress and immediately re-open the panel.
 *
 * Excluded panels (own their own Esc):
 *  - worktreeMonitor  — `isWorktreeMonitorCloseKey` in WorktreeMonitor.tsx
 *  - goalRun monitor — PhaseMonitor owns Esc via its own useInput
 *  - kanbanPanel       — `key.escape || 'q' → onClose` in KanbanPanel.tsx
 *  - goalKanbanPanel   — `key.escape || 'q' → onClose` in GoalKanbanPanel.tsx
 *
 * Several entries below are also caught by earlier handlers (tryPickerKey for
 * settings/project, the helpOpen block, the F10 sessions block). They remain
 * in the table as a safety net in case those earlier handlers change.
 */

import type { Action, State } from './app-reducer.js';

interface EscCloseEntry {
  /** Human-readable name for debugging and tests. */
  name: string;
  /** Whether this panel is currently open. */
  isOpen: (state: State) => boolean;
  /** The action to dispatch to close it (payload-free toggle or close). */
  close: Action;
}

export const ESC_CLOSE_PANELS: readonly EscCloseEntry[] = [
  // Fullscreen monitors first — they hide the chat behind them.
  {
    name: 'agentsMonitor',
    isOpen: (s) => s.agentsMonitorOpen,
    close: { type: 'toggleAgentsMonitor' },
  },
  { name: 'fleetMonitor', isOpen: (s) => s.monitorOpen, close: { type: 'toggleMonitor' } },
  // Non-modal overlays (input stays live behind these).
  {
    name: 'todosMonitor',
    isOpen: (s) => s.todosMonitorOpen,
    close: { type: 'toggleTodosMonitor' },
  },
  { name: 'queuePanel', isOpen: (s) => s.queuePanelOpen, close: { type: 'toggleQueuePanel' } },
  { name: 'processList', isOpen: (s) => s.processListOpen, close: { type: 'toggleProcessList' } },
  { name: 'goalPanel', isOpen: (s) => s.goalPanelOpen, close: { type: 'toggleGoalPanel' } },
  {
    name: 'contextPanel',
    isOpen: (s) => s.contextPanelOpen,
    close: { type: 'toggleContextPanel' },
  },
  {
    name: 'connectionsPanel',
    isOpen: (s) => s.connectionsPanelOpen,
    close: { type: 'toggleConnectionsPanel' },
  },
  { name: 'auditPanel', isOpen: (s) => s.auditPanelOpen, close: { type: 'toggleAuditPanel' } },
  { name: 'planPanel', isOpen: (s) => s.planPanelOpen, close: { type: 'togglePlanPanel' } },
  { name: 'cronMonitor', isOpen: (s) => s.cronMonitorOpen, close: { type: 'toggleCronMonitor' } },
  {
    name: 'sddBoard',
    isOpen: (s) => s.sddBoard?.monitorOpen ?? false,
    close: { type: 'toggleSddBoardMonitor' },
  },
  {
    name: 'coordinator',
    isOpen: (s) => s.coordinator.monitorOpen,
    close: { type: 'toggleCoordinatorMonitor' },
  },
  {
    name: 'sessionsPanel',
    isOpen: (s) => s.sessionsPanelOpen,
    close: { type: 'toggleSessionsPanel' },
  },
  // Modal pickers (also handled by tryPickerKey — safety net).
  {
    name: 'settingsPicker',
    isOpen: (s) => s.settingsPicker.open,
    close: { type: 'settingsClose' },
  },
  {
    name: 'projectPicker',
    isOpen: (s) => s.projectPicker.open,
    close: { type: 'projectPickerClose' },
  },
  { name: 'helpOverlay', isOpen: (s) => s.helpOpen, close: { type: 'toggleHelp' } },
];

/**
 * Find the first open panel in the Esc-close table and return its close action.
 * Returns `null` when no panel is open. Called from the app-level `handleKey`
 * when Esc is pressed and no earlier handler (tryPickerKey, helpOverlay block,
 * F-key toggles) has consumed the key — BEFORE the busy-interrupt ladder, so
 * Esc with a panel open means "close this panel", never "abort the run".
 */
export function escCloseAction(state: State): Action | null {
  for (const entry of ESC_CLOSE_PANELS) {
    if (entry.isOpen(state)) return entry.close;
  }
  return null;
}

/**
 * Panels excluded from ESC_CLOSE_PANELS because their own `useInput` owns Esc
 * (they need local state to interpret it — e.g. the kanban panel's inline
 * prompt cancels on Esc instead of closing the panel). While one of these is
 * open the central handler must still CONSUME Esc — otherwise the broadcast
 * `useInput` model means the panel closes AND the busy-interrupt ladder aborts
 * the run on the same keypress.
 */
export function escSelfOwnedPanelOpen(state: State): boolean {
  return (
    state.worktreeMonitorOpen ||
    state.kanbanPanelOpen ||
    state.goalKanbanPanelOpen ||
    (state.goalRun?.monitorOpen ?? false)
  );
}
