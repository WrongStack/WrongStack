import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';
import { retainCheckpoints } from '../checkpoint-retention.js';
import { SIDEBAR_MISSION_ROWS, type WorktreeRow } from '../ui-contracts.js';
import { closePanels } from './helpers.js';

/**
 * Worst-case terminal rows a single mission-row label can occupy after Ink
 * wraps it, used as the wrap multiplier for `computeMaxSidebarScroll()`'s
 * mission-queue reservation. The mission queue renders up to
 * {@link SIDEBAR_MISSION_ROWS} rows in `SidebarContent`; mission labels are
 * full todo content (not pre-truncated) so each row may span multiple
 * lines when the rail is narrow.
 *
 * 10 is an over-estimate chosen for safety, not an observed measurement.
 * The longest label actually exercised in `tests/sidebar-worklist-wrap.test.tsx`
 * is the 71-char `PlanPanelSidebar` title "Polish the narrow-rail wrap behavior
 * so plan steps stay legible", which wraps to ~6 lines at the minimum 16-col
 * sidebar. Real leader-authored todos can run longer (the test fixture's
 * "Resync the keyboard shortcuts document with the v0.42 release notes" is
 * 71 chars and wraps to ~6 lines too), but anything beyond 10 lines would
 * require a 140+ char free-form label. Over-estimating is safe — it simply
 * leaves a little blank space at the bottom of the scroll range.
 *
 * Known follow-up: the multiplier is width-blind, so at wide terminals
 * (≥ 100 cols → rail 25 → content 21 cols) the user can scroll a few dozen
 * rows past the actual content end. A future revision could thread
 * `sidebarContentWidth` through the `sidebarScroll` action and scale this
 * constant by an approximate line count for the widest labels. If you
 * change this constant, update the pinned assertion in
 * `tests/sidebar-worklist-wrap.test.tsx` (the scroll-clamp regression test)
 * to match.
 */
const SIDEBAR_MISSION_MAX_WRAP_LINES = 10;

/**
 * Estimate the maximum useful sidebar scroll offset — i.e. how many rows of
 * content exist beyond what the sidebar can display at once. This prevents
 * scrolling past the end into blank space.
 *
 * Layout (mirrors the card layout in SidebarContent in sidebar-content.tsx).
 * Each section is a "card" whose marginBottom gap is counted here too, keeping
 * the ↑↓ scroll clamp aligned with the rendered layout (over-estimating is safe
 * — a little blank space at the end; under-estimating clips content):
 *   - Context card: 3 rows (header + meter + tokens) + 1 margin
 *   - Model card: 2 rows (header + value) + 1 margin, if present
 *   - Fleet card: 2 rows (header + summary); margin 0 if agent rows follow
 *   - Agent rows: 2 rows each (name+ctx% / status+tool), capped at 12 agents,
 *     + 1 "+N more" overflow row + 1 margin
 *   - Mission Queue card: 1 header + up to SIDEBAR_MISSION_ROWS todo rows
 *     (each row may wrap to up to SIDEBAR_MISSION_MAX_WRAP_LINES lines at
 *     narrow widths) + 1 overflow + 1 margin
 *   - Sessions card: 1 header + up to 3 live + up to 3 resume, + 1 gap when
 *     both subsections are present (no bottom margin)
 *   - Focus indicator: 1 row + 1 margin, if focused
 *
 * @param state Current app state
 * @param viewportHeight Visible sidebar height in rows (terminal height minus
 *   border 2 + padding). Falls back to 20 when not provided.
 * @returns Maximum scroll offset (always >= 0)
 */
function computeMaxSidebarScroll(state: State, viewportHeight = 20): number {
  let contentHeight = 0;

  // Context card: header + meter + tokens (3) + marginBottom (1)
  contentHeight += 4;

  // Model card: header + value (2) + marginBottom (1) — treated as always present
  contentHeight += 3;

  // Fleet card + agent rows
  const fleetEntries = Object.values(state.fleet);
  const leader = fleetEntries.find(
    (e) => e.id === 'leader' || e.name === 'Leader Agent',
  );
  const runningSubagents = fleetEntries
    .filter((e) => e !== leader)
    .filter((e) => e.status === 'running');
  const agentCap = leader ? 11 : 12;
  const shownAgents = (leader ? 1 : 0) + Math.min(runningSubagents.length, agentCap);
  const hasAgents = shownAgents > 0;
  // Fleet card: header + summary (2). marginBottom is 0 when agent rows follow,
  // otherwise 1.
  contentHeight += 2 + (hasAgents ? 0 : 1);
  if (hasAgents) {
    // Agent rows: 2 lines each, + "+N more" overflow row, + marginBottom (1)
    contentHeight += shownAgents * 2;
    if (runningSubagents.length > agentCap) contentHeight += 1;
    contentHeight += 1;
  }

  // Mission Queue card (only when the swarm panel mode is 'sidebar').
  // Note: todos are a runtime prop (liveTodos), not in state, so we reserve the
  // worst case: header + (SIDEBAR_MISSION_ROWS rows × MAX_WRAP_LINES per row)
  // + overflow row + marginBottom. Each rendered mission label can soft-wrap
  // onto multiple rows at narrow widths (see sidebar-content.tsx — labels pass
  // through unmodified), so the scroll budget must account for that expansion.
  // The gate reads the settings-picker draft, which matches the renderer while
  // the picker is open. When the picker is closed the renderer falls back to
  // live settings (app-view.tsx) which the reducer cannot read, so this reserve
  // is exact once the draft reflects the live mode; until then a never-opened
  // 'sidebar' config may under-reserve these rows.
  const swarmMode = state.settingsPicker.showAgentSwarmPanel;
  if (swarmMode === 'sidebar') {
    contentHeight += 1 + SIDEBAR_MISSION_ROWS * SIDEBAR_MISSION_MAX_WRAP_LINES + 1 + 1;
  }

  // Sessions card: header + up to 3 live + up to 3 resume (marginBottom 0),
  // plus the 1-row marginTop gap between the live and resume subsections when
  // both are present.
  const liveSessionCount = state.sessionsPanel.sessions.length;
  const resumeSessionCount = state.resumePicker.sessions.length;
  if (liveSessionCount > 0 || resumeSessionCount > 0) {
    contentHeight += 1;
    contentHeight += Math.min(3, liveSessionCount);
    contentHeight += Math.min(3, resumeSessionCount);
    if (liveSessionCount > 0 && resumeSessionCount > 0) contentHeight += 1;
  }

  // Focus indicator: 1 row + marginBottom (1)
  if (state.sidebarFocused) contentHeight += 2;

  return Math.max(0, contentHeight - viewportHeight);
}

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
    case 'sidebarScroll': {
      // Dynamic upper clamp: estimate the sidebar content height from the
      // current state so the user can't scroll past the end into blank space.
      // The caller passes viewportHeight (terminal height minus sidebar
      // border+padding) when available; falls back to 20.
      const maxScroll = computeMaxSidebarScroll(
        state,
        action.viewportHeight,
      );
      return {
        ...state,
        sidebarScrollOffset: Math.min(
          maxScroll,
          Math.max(0, state.sidebarScrollOffset + action.delta),
        ),
      };
    }
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
