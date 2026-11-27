import { effectiveLine } from '@wrongstack/core/statusline';

import { brainPanelRows } from '../brain-panel-model.js';

import type { KeyEvent } from '../components/input.js';

import { STATUSLINE_ITEMS } from '../components/statusline-picker.js';

import type { PickerKeysHost } from './use-picker-keys-types.js';
export function tryBrainStatuslinePickerKeys(
  host: PickerKeysHost,
  input: string,
  key: KeyEvent,
  isEnter: boolean,
  debouncedEnter: (host: PickerKeysHost) => boolean,
): boolean {
  const { state, dispatch } = host;

  // ── Brain panel (settings editor + decision log) ──────────
  if (state.brainPanel.open) {
    if (key.ctrl || key.meta) return true;
    const panel = state.brainPanel;

    if (panel.view === 'settings' && panel.settings) {
      const rows = brainPanelRows(panel.settings);
      const row = rows[Math.min(panel.row, Math.max(0, rows.length - 1))];
      if (key.escape) {
        dispatch({ type: 'brainClose' });
        return true;
      }
      if (key.tab) {
        dispatch({ type: 'brainView', view: 'log' });
        return true;
      }
      if (key.mouse?.kind === 'wheel') {
        dispatch({ type: 'brainRowMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
        return true;
      }
      if (key.upArrow) {
        dispatch({ type: 'brainRowMove', delta: -1 });
        return true;
      }
      if (key.downArrow) {
        dispatch({ type: 'brainRowMove', delta: 1 });
        return true;
      }
      if (!row || panel.busy) return true;
      if (key.leftArrow) {
        host.onBrainAdjust?.(row, -1);
        return true;
      }
      if (key.rightArrow) {
        host.onBrainAdjust?.(row, 1);
        return true;
      }
      if (isEnter) {
        if (debouncedEnter(host)) return true;
        host.onBrainEnter?.(row);
        return true;
      }
      if (
        (input === 'd' || input === 'D' || key.delete) &&
        (row.kind === 'poolModel' || row.kind === 'voter' || row.kind === 'judge')
      ) {
        host.onBrainDelete?.(row);
        return true;
      }
      if ((input === 'p' || input === 'P') && row.kind === 'voter') {
        host.onBrainVoterMod?.(row.index, 'persona');
        return true;
      }
      if ((input === 'v' || input === 'V') && row.kind === 'voter') {
        host.onBrainVoterMod?.(row.index, 'veto');
        return true;
      }
      return true;
    }

    if (key.escape) {
      dispatch({ type: 'brainClose' });
      return true;
    }
    if (key.tab && panel.settings) {
      dispatch({ type: 'brainView', view: 'settings' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'brainMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'brainMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'brainMove', delta: 1 });
      return true;
    }
    if (key.leftArrow) {
      host.onBrainRiskChange?.(-1);
      return true;
    }
    if (key.rightArrow) {
      host.onBrainRiskChange?.(1);
      return true;
    }
    return true;
  }

  // ── Shadow Agent panel ────────────────────────────────────
  if (state.shadowPanel.open) {
    if (key.ctrl || key.meta) return true;
    if (key.escape) {
      dispatch({ type: 'shadowClose' });
      return true;
    }
    if (input === 's' || input === 'S') {
      void host.onShadowStart?.();
      return true;
    }
    if (input === 't' || input === 'T') {
      void host.onShadowStop?.();
      return true;
    }
    return true;
  }

  // ── Memory browser panel ──────────────────────────────────
  // `?.` tolerates partial State fixtures that predate this slice (same
  // convention as subagentModels); the block only runs when it is present.
  if (state.memoryPanel?.open) {
    if (key.ctrl || key.meta) return true;
    if (key.escape) {
      dispatch({ type: 'memoryPanelClose' });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'memoryPanelMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'memoryPanelMove', delta: 1 });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'memoryPanelMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.backspace || key.delete) {
      dispatch({ type: 'memoryPanelSetFilter', filter: state.memoryPanel.filter.slice(0, -1) });
      return true;
    }
    // Single printable characters build the filter; multi-char paste is ignored
    // so a clipboard dump can't flood the query.
    if (input && input.length === 1 && input >= ' ') {
      dispatch({ type: 'memoryPanelSetFilter', filter: state.memoryPanel.filter + input });
      return true;
    }
    return true;
  }

  // ── Subagent model lanes panel ────────────────────────────
  if (state.subagentModels?.open) {
    if (key.ctrl || key.meta) return true;
    if (key.escape) {
      dispatch({ type: 'subagentModelsClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'subagentModelsMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'subagentModelsMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'subagentModelsMove', delta: 1 });
      return true;
    }
    if (key.mouse) return true;
    if (isEnter) {
      host.onSubagentLaneEdit?.(state.subagentModels.selected);
      return true;
    }
    if (input === 'c' || input === 'C' || key.delete || key.backspace) {
      host.onSubagentLaneClear?.(state.subagentModels.selected);
      return true;
    }
    if (input === 'l' || input === 'L') {
      host.onSubagentPlanToggle?.('lock');
      return true;
    }
    if (input === 's' || input === 'S') {
      host.onSubagentPlanToggle?.('followSessionModel');
      return true;
    }
    if (input === ' ') {
      host.onSubagentPlanToggle?.('enabled');
      return true;
    }
    return true;
  }

  // ── Statusline picker ─────────────────────────────────────
  if (state.statuslinePicker.open) {
    if (key.ctrl || key.meta) return true;
    const focused = STATUSLINE_ITEMS[state.statuslinePicker.field];
    const filtering = state.statuslinePicker.filtering;

    if (key.escape) {
      // Esc backs out of filter capture first, then closes the panel — the
      // same two-stage escape the project/settings pickers use.
      if (filtering || state.statuslinePicker.filter) {
        dispatch({ type: 'statuslineFilter', text: '', filtering: false });
      } else {
        dispatch({ type: 'statuslineClose' });
      }
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'statuslineFieldMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (focused && key.shift && (key.upArrow || key.downArrow)) {
      dispatch({ type: 'statuslineMoveOrder', item: focused, delta: key.upArrow ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'statuslineFieldMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'statuslineFieldMove', delta: 1 });
      return true;
    }
    if (key.mouse) return true;

    // Filter capture owns printable keys while active, so a chip name can be
    // typed without every letter firing a layout command.
    if (filtering) {
      if (isEnter) {
        dispatch({ type: 'statuslineFilter', filtering: false });
        return true;
      }
      if (key.backspace || key.delete) {
        dispatch({
          type: 'statuslineFilter',
          text: state.statuslinePicker.filter.slice(0, -1),
        });
        return true;
      }
      if (input && input.length === 1 && input >= ' ' && input <= '~') {
        dispatch({ type: 'statuslineFilter', text: state.statuslinePicker.filter + input });
        return true;
      }
      return true;
    }

    if (input === '/') {
      dispatch({ type: 'statuslineFilter', filtering: true });
      return true;
    }
    if (key.leftArrow || key.rightArrow || isEnter) {
      if (focused) dispatch({ type: 'statuslineToggle', item: focused });
      return true;
    }
    if (focused && input && input >= '1' && input <= '4') {
      dispatch({ type: 'statuslineSetLine', item: focused, line: Number(input) as 1 | 2 | 3 | 4 });
      return true;
    }
    if (focused && (input === '[' || input === ']')) {
      dispatch({ type: 'statuslineMoveOrder', item: focused, delta: input === '[' ? -1 : 1 });
      return true;
    }
    if (focused && (input === 'o' || input === 'O')) {
      dispatch({ type: 'statuslineMoveOrder', item: focused, delta: input === 'O' ? -1 : 1 });
      return true;
    }
    if (focused && (input === 'd' || input === 'D')) {
      dispatch({ type: 'statuslineSetDensity', item: focused });
      return true;
    }
    if (focused && (input === 'a' || input === 'A')) {
      dispatch({
        type: 'statuslineToggleLine',
        line: effectiveLine(focused, state.statuslinePicker.lines),
      });
      return true;
    }
    if (input === 'r' || input === 'R') {
      dispatch({ type: 'statuslineResetLayout' });
      return true;
    }
    return true;
  }
  return false;
}
