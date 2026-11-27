import type { Action } from './app-action-type.js';
import type { State } from './app-state.js';
import type { StatuslineItem } from './components/statusline-picker.js';
import type { PanelId, PanelPositionMap } from './ui-contracts.js';

/** The bottom panel owns input; sidebar twins leave the composer available. */
export function activeBottomFKeyPanel(state: State, positions: PanelPositionMap): number | null {
  const panels: [PanelId, boolean][] = [
    ['projectPicker', state.projectPicker.open],
    ['fleet', state.monitorOpen],
    ['agents', state.agentsMonitorOpen],
    ['worktree', state.worktreeMonitorOpen],
    ['plan', state.planPanelOpen],
    ['todos', state.todosMonitorOpen],
    ['queue', state.queuePanelOpen],
    ['processList', state.processListOpen],
    ['goal', state.goalPanelOpen],
    ['sessions', state.sessionsPanelOpen],
    ['coordinator', state.coordinator.monitorOpen],
    ['kanban', state.kanbanPanelOpen],
  ];
  const index = panels.findIndex(([id, open]) => open && positions[id] !== 'sidebar');
  return index < 0 ? null : index + 1;
}

export type FKeyPanelAction =
  | 'projectPickerOpen'
  | 'toggleMonitor'
  | 'toggleAgentsMonitor'
  | 'toggleWorktreeMonitor'
  | 'togglePlanPanel'
  | 'toggleTodosMonitor'
  | 'toggleQueuePanel'
  | 'toggleProcessList'
  | 'toggleKanbanPanel'
  | 'toggleGoalPanel'
  | 'toggleSessionsPanel'
  | 'toggleCoordinatorMonitor'
  | 'toggleCronMonitor'
  | 'toggleConnectionsPanel'
  | 'statuslineOpen';

/** Host-side action keys that require work beyond a reducer dispatch. */
type FKeyHostAction = 'openProjectPicker' | 'loadLiveSessions' | 'openStatuslinePicker';

/** A single F-key panel entry shared by the picker, help overlay, and tests. */
export interface FKeyPanelEntry {
  key: number;
  label: string;
  action: FKeyPanelAction;
  /** Shortcut label for user-facing help, including Ctrl aliases when available. */
  helpKeys: string;
  /** Short user-facing description for the help overlay. */
  helpDescription: string;
  /** Optional Ctrl+letter chord alias (e.g. 'f' for Ctrl+F → F2). */
  ctrlAlias?: string | undefined;
  /** When present, this entry needs host-side work instead of (or in addition
   *  to) a direct reducer dispatch. The caller resolves these. */
  hostAction?: FKeyHostAction | undefined;
}

/** F-key panels and slash-command panels in display order. */
export const F_KEY_PANEL_ENTRIES: readonly FKeyPanelEntry[] = [
  {
    key: 1,
    label: 'Project switcher',
    action: 'projectPickerOpen',
    helpKeys: 'F1 or /project',
    helpDescription: 'project switcher (F1 may open terminal help)',
    hostAction: 'openProjectPicker',
  },
  {
    key: 2,
    label: 'Fleet orchestration monitor',
    action: 'toggleMonitor',
    helpKeys: 'F2 or Ctrl+F',
    helpDescription: 'fleet monitor (Ctrl+F may be terminal Find)',
    ctrlAlias: 'f',
  },
  {
    key: 3,
    label: 'Agents live monitor',
    action: 'toggleAgentsMonitor',
    helpKeys: 'F3 or Ctrl+G',
    helpDescription: 'agents live monitor (F3 is safer)',
    ctrlAlias: 'g',
  },
  {
    key: 4,
    label: 'Worktree monitor',
    action: 'toggleWorktreeMonitor',
    helpKeys: 'F4, Ctrl+T or /worktree',
    helpDescription: 'worktree monitor (Ctrl+T may be reserved)',
    ctrlAlias: 't',
  },
  {
    key: 5,
    label: 'Plan panel',
    action: 'togglePlanPanel',
    helpKeys: 'F5 or /plan',
    helpDescription: 'plan panel (F5 may be host refresh/run)',
  },
  {
    key: 6,
    label: 'Todos monitor overlay',
    action: 'toggleTodosMonitor',
    helpKeys: 'F6',
    helpDescription: 'todos monitor overlay',
  },
  {
    key: 7,
    label: 'Queue panel',
    action: 'toggleQueuePanel',
    helpKeys: 'F7',
    helpDescription: 'queue panel',
  },
  {
    key: 8,
    label: 'Process list overlay',
    action: 'toggleProcessList',
    helpKeys: 'F8',
    helpDescription: 'process list overlay',
  },
  {
    key: 9,
    label: 'Goal panel',
    action: 'toggleGoalPanel',
    helpKeys: 'F9',
    helpDescription: 'goal panel',
  },
  {
    key: 10,
    label: 'Live sessions panel',
    action: 'toggleSessionsPanel',
    helpKeys: 'F10 or /resume',
    helpDescription: 'live sessions panel (F10 may open host menu)',
    hostAction: 'loadLiveSessions',
  },
  {
    key: 11,
    label: 'Coordinator monitor',
    action: 'toggleCoordinatorMonitor',
    helpKeys: 'F11 or /coordinator',
    helpDescription: 'coordinator monitor (F11 may toggle fullscreen)',
  },
  {
    key: 12,
    label: 'Kanban board panel',
    action: 'toggleKanbanPanel',
    helpKeys: 'F12 or Ctrl+Y',
    helpDescription: 'kanban board panel (also /kanban)',
  },
  {
    key: 0,
    label: 'Service connections',
    action: 'toggleConnectionsPanel',
    helpKeys: 'Ctrl+N or /connections',
    helpDescription: 'service connection health panel (Ctrl+N)',
    ctrlAlias: 'n',
  },
];

