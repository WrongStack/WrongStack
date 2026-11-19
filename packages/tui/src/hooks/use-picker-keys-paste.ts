import { authPanelRows } from '../auth-panel-model.js';
import { pickerPasteText } from '../picker-text-input.js';
import type { PickerKeysHost } from './use-picker-keys-types.js';

/**
 * Where a bracketed paste goes while a picker owns the keyboard.
 *
 * Pastes never enter the per-picker key blocks: those compare single
 * characters for shortcuts and y/N confirmations, so a pasted "y" or "d"
 * would delete a key or remove a server. This table is the only paste route
 * for pickers. Each open picker either appends the cleaned text to the field
 * that is accepting text right now, or drops the paste.
 *
 * Returns `false` only for composer helpers (slash / @file / $skill mention
 * pickers) and when nothing is open, so the paste lands in the chat draft.
 * The order mirrors `usePickerKeys`.
 */
export function routePickerPaste(host: PickerKeysHost, input: string): boolean {
  const { state, dispatch } = host;
  const text = pickerPasteText(input);

  if (state.authPanel.open) {
    const ap = state.authPanel;
    if (!text) return true;
    if (ap.input) {
      dispatch({ type: 'authPromptChange', draft: ap.input.draft + text });
      return true;
    }
    if (ap.confirm || ap.view === 'flow') return true;
    if (ap.view === 'catalog') {
      dispatch({ type: 'authFilter', filter: ap.filter + text });
      return true;
    }
    if (ap.view === 'form' && ap.form) {
      const row = authPanelRows(ap)[ap.selected];
      if (row?.kind === 'form-field' && row.field !== 'family') {
        dispatch({ type: 'authFormChange', field: row.field, value: row.value + text });
      }
    }
    return true;
  }

  if (state.modelPicker.open) {
    if (text && state.modelPicker.step === 'model') {
      dispatch({ type: 'modelPickerSearch', query: state.modelPicker.searchQuery + text });
    }
    return true;
  }
  if (state.modePicker.open || state.autonomyPicker.open) return true;
  if (state.themePicker.open) {
    if (text && state.themePicker.filtering) {
      dispatch({ type: 'themePickerFilter', text: (state.themePicker.filter ?? '') + text });
    }
    return true;
  }
  if (state.skillPicker.open) return !state.skillPicker.mention;

  if (state.resourceMenu.open) {
    if (text && state.resourceMenu.filtering && !state.resourceMenu.pendingAction) {
      dispatch({
        type: 'resourceMenuFilter',
        filter: state.resourceMenu.filter + text,
        active: true,
      });
    }
    return true;
  }
  if (state.designPicker.open || state.promptPicker.open || state.resumePicker.open) return true;
  if (state.settingsPicker.open) {
    const sp = state.settingsPicker;
    if (!text) return true;
    if (sp.thinkingWordEditing) {
      dispatch({ type: 'settingsThinkingEditChange', draft: sp.thinkingWordDraft + text });
    } else if (sp.wrongProxyUrlEditing) {
      dispatch({ type: 'settingsWrongProxyUrlEditChange', draft: sp.wrongProxyUrlDraft + text });
    } else {
      // The settings filter is spelled with a leading "/" (typed to open it).
      dispatch({ type: 'settingsFilterSet', filter: `${sp.filter || '/'}${text}` });
    }
    return true;
  }
  if (state.pluginPicker.open) return true;
  if (state.mcpPicker.open) {
    const editor = state.mcpPicker.editor;
    if (text && !state.mcpPicker.busy && editor && editor.mode !== 'remove') {
      const field = (['name', 'transport', 'target', 'args'] as const)[editor.field];
      if (field) {
        dispatch({ type: 'mcpPickerEditor', editor: { ...editor, [field]: editor[field] + text } });
      }
    }
    return true;
  }
  if (state.toolsPicker.open) {
    if (text) {
      dispatch({ type: 'toolsPickerFilter', filter: (state.toolsPicker.filter ?? '') + text });
    }
    return true;
  }
  if (state.helpPanel.open) {
    if (text) dispatch({ type: 'helpFilter', filter: state.helpPanel.filter + text });
    return true;
  }

  if (state.brainPanel.open || state.shadowPanel.open || state.subagentModels?.open) return true;
  if (state.statuslinePicker.open) {
    if (text && state.statuslinePicker.filtering) {
      dispatch({ type: 'statuslineFilter', text: state.statuslinePicker.filter + text });
    }
    return true;
  }
  if (state.projectPicker.open) {
    if (text) {
      dispatch({ type: 'projectPickerFilter', filter: state.projectPicker.filter + text });
    }
    return true;
  }
  if (state.sessionsPanelOpen || state.fKeyPicker.open) return true;
  // slashPicker and the @file picker complete the composer draft itself.
  return false;
}
