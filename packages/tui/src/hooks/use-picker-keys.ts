/**
 * Picker key dispatch.
 *
 * The picker dispatch is a closed dispatch table where each picker checks
 * `state.<picker>.open` and either handles the key (returning `true`) or
 * falls through (returning `false`). The hook returns a single function
 * `tryPickerKey(input, key, isEnter)` that the caller's `handleKey` invokes
 * *before* its non-picker dispatch and bails on `true`.
 */

import { useCallback } from 'react';
import type { Action, State } from '../app-reducer.js';
import type { KeyEvent } from '../components/input.js';
import { settingsPickerJumpField } from '../components/settings-picker.js';
import { STATUSLINE_ITEMS } from '../components/statusline-picker.js';
import type { AutonomyStage } from './use-statusline-state.js';

export interface PickerKeysHost {
  state: State;
  dispatch: React.Dispatch<Action>;
  lastEnterAtRef: { current: number };
  inputGateRef: { current: boolean };

  switchProviderAndModel:
    | ((providerId: string, modelId: string) => string | null | Promise<string | null>)
    | undefined;
  // These mirror the plain setter signatures the app provides (from
  // useStatuslineState); the hook only ever calls them with a concrete value,
  // never a SetStateAction updater, so the narrow `(v) => void` form is both
  // accurate and assignable from the real setters.
  setLiveProvider: ((v: string) => void) | undefined;
  setLiveModel: ((v: string) => void) | undefined;
  setActiveMaxContext: ((v: number | undefined) => void) | undefined;
  agentCtxMaxContext: number;

  // `opt.mode` is an AutonomyStage, so accept that union (not bare string) to
  // match the app's `switchAutonomy`.
  switchAutonomy: ((mode: AutonomyStage) => string | null) | undefined;
  submit: ((text: string) => void) | undefined;

  onAuthEnter: (() => void) | undefined;
  onAuthBack: (() => void) | undefined;
  onAuthShortcut: ((input: string) => void) | undefined;
  onAuthPromptSubmit: (() => void) | undefined;
  onAuthPromptCancel: (() => void) | undefined;
  onAuthConfirm: ((yes: boolean) => void) | undefined;
  onAuthFlowCancel: (() => void) | undefined;
  onAuthCtrlC: (() => void) | undefined;

  onPromptPickerEnter: (() => void) | undefined;
  onResumePickerEnter: (() => Promise<void>) | undefined;
  onSessionsPanelEnter: (() => Promise<void>) | undefined;
  onProjectPickerEnter: (() => Promise<void>) | undefined;
  onSlashPickerEnter: (() => void) | undefined;
  onSettingsPickerEnter: (() => void) | undefined;
  onPluginPickerToggle: (() => Promise<void> | void) | undefined;
  onMcpPickerToggle: (() => Promise<void> | void) | undefined;
  onMcpPickerRestart: (() => Promise<void> | void) | undefined;
  onToolsPickerToggle: (() => Promise<void> | void) | undefined;
  onBrainRiskChange: ((delta: number) => void) | undefined;
  onFKeyPickerEnter: (() => void) | undefined;
  onPickerEnter: (() => Promise<void>) | undefined;

  onSlashPickerTab: (() => void) | undefined;
}

const ENTER_DOUBLE_TAP_MS = 50;

function debouncedEnter(host: PickerKeysHost): boolean {
  const now = Date.now();
  if (now - host.lastEnterAtRef.current < ENTER_DOUBLE_TAP_MS) return true;
  host.lastEnterAtRef.current = now;
  return false;
}