type FKeyDispatchAction = Extract<
  Action,
  | { type: 'toggleMonitor' }
  | { type: 'toggleAgentsMonitor' }
  | { type: 'toggleWorktreeMonitor' }
  | { type: 'togglePlanPanel' }
  | { type: 'toggleTodosMonitor' }
  | { type: 'toggleQueuePanel' }
  | { type: 'toggleProcessList' }
  | { type: 'toggleKanbanPanel' }
  | { type: 'toggleGoalPanel' }
  | { type: 'toggleSessionsPanel' }
  | { type: 'toggleCoordinatorMonitor' }
  | { type: 'toggleCronMonitor' }
  | { type: 'toggleConnectionsPanel' }
  | { type: 'statuslineOpen' }
>;

/** Payload-free panel actions, as a const tuple so membership narrows the
 *  action type (a `Set.has` check cannot narrow, which previously forced an
 *  unsound cast). Every member maps to a `{ type }`-only reducer action. */
const PAYLOAD_FREE_ACTIONS = [
  'toggleMonitor',
  'toggleAgentsMonitor',
  'toggleWorktreeMonitor',
  'togglePlanPanel',
  'toggleTodosMonitor',
  'toggleQueuePanel',
  'toggleProcessList',
  'toggleKanbanPanel',
  'toggleGoalPanel',
  'toggleSessionsPanel',
  'toggleCoordinatorMonitor',
  'toggleCronMonitor',
  'toggleConnectionsPanel',
] as const;

type PayloadFreeFKeyAction = (typeof PAYLOAD_FREE_ACTIONS)[number];

function isPayloadFreeAction(action: FKeyPanelAction): action is PayloadFreeFKeyAction {
  return (PAYLOAD_FREE_ACTIONS as readonly FKeyPanelAction[]).includes(action);
}

/**
 * Find the F-key panel entry matching the pressed key — either a plain
 * function key (1–12) or a Ctrl+letter chord alias. Returns null if no
 * entry matches.
 */
export function fKeyEntryFor(
  fn: number | undefined,
  ctrl: boolean | undefined,
  input: string,
): FKeyPanelEntry | null {
  if (fn !== undefined && fn >= 1 && fn <= 12) {
    return F_KEY_PANEL_ENTRIES[fn - 1] ?? null;
  }
  if (ctrl && input) {
    return F_KEY_PANEL_ENTRIES.find((e) => e.ctrlAlias === input) ?? null;
  }
  return null;
}

/**
 * Convert a picker entry into the reducer action it can dispatch directly.
 * Returns null for entries that need host-side work before dispatching, such as
 * F1/projectPickerOpen, which must load project items before opening.
 */
export function actionForFKeyPanel(
  entry: FKeyPanelEntry,
  hiddenItems: readonly StatuslineItem[] = [],
): FKeyDispatchAction | null {
  if (entry.action === 'projectPickerOpen') return null;
  if (entry.action === 'statuslineOpen') {
    return { type: 'statuslineOpen', hiddenItems: [...hiddenItems] };
  }
  if (isPayloadFreeAction(entry.action)) {
    return { type: entry.action };
  }
  return null;
}
