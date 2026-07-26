import type { State } from './app-reducer.js';
import type { StatuslineItem } from './components/statusline-picker.js';

export function mergeStatuslineHiddenItems(
  hookHidden: StatuslineItem[],
  reducerHidden: StatuslineItem[],
): StatuslineItem[] {
  const hookHiddenSet = new Set<StatuslineItem>(hookHidden);
  const reducerOnlyHidden = reducerHidden.filter((item) => !hookHiddenSet.has(item));
  return [...hookHidden, ...reducerOnlyHidden];
}

export function isPickerOverlayOpen(state: State): boolean {
  return (
    state.modelPicker.open ||
    state.autonomyPicker.open ||
    state.modePicker.open ||
    state.designPicker.open ||
    state.resumePicker.open ||
    state.promptPicker.open ||
    state.settingsPicker.open ||
    state.projectPicker.open ||
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
    state.sessionsPanelOpen ||
    state.picker.open
  );
}
