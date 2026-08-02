import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';
import { retainCheckpoints } from '../checkpoint-retention.js';
import type { WorktreeRow } from '../ui-contracts.js';
import { closePanels } from './helpers.js';

const workspacePanelActionTypes = [
  'toggleMonitor',
  'toggleAgentsMonitor',
  'toggleHelp',
  'toggleTodosMonitor',
  'toggleQueuePanel',
  'toggleProcessList',
  'toggleCronMonitor',
  'togglePlanPanel',
  'closeAllPanels',
  'toggleSidebarFocus',
  'sidebarScroll',
  'sidebarScrollReset',
  'toggleKanbanPanel',
  'toggleGoalPanel',
  'toggleGoalKanbanPanel',
  'toggleContextPanel',
  'toggleConnectionsPanel',
  'checkpointReceived',
  'rewindOverlayOpen',
  'rewindOverlayClose',
  'rewindOverlayMove',
  'sessionRewound',
  'eternalStage',
  'goalSummary',
  'goalRunInit',
  'goalRunPhaseUpdate',
  'goalRunTaskActive',
  'goalRunRunningPhases',
  'goalRunElapsed',
  'goalRunMonitorToggle',
  'goalRunReset',
  'sddBoardSnapshot',
  'toggleSddBoardMonitor',
  'sddBoardFocusNext',
  'sddBoardFocusPrev',
  'worktreeUpsert',
  'worktreeRemove',
  'toggleWorktreeMonitor',
] as const satisfies readonly Action['type'][];

type WorkspacePanelAction = Extract<
  Action,
  { type: (typeof workspacePanelActionTypes)[number] }
>;

const workspacePanelActionTypeSet = new Set<string>(workspacePanelActionTypes);

export function isWorkspacePanelAction(action: Action): action is WorkspacePanelAction {
  return workspacePanelActionTypeSet.has(action.type);
}

