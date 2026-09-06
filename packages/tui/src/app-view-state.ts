import type { State } from './app-state.js';
import { composerStatusFromState } from './components/composer-status-chip.js';
import { DEFAULT_INPUT_PROMPT, inputContentWidth } from './components/input.js';
import { layoutInputRows } from './input-tokens.js';
import type { PanelId, PanelPositionMap } from './ui-contracts.js';

interface AppViewStateOptions {
  state: State;
  terminalColumns: number;
  displayThinkingWord: string;
  fleetRunning: number;
  liveAnimationStyle: State['settingsPicker']['animationStyle'];
  /**
   * Per-panel routing from `effectivePanelPositions`. A panel routed to
   * the sidebar renders in the right rail, NOT the bottom region — so it
   * must neither hide the composer nor count as a lower-region panel.
   * Reading the raw open flags here without routing collapsed the composer
   * to a placeholder whenever a sidebar-routed panel was toggled.
   */
  panelPositions: PanelPositionMap;
}

/** Pure composer sizing/visibility and lower-panel projection. */
export function deriveAppViewState(options: AppViewStateOptions) {
  const { state, terminalColumns, displayThinkingWord, fleetRunning, liveAnimationStyle } = options;
  const onBottom = (id: PanelId): boolean => options.panelPositions[id] !== 'sidebar';
  const inputHint =
    state.status === 'idle' && state.buffer.startsWith('/')
      ? 'slash command — Enter to dispatch'
      : '';
  const composerStatus = composerStatusFromState({
    status: state.status,
    confirmCount: state.confirmQueue.length,
    queueCount: state.queue.length,
    thinkingWord: displayThinkingWord,
    fleetRunning,
  });
  const composerAnimationStyle = state.settingsPicker.open
    ? state.settingsPicker.animationStyle
    : liveAnimationStyle;
  const enhanceActive = state.enhanceBusy || state.enhance != null || state.topicCheckBusy;
  const inputHeight = Math.max(
    3,
    layoutInputRows(
      DEFAULT_INPUT_PROMPT,
      state.buffer,
      state.cursor,
      inputContentWidth(terminalColumns),
    ).length + 2,
  );
  const hideInput =
    enhanceActive ||
    state.refineFailure != null ||
    state.continueConfirm != null ||
    state.bugHuntContinue != null ||
    state.clearConfirm != null ||
    state.slashConfirm != null ||
    state.confirmQueue.length > 0 ||
    state.shellCommandWarning != null ||
    state.brainPrompt != null ||
    state.escConfirm != null ||
    state.sendModePicker != null ||
    state.helpOpen ||
    (state.projectPicker.open && onBottom('projectPicker')) ||
    (state.monitorOpen && onBottom('fleet')) ||
    (state.agentsMonitorOpen && onBottom('agents')) ||
    (state.worktreeMonitorOpen && onBottom('worktree')) ||
    (state.planPanelOpen && onBottom('plan')) ||
    (state.todosMonitorOpen && onBottom('todos')) ||
    (state.queuePanelOpen && onBottom('queue')) ||
    (state.processListOpen && onBottom('processList')) ||
    (state.goalPanelOpen && onBottom('goal')) ||
    state.contextPanelOpen ||
    (state.sessionsPanelOpen && onBottom('sessions')) ||
    state.authPanel.open;
  const lowerFunctionPanelOpen =
    (state.monitorOpen && onBottom('fleet')) ||
    (state.agentsMonitorOpen && onBottom('agents')) ||
    ((state.goalRun?.monitorOpen ?? false) && onBottom('coordinator')) ||
    (state.worktreeMonitorOpen && onBottom('worktree')) ||
    (state.planPanelOpen && onBottom('plan')) ||
    (state.kanbanPanelOpen && onBottom('kanban')) ||
    (state.todosMonitorOpen && onBottom('todos')) ||
    (state.queuePanelOpen && onBottom('queue')) ||
    (state.processListOpen && onBottom('processList')) ||
    (state.goalPanelOpen && onBottom('goal')) ||
    (state.sessionsPanelOpen && onBottom('sessions'));

  return {
    inputHint,
    composerStatus,
    composerAnimationStyle,
    inputHeight,
    hideInput,
    lowerFunctionPanelOpen,
  };
}
