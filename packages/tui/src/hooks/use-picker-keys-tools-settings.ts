import { brainPanelRows } from '../brain-panel-model.js';
import type { KeyEvent } from '../components/input.js';
import { filterResourceMenuItems } from '../components/resource-menu.js';
import { settingsPickerJumpField } from '../components/settings-picker.js';
import { STATUSLINE_ITEMS } from '../components/statusline-picker.js';
import type { PickerKeysHost } from './use-picker-keys-types.js';

export function tryToolsSettingsPickerKeys(
  host: PickerKeysHost,
  input: string,
  key: KeyEvent,
  isEnter: boolean,
  debouncedEnter: (host: PickerKeysHost) => boolean,
): boolean {
  const { state, dispatch } = host;

  // ── Shared operational resource menu ──────────────────────
  if (state.resourceMenu.open) {
    const pending = state.resourceMenu.pendingAction;
    if (pending) {
      if (input.toLowerCase() === 'y') {
        dispatch({ type: 'resourceMenuClose' });
        host.submit?.(pending.command);
      } else if (input.toLowerCase() === 'n' || key.escape) {
        dispatch({ type: 'resourceMenuConfirm', action: undefined });
      }
      return true;
    }
    if (state.resourceMenu.filtering) {
      if (key.escape) {
        dispatch({ type: 'resourceMenuFilter', filter: '', active: false });
      } else if (isEnter) {
        dispatch({
          type: 'resourceMenuFilter',
          filter: state.resourceMenu.filter,
          active: false,
        });
      } else if (key.backspace) {
        dispatch({
          type: 'resourceMenuFilter',
          filter: state.resourceMenu.filter.slice(0, -1),
          active: true,
        });
      } else if (input && !key.ctrl && !key.meta) {
        dispatch({
          type: 'resourceMenuFilter',
          filter: state.resourceMenu.filter + input,
          active: true,
        });
      }
      return true;
    }
    if (input === '/') {
      dispatch({ type: 'resourceMenuFilter', filter: '', active: true });
      return true;
    }
    if (key.escape) {
      dispatch({ type: 'resourceMenuClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel' || key.upArrow || key.downArrow) {
      const delta =
        key.mouse?.kind === 'wheel' ? (key.mouse.wheel > 0 ? -1 : 1) : key.upArrow ? -1 : 1;
      dispatch({ type: 'resourceMenuMove', delta });
      return true;
    }
    const item = state.resourceMenu.snapshot
      ? filterResourceMenuItems(state.resourceMenu.snapshot, state.resourceMenu.filter)[
          state.resourceMenu.selected
        ]
      : undefined;
    const action = isEnter
      ? item?.actions?.[0]
      : item?.actions?.find((candidate) => candidate.key.toLowerCase() === input.toLowerCase());
    if (action) {
      if (debouncedEnter(host)) return true;
      if (action.confirm) {
        dispatch({ type: 'resourceMenuConfirm', action });
      } else {
        dispatch({ type: 'resourceMenuClose' });
        host.submit?.(action.command);
      }
      return true;
    }
    return true;
  }

  // ── Design picker ─────────────────────────────────────────
  if (state.designPicker.open) {
    if (key.escape) {
      dispatch({ type: 'designPickerClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'designPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'designPickerMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'designPickerMove', delta: 1 });
      return true;
    }
    if (key.leftArrow || key.rightArrow) {
      const stacks = ['web', 'react-native', 'flutter', 'swiftui', 'compose'];
      const cur = stacks.indexOf(state.designPicker.stack);
      const delta = key.rightArrow ? 1 : -1;
      const next = stacks[(cur + delta + stacks.length) % stacks.length] ?? 'web';
      dispatch({ type: 'designPickerStack', stack: next });
      return true;
    }
    if (isEnter) {
      if (debouncedEnter(host)) return true;
      const kit = state.designPicker.kits[state.designPicker.selected];
      const stack = state.designPicker.stack;
      dispatch({ type: 'designPickerClose' });
      if (kit) host.submit?.(`/design ${kit.id} ${stack}`);
      return true;
    }
    return true;
  }

  // ── Prompt picker ──────────────────────────────────────────
  if (state.promptPicker.open) {
    if (key.escape) {
      dispatch({ type: 'promptPickerClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'promptPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'promptPickerMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'promptPickerMove', delta: 1 });
      return true;
    }
    if (key.leftArrow) {
      dispatch({ type: 'promptPickerCategory', delta: -1 });
      return true;
    }
    if (key.rightArrow) {
      dispatch({ type: 'promptPickerCategory', delta: 1 });
      return true;
    }
    if (input.toLowerCase() === 'f') {
      host.onPromptPickerFavorite?.();
      return true;
    }
    if (input.toLowerCase() === 'e') {
      host.onPromptPickerEdit?.();
      return true;
    }
    if (isEnter) {
      if (debouncedEnter(host)) return true;
      host.onPromptPickerEnter?.();
      return true;
    }
    return true;
  }

  // ── Resume picker ─────────────────────────────────────────
  if (state.resumePicker.open) {
    if (key.escape) {
      dispatch({ type: 'resumePickerClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'resumePickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'resumePickerMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'resumePickerMove', delta: 1 });
      return true;
    }
    if (isEnter) {
      if (debouncedEnter(host)) return true;
      host.inputGateRef.current = true;
      try {
        if (!state.resumePicker.busy) {
          void host.onResumePickerEnter?.();
        }
      } finally {
        host.inputGateRef.current = false;
      }
      return true;
    }
    return true;
  }

  // ── Settings picker ───────────────────────────────────────
  if (state.settingsPicker.open) {
    const sp = state.settingsPicker;
    if (sp.thinkingWordEditing) {
      if (key.escape) {
        dispatch({ type: 'settingsThinkingEditCancel' });
        return true;
      }
      if (isEnter) {
        if (debouncedEnter(host)) return true;
        dispatch({ type: 'settingsThinkingEditCommit' });
        return true;
      }
      if (key.backspace) {
        dispatch({
          type: 'settingsThinkingEditChange',
          draft: sp.thinkingWordDraft.slice(0, -1),
        });
        return true;
      }
      if (
        input &&
        input.length === 1 &&
        input.charCodeAt(0) >= 0x20 &&
        input.charCodeAt(0) < 0x7f
      ) {
        dispatch({ type: 'settingsThinkingEditChange', draft: sp.thinkingWordDraft + input });
        return true;
      }
      return true;
    }
    // WrongProxy URL (field 60) text-edit branch. Mirrors the
    // `thinkingWordEditing` block above: printable chars append to the
    // draft, Enter commits (validated by `new URL` in the reducer),
    // Escape cancels, Backspace deletes one char. The Start action
    // was already wired by `use-app-picker-keys.ts:337` on Enter at
    // the row; this branch handles the keystrokes while editing.
    if (sp.wrongProxyUrlEditing) {
      if (key.escape) {
        dispatch({ type: 'settingsWrongProxyUrlEditCancel' });
        return true;
      }
      if (isEnter) {
        if (debouncedEnter(host)) return true;
        dispatch({ type: 'settingsWrongProxyUrlEditCommit' });
        return true;
      }
      if (key.backspace) {
        dispatch({
          type: 'settingsWrongProxyUrlEditChange',
          draft: sp.wrongProxyUrlDraft.slice(0, -1),
        });
        return true;
      }
      if (
        input &&
        input.length === 1 &&
        input.charCodeAt(0) >= 0x20 &&
        input.charCodeAt(0) < 0x7f
      ) {
        dispatch({
          type: 'settingsWrongProxyUrlEditChange',
          draft: sp.wrongProxyUrlDraft + input,
        });
        return true;
      }
      return true;
    }
    if (key.escape || (key.ctrl && input === 's')) {
      dispatch({ type: 'settingsClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'settingsFieldMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (input && input.length === 1 && (key.ctrl || key.meta)) {
      const mod: 'ctrl' | 'alt' | 'alt-shift' = key.ctrl ? 'ctrl' : key.shift ? 'alt-shift' : 'alt';
      const field = settingsPickerJumpField(mod, input);
      if (field !== undefined) {
        dispatch({ type: 'settingsFieldSet', field });
        return true;
      }
    }
    if (input === '/' && sp.filter === '') {
      dispatch({ type: 'settingsFilterSet', filter: '/' });
      return true;
    }
    if (sp.filter !== '') {
      if (key.escape) {
        dispatch({ type: 'settingsFilterSet', filter: '' });
        return true;
      }
      if (key.backspace) {
        const next = sp.filter.length > 1 ? sp.filter.slice(0, -1) : '';
        dispatch({ type: 'settingsFilterSet', filter: next });
        return true;
      }
      if (
        input &&
        input.length === 1 &&
        input.charCodeAt(0) >= 0x20 &&
        input.charCodeAt(0) < 0x7f
      ) {
        dispatch({ type: 'settingsFilterSet', filter: sp.filter + input });
        return true;
      }
    }
    if (key.upArrow) {
      dispatch({ type: 'settingsFieldMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'settingsFieldMove', delta: 1 });
      return true;
    }
    if (key.leftArrow) {
      dispatch({ type: 'settingsValueChange', delta: -1 });
      return true;
    }
    if (key.rightArrow) {
      dispatch({ type: 'settingsValueChange', delta: 1 });
      return true;
    }
    // Mouse clicks must not change settings — only ←/→ arrows.
    if (key.mouse) return true;
    if (isEnter) {
      if (debouncedEnter(host)) return true;
      host.onSettingsPickerEnter?.();
      return true;
    }
    return true;
  }

  // ── Plugin picker ─────────────────────────────────────────
  if (state.pluginPicker.open) {
    if (key.escape) {
      dispatch({ type: 'pluginPickerClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'pluginPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'pluginPickerMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'pluginPickerMove', delta: 1 });
      return true;
    }
    if (key.leftArrow || key.rightArrow || isEnter) {
      if (debouncedEnter(host)) return true;
      void host.onPluginPickerToggle?.();
      return true;
    }
    return true;
  }

  // ── MCP server picker ──────────────────────────────────────
  if (state.mcpPicker.open) {
    if (key.escape) {
      dispatch({ type: 'mcpPickerClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'mcpPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'mcpPickerMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'mcpPickerMove', delta: 1 });
      return true;
    }
    if (input === 'r' || input === 'R') {
      void host.onMcpPickerRestart?.();
      return true;
    }
    if (key.leftArrow || key.rightArrow || isEnter) {
      if (debouncedEnter(host)) return true;
      void host.onMcpPickerToggle?.();
      return true;
    }
    return true;
  }

  // ── Tools picker (filter, toggle enable/disable) ──────────
  if (state.toolsPicker.open) {
    if (key.escape) {
      if (state.toolsPicker.filter) {
        dispatch({ type: 'toolsPickerFilter', filter: '' });
      } else {
        dispatch({ type: 'toolsPickerClose' });
      }
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'toolsPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'toolsPickerMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'toolsPickerMove', delta: 1 });
      return true;
    }
    if (key.leftArrow || key.rightArrow || isEnter) {
      if (debouncedEnter(host)) return true;
      void host.onToolsPickerToggle?.();
      return true;
    }
    if (input && input.length === 1 && input.charCodeAt(0) >= 0x20 && input.charCodeAt(0) < 0x7f) {
      dispatch({ type: 'toolsPickerFilter', filter: (state.toolsPicker.filter ?? '') + input });
      return true;
    }
    if (key.backspace) {
      const cur = state.toolsPicker.filter ?? '';
      dispatch({ type: 'toolsPickerFilter', filter: cur.length > 0 ? cur.slice(0, -1) : '' });
      return true;
    }
    return true;
  }

  // ── Help panel (slash command browser) ─────────────────────
  if (state.helpPanel.open) {
    if (key.escape) {
      dispatch({ type: 'helpClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'helpMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'helpMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'helpMove', delta: 1 });
      return true;
    }
    if (key.backspace && state.helpPanel.filter) {
      dispatch({ type: 'helpFilter', filter: state.helpPanel.filter.slice(0, -1) });
      return true;
    }
    if (input && input.length === 1 && input.charCodeAt(0) >= 0x20 && input.charCodeAt(0) < 0x7f) {
      dispatch({ type: 'helpFilter', filter: state.helpPanel.filter + input });
      return true;
    }
    if (isEnter) {
      if (debouncedEnter(host)) return true;
      host.onHelpPanelEnter?.();
      return true;
    }
    return true;
  }

  // ── Brain panel (settings editor + decision log) ──────────
  if (state.brainPanel.open) {
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

  // ── Statusline picker ─────────────────────────────────────
  if (state.statuslinePicker.open) {
    if (key.escape) {
      dispatch({ type: 'statuslineClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'statuslineFieldMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
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
    if (key.leftArrow || key.rightArrow || isEnter) {
      const focused = STATUSLINE_ITEMS[state.statuslinePicker.field];
      if (focused) {
        dispatch({ type: 'statuslineToggle', item: focused });
      }
      return true;
    }
    return true;
  }

  // ── Project picker ────────────────────────────────────────
  if (state.projectPicker.open) {
    if (key.escape) {
      if (state.projectPicker.filter) {
        dispatch({ type: 'projectPickerFilter', filter: '' });
      } else {
        dispatch({ type: 'projectPickerClose' });
      }
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'projectPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'projectPickerMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'projectPickerMove', delta: 1 });
      return true;
    }
    if (isEnter) {
      if (debouncedEnter(host)) return true;
      host.inputGateRef.current = true;
      try {
        void host.onProjectPickerEnter?.();
      } finally {
        host.inputGateRef.current = false;
      }
      return true;
    }
    if (input && input.length === 1 && input.charCodeAt(0) >= 0x20 && input.charCodeAt(0) < 0x7f) {
      dispatch({ type: 'projectPickerFilter', filter: state.projectPicker.filter + input });
      return true;
    }
    if (key.backspace) {
      if (state.projectPicker.filter.length > 0) {
        dispatch({
          type: 'projectPickerFilter',
          filter: state.projectPicker.filter.slice(0, -1),
        });
      }
      return true;
    }
    return true;
  }

  // ── Sessions panel ────────────────────────────────────────
  if (state.sessionsPanelOpen) {
    if (key.escape) {
      if (state.sessionResumeConfirm) {
        dispatch({ type: 'sessionResumeConfirmClear' });
      } else {
        dispatch({ type: 'toggleSessionsPanel' });
      }
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'sessionsPanelMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'sessionsPanelMove', delta: 1 });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'sessionsPanelMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (isEnter) {
      if (debouncedEnter(host)) return true;
      void host.onSessionsPanelEnter?.();
      return true;
    }
    return true;
  }

  // ── Slash picker ─────────────────────────────────────────
  if (state.slashPicker.open) {
    if (key.escape) {
      dispatch({ type: 'slashPickerClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'slashPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'slashPickerMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'slashPickerMove', delta: 1 });
      return true;
    }
    if (isEnter) {
      if (debouncedEnter(host)) return true;
      host.inputGateRef.current = true;
      try {
        host.onSlashPickerEnter?.();
      } finally {
        host.inputGateRef.current = false;
      }
      return true;
    }
    if (key.tab && state.slashPicker.matches.length > 0) {
      host.onSlashPickerTab?.();
      return true;
    }
    return false;
  }

  // ── F-key panel picker ─────────────────────────────────────
  if (state.fKeyPicker.open) {
    if (key.escape) {
      dispatch({ type: 'fKeyPickerClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'fKeyPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'fKeyPickerMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'fKeyPickerMove', delta: 1 });
      return true;
    }
    if (isEnter) {
      if (debouncedEnter(host)) return true;
      host.onFKeyPickerEnter?.();
      return true;
    }
    return true;
  }

  // ── General picker ─────────────────────────────────────────
  if (state.picker.open) {
    if (key.escape) {
      dispatch({ type: 'pickerClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'pickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'pickerMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'pickerMove', delta: 1 });
      return true;
    }
    if (isEnter) {
      if (debouncedEnter(host)) return true;
      host.inputGateRef.current = true;
      try {
        void host.onPickerEnter?.();
      } finally {
        host.inputGateRef.current = false;
      }
      return true;
    }
    return false;
  }

  return false;
}