export function usePickerKeys(
  host: PickerKeysHost,
): (input: string, key: KeyEvent, isEnter: boolean) => boolean {
  return useCallback(
    (input: string, key: KeyEvent, isEnter: boolean): boolean => {
      const { state, dispatch } = host;

      // ── Auth panel (/auth — providers, keys, OAuth) ────────────
      if (state.authPanel.open) {
        const ap = state.authPanel;

        // Ctrl+C cancels everything — flow, prompt, panel. In raw-mode
        // terminals (ConPTY/Windows) Ctrl+C arrives here as key data rather
        // than a SIGINT, so the panel must handle it itself or the exit
        // ladder appears dead while the panel is open.
        if (key.ctrl && (input === 'c' || input === 'C')) {
          host.onAuthCtrlC?.();
          return true;
        }

        // Modal prompt raised by a running flow (label / key / paste-URL).
        if (ap.input) {
          if (key.escape) {
            host.onAuthPromptCancel?.();
            return true;
          }
          if (isEnter) {
            if (debouncedEnter(host)) return true;
            host.onAuthPromptSubmit?.();
            return true;
          }
          if (key.backspace) {
            dispatch({ type: 'authPromptChange', draft: ap.input.draft.slice(0, -1) });
            return true;
          }
          // Accept full printable strings — bracketed paste delivers the
          // whole clipboard (an API key or redirect URL) in one event.
          if (input && !key.ctrl && !key.meta) {
            // Drop control characters (CR/LF from pastes, stray escapes).
            const printable = Array.from(input)
              .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
              .join('');
            if (printable.length > 0) {
              dispatch({ type: 'authPromptChange', draft: ap.input.draft + printable });
            }
            return true;
          }
          return true;
        }

        // Modal y/N confirmation (delete key / remove provider).
        if (ap.confirm) {
          if (key.escape || input === 'n' || input === 'N') {
            host.onAuthConfirm?.(false);
            return true;
          }
          if (input === 'y' || input === 'Y' || isEnter) {
            if (isEnter && debouncedEnter(host)) return true;
            host.onAuthConfirm?.(true);
            return true;
          }
          return true;
        }

        // Flow view — streaming log; Esc cancels (or closes when done).
        if (ap.view === 'flow') {
          if (key.escape) {
            host.onAuthFlowCancel?.();
            return true;
          }
          if (isEnter) {
            if (debouncedEnter(host)) return true;
            host.onAuthEnter?.();
            return true;
          }
          return true;
        }

        if (key.escape) {
          host.onAuthBack?.();
          return true;
        }
        if (key.mouse?.kind === 'wheel') {
          dispatch({ type: 'authMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
          return true;
        }
        if (key.upArrow) {
          dispatch({ type: 'authMove', delta: -1 });
          return true;
        }
        if (key.downArrow) {
          dispatch({ type: 'authMove', delta: 1 });
          return true;
        }
        if (isEnter) {
          if (debouncedEnter(host)) return true;
          host.onAuthEnter?.();
          return true;
        }
        if (ap.view === 'catalog') {
          if (key.backspace) {
            if (ap.filter.length > 0) {
              dispatch({ type: 'authFilter', filter: ap.filter.slice(0, -1) });
            }
            return true;
          }
          if (input && input.length === 1 && input.charCodeAt(0) >= 0x20 && input.charCodeAt(0) < 0x7f) {
            dispatch({ type: 'authFilter', filter: ap.filter + input });
            return true;
          }
        }
        if (ap.view === 'provider' && (input === 'u' || input === 'd')) {
          host.onAuthShortcut?.(input);
          return true;
        }
        return true;
      }

      // ── Model picker (two-step: provider → model) ──────────────
      if (state.modelPicker.open) {
        if (key.escape) {
          if (state.modelPicker.step === 'model') {
            dispatch({ type: 'modelPickerBack' });
          } else {
            dispatch({ type: 'modelPickerClose' });
          }
          return true;
        }
        if (key.mouse?.kind === 'wheel') {
          dispatch({ type: 'modelPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
          return true;
        }
        if (key.upArrow) {
          dispatch({ type: 'modelPickerMove', delta: -1 });
          return true;
        }
        if (key.downArrow) {
          dispatch({ type: 'modelPickerMove', delta: 1 });
          return true;
        }
        if (state.modelPicker.step === 'model' && input && !key.return && !key.backspace) {
          dispatch({ type: 'modelPickerSearch', query: state.modelPicker.searchQuery + input });
          return true;
        }
        if (state.modelPicker.step === 'model' && key.backspace) {
          const q = state.modelPicker.searchQuery;
          if (q.length > 0) {
            dispatch({ type: 'modelPickerSearch', query: q.slice(0, -1) });
          } else {
            dispatch({ type: 'modelPickerBack' });
          }
          return true;
        }
        if (isEnter) {
          if (debouncedEnter(host)) return true;
          host.inputGateRef.current = true;
          try {
            if (state.modelPicker.step === 'provider') {
              const opt = state.modelPicker.providerOptions[state.modelPicker.selected];
              if (!opt) return true;
              dispatch({
                type: 'modelPickerPickProvider',
                providerId: opt.id,
                models: opt.models,
              });
              return true;
            }
            const providerId = state.modelPicker.pickedProviderId;
            const modelId = state.modelPicker.filteredOptions[state.modelPicker.selected];
            if (!providerId || !modelId) return true;
            const complete = (err: string | null | undefined) => {
              if (err) {
                dispatch({ type: 'modelPickerHint', text: err });
                return;
              }
              host.setLiveProvider?.(providerId);
              host.setLiveModel?.(modelId);
              host.setActiveMaxContext?.(host.agentCtxMaxContext);
              dispatch({
                type: 'addEntry',
                entry: { kind: 'info', text: `Switched to ${providerId} / ${modelId}.` },
              });
              dispatch({ type: 'modelPickerClose' });
            };
            const result = host.switchProviderAndModel?.(providerId, modelId);
            if (result && typeof (result as Promise<string | null>).then === 'function') {
              void (result as Promise<string | null>).then(complete).catch((err: unknown) => {
                complete(err instanceof Error ? err.message : String(err));
              });
              return true;
            }
            complete(result as string | null | undefined);
            return true;
          } finally {
            host.inputGateRef.current = false;
          }
        }
        return true;
      }

      // ── Mode picker (agent modes: teach/brief/code-reviewer/etc.) ───────
      if (state.modePicker.open) {
        if (key.escape) {
          dispatch({ type: 'modePickerClose' });
          return true;
        }
        if (key.mouse?.kind === 'wheel') {
          dispatch({ type: 'modePickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
          return true;
        }
        if (key.upArrow) {
          dispatch({ type: 'modePickerMove', delta: -1 });
          return true;
        }
        if (key.downArrow) {
          dispatch({ type: 'modePickerMove', delta: 1 });
          return true;
        }
        if (isEnter) {
          if (debouncedEnter(host)) return true;
          const opt = state.modePicker.modes[state.modePicker.selected];
          if (!opt) return true;
          dispatch({ type: 'modePickerClose' });
          host.submit?.(`/mode ${opt.id}`);
          return true;
        }
        return true;
      }

      // ── Autonomy picker ───────────────────────────────────────
      if (state.autonomyPicker.open) {
        if (key.escape) {
          dispatch({ type: 'autonomyPickerClose' });
          return true;
        }
        if (key.mouse?.kind === 'wheel') {
          dispatch({ type: 'autonomyPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
          return true;
        }
        if (key.upArrow) {
          dispatch({ type: 'autonomyPickerMove', delta: -1 });
          return true;
        }
        if (key.downArrow) {
          dispatch({ type: 'autonomyPickerMove', delta: 1 });
          return true;
        }
        if (isEnter) {
          if (debouncedEnter(host)) return true;
          const opt = state.autonomyPicker.options[state.autonomyPicker.selected];
          if (!opt) return true;
          const err = host.switchAutonomy?.(opt.mode);
          if (err) {
            dispatch({ type: 'autonomyPickerHint', text: err });
            return true;
          }
          dispatch({ type: 'autonomyPickerClose' });
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
        if (key.escape || (key.ctrl && input === 's')) {
          dispatch({ type: 'settingsClose' });
          return true;
        }
        if (key.mouse?.kind === 'wheel') {
          dispatch({ type: 'settingsFieldMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
          return true;
        }
        if (input && input.length === 1 && (key.ctrl || key.meta)) {
          const mod: 'ctrl' | 'alt' | 'alt-shift' = key.ctrl
            ? 'ctrl'
            : key.shift
              ? 'alt-shift'
              : 'alt';
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
        // Printable chars → filter mode (like SettingsPicker slash search)
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

      // ── Brain panel (risk ceiling + decision log) ─────────────
      if (state.brainPanel.open) {
        if (key.escape) {
          dispatch({ type: 'brainClose' });
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
        if (key.leftArrow || key.rightArrow) {
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
        if (
          input &&
          input.length === 1 &&
          input.charCodeAt(0) >= 0x20 &&
          input.charCodeAt(0) < 0x7f
        ) {
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
    },
    [host],
  );
}