/** Reduces mutually exclusive workspace panels and goal/SDD/worktree views. */
export function reduceWorkspacePanels(state: State, action: WorkspacePanelAction): State {
  switch (action.type) {
    case 'toggleMonitor': {
      const opening = !state.monitorOpen;
      return opening
        ? { ...state, ...closePanels(state), monitorOpen: true }
        : { ...state, monitorOpen: false };
    }
    case 'toggleAgentsMonitor': {
      const opening = !state.agentsMonitorOpen;
      return opening
        ? { ...state, ...closePanels(state), agentsMonitorOpen: true }
        : { ...state, agentsMonitorOpen: false };
    }
    case 'toggleHelp': {
      const opening = !state.helpOpen;
      return opening
        ? { ...state, ...closePanels(state), helpOpen: true }
        : { ...state, helpOpen: false };
    }
    case 'toggleTodosMonitor': {
      const opening = !state.todosMonitorOpen;
      return opening
        ? { ...state, ...closePanels(state), todosMonitorOpen: true }
        : { ...state, todosMonitorOpen: false };
    }
    case 'toggleQueuePanel': {
      const opening = !state.queuePanelOpen;
      return opening
        ? { ...state, ...closePanels(state), queuePanelOpen: true }
        : { ...state, queuePanelOpen: false };
    }
    case 'toggleProcessList': {
      const opening = !state.processListOpen;
      return opening
        ? { ...state, ...closePanels(state), processListOpen: true }
        : { ...state, processListOpen: false };
    }
    case 'toggleCronMonitor': {
      const opening = !state.cronMonitorOpen;
      return opening
        ? { ...state, ...closePanels(state), cronMonitorOpen: true }
        : { ...state, cronMonitorOpen: false };
    }
    case 'togglePlanPanel': {
      const opening = !state.planPanelOpen;
      return opening
        ? { ...state, ...closePanels(state), planPanelOpen: true }
        : { ...state, planPanelOpen: false };
    }
    case 'closeAllPanels':
      return { ...state, ...closePanels(state), sidebarFocused: false };
    case 'toggleSidebarFocus':
      // Reset scroll offset when unfocusing so re-focus starts at top.
      return state.sidebarFocused
        ? { ...state, sidebarFocused: false, sidebarScrollOffset: 0 }
        : { ...state, sidebarFocused: true };
    case 'sidebarScroll':
      return {
        ...state,
        // Conservative clamp: content rarely exceeds ~50 rows at full load.
        // For short content the user may scroll a few rows past — acceptable
        // since overflowY="hidden" clips and re-focus resets to 0.
        sidebarScrollOffset: Math.min(
          50,
          Math.max(0, state.sidebarScrollOffset + action.delta),
        ),
      };
    case 'sidebarScrollReset':
      return { ...state, sidebarScrollOffset: 0 };
    case 'toggleKanbanPanel': {
      const opening = !state.kanbanPanelOpen;
      return opening
        ? { ...state, ...closePanels(state), kanbanPanelOpen: true }
        : { ...state, kanbanPanelOpen: false };
    }
    case 'toggleGoalPanel': {
      const opening = !state.goalPanelOpen;
      return opening
        ? { ...state, ...closePanels(state), goalPanelOpen: true }
        : { ...state, goalPanelOpen: false };
    }
    case 'toggleGoalKanbanPanel': {
      const opening = !state.goalKanbanPanelOpen;
      return opening
        ? { ...state, ...closePanels(state), goalKanbanPanelOpen: true }
        : { ...state, goalKanbanPanelOpen: false };
    }
    case 'toggleContextPanel': {
      const opening = !state.contextPanelOpen;
      return opening
        ? { ...state, ...closePanels(state), contextPanelOpen: true }
        : { ...state, contextPanelOpen: false };
    }
    case 'toggleConnectionsPanel': {
      const opening = !state.connectionsPanelOpen;
      return opening
        ? { ...state, ...closePanels(state), connectionsPanelOpen: true }
        : { ...state, connectionsPanelOpen: false };
    }
    case 'checkpointReceived': {
      const existing = state.checkpoints.find((c) => c.promptIndex === action.cp.promptIndex);
      if (existing) return state;
      return { ...state, checkpoints: retainCheckpoints([...state.checkpoints, action.cp]) };
    }
    case 'rewindOverlayOpen':
      return {
        ...state,
        rewindOverlay: { checkpoints: state.checkpoints, selected: state.checkpoints.length - 1 },
      };
    case 'rewindOverlayClose':
      return { ...state, rewindOverlay: null };
    case 'rewindOverlayMove': {
      if (!state.rewindOverlay) return state;
      const len = state.rewindOverlay.checkpoints.length;
      if (len === 0) return { ...state, rewindOverlay: null };
      const selected = Math.max(0, Math.min(len - 1, state.rewindOverlay.selected + action.delta));
      return { ...state, rewindOverlay: { ...state.rewindOverlay, selected } };
    }
    case 'sessionRewound':
      return {
        ...state,
        checkpoints: state.checkpoints.filter((c) => c.promptIndex <= action.toPromptIndex),
        rewindOverlay: null,
      };
    case 'eternalStage':
      return { ...state, eternalStage: action.stage };
    case 'goalSummary':
      return { ...state, goalSummary: action.summary };
    case 'goalRunInit':
      return {
        ...state,
        goalRun: {
          title: action.title,
          phases: {},
          runningPhaseIds: [],
          elapsedMs: 0,
          monitorOpen: false,
        },
      };
    case 'goalRunPhaseUpdate': {
      const existing = state.goalRun ?? {
        title: 'Goal',
        phases: {},
        runningPhaseIds: [],
        elapsedMs: 0,
        monitorOpen: false,
      };
      return {
        ...state,
        goalRun: {
          ...existing,
          phases: {
            ...existing.phases,
            [action.phaseId]: {
              name: action.name,
              status: action.status,
              completedTasks: action.completedTasks,
              totalTasks: action.totalTasks,
              startedAt: action.startedAt,
              activeTasks: existing.phases[action.phaseId]?.activeTasks,
            },
          },
        },
      };
    }
    case 'goalRunTaskActive': {
      if (!state.goalRun) return state;
      const phase = state.goalRun.phases[action.phaseId];
      if (!phase) return state;
      const without = (phase.activeTasks ?? []).filter((t) => t.taskId !== action.taskId);
      const activeTasks = action.active
        ? [...without, { taskId: action.taskId, title: action.title, agent: action.agent }]
        : without;
      return {
        ...state,
        goalRun: {
          ...state.goalRun,
          phases: {
            ...state.goalRun.phases,
            [action.phaseId]: { ...phase, activeTasks },
          },
        },
      };
    }
    case 'goalRunRunningPhases':
      return state.goalRun
        ? { ...state, goalRun: { ...state.goalRun, runningPhaseIds: action.phaseIds } }
        : state;
    case 'goalRunElapsed':
      return state.goalRun
        ? { ...state, goalRun: { ...state.goalRun, elapsedMs: action.ms } }
        : state;
    case 'goalRunMonitorToggle': {
      if (!state.goalRun) return state;
      const opening = !state.goalRun.monitorOpen;
      return opening
        ? { ...state, ...closePanels(state), goalRun: { ...state.goalRun, monitorOpen: true } }
        : { ...state, goalRun: { ...state.goalRun, monitorOpen: false } };
    }
    case 'goalRunReset':
      return { ...state, goalRun: null };
    case 'sddBoardSnapshot': {
      const monitorOpen = state.sddBoard?.monitorOpen ?? false;
      const prevFocus = state.sddBoard?.focusColumn;
      const focusColumn =
        typeof prevFocus === 'number' &&
        prevFocus >= 0 &&
        prevFocus < action.snapshot.columns.length
          ? prevFocus
          : undefined;
      return { ...state, sddBoard: { snapshot: action.snapshot, monitorOpen, focusColumn } };
    }
    case 'toggleSddBoardMonitor': {
      if (!state.sddBoard) return state;
      const opening = !state.sddBoard.monitorOpen;
      return opening
        ? { ...state, ...closePanels(state), sddBoard: { ...state.sddBoard, monitorOpen: true } }
        : {
            ...state,
            sddBoard: { ...state.sddBoard, monitorOpen: false, focusColumn: undefined },
          };
    }
    case 'sddBoardFocusNext': {
      if (!state.sddBoard?.monitorOpen) return state;
      const max = state.sddBoard.snapshot.columns.length - 1;
      if (max < 0) return state;
      const current = state.sddBoard.focusColumn;
      const next = typeof current === 'number' ? Math.min(max, current + 1) : 0;
      return { ...state, sddBoard: { ...state.sddBoard, focusColumn: next } };
    }
    case 'sddBoardFocusPrev': {
      if (!state.sddBoard?.monitorOpen) return state;
      const current = state.sddBoard.focusColumn;
      if (typeof current !== 'number') return state;
      const next = current <= 0 ? undefined : current - 1;
      return { ...state, sddBoard: { ...state.sddBoard, focusColumn: next } };
    }
    case 'worktreeUpsert': {
      const prev = state.worktrees[action.handleId];
      const merged: WorktreeRow & { baseBranch?: string | undefined } = {
        branch: '',
        ownerLabel: '',
        status: 'active',
        insertions: 0,
        deletions: 0,
        files: 0,
        allocatedAt: Date.now(),
        ...prev,
        ...action.row,
      };
      return {
        ...state,
        worktrees: { ...state.worktrees, [action.handleId]: merged },
        worktreeBase: action.baseBranch ?? state.worktreeBase,
      };
    }
    case 'worktreeRemove': {
      if (!state.worktrees[action.handleId]) return state;
      const next = { ...state.worktrees };
      delete next[action.handleId];
      return { ...state, worktrees: next };
    }
    case 'toggleWorktreeMonitor': {
      const opening = !state.worktreeMonitorOpen;
      return opening
        ? { ...state, ...closePanels(state), worktreeMonitorOpen: true }
        : { ...state, worktreeMonitorOpen: false };
    }
    default:
      void (action satisfies never);
      return state;
  }
}
