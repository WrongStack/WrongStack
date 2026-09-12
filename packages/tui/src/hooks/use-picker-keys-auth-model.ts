import { authPanelRows, WIRE_FAMILIES } from '../auth-panel-model.js';
import type { KeyEvent } from '../components/input.js';
import { EFFORT_KEEP, effortOptionsForFocused } from '../components/model-picker-effort.js';
import type { ReasoningEffort } from '../settings-contracts.js';
import type { PickerKeysHost } from './use-picker-keys-types.js';

export function tryAuthModelPickerKeys(
  host: PickerKeysHost,
  input: string,
  key: KeyEvent,
  isEnter: boolean,
  debouncedEnter: (host: PickerKeysHost) => boolean,
): boolean {
  const { state, dispatch } = host;

  // ── Auth panel (/auth — providers, keys, OAuth) ────────────
  if (state.authPanel.open) {
    const ap = state.authPanel;

    // Ctrl+C cancels everything — flow, prompt, panel.
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
      if (
        input &&
        input.length === 1 &&
        input.charCodeAt(0) >= 0x20 &&
        input.charCodeAt(0) < 0x7f
      ) {
        dispatch({ type: 'authFilter', filter: ap.filter + input });
        return true;
      }
    }
    if (
      (ap.view === 'provider' || ap.view === 'models') &&
      (input === 'u' || input === 'd' || input === 'x' || input === 'r' || input === 'a')
    ) {
      host.onAuthShortcut?.(input);
      return true;
    }
    if (ap.view === 'form' && ap.form) {
      // Look up the currently focused row so we can route input correctly:
      // text fields accept printable chars + backspace; the family row
      // cycles through WireFamily values on left/right; Cancel/Save are
      // dispatched by Enter (handled above by onAuthEnter).
      const rows = authPanelRows(ap);
      const row = rows[ap.selected];
      if (row?.kind === 'form-field') {
        if (row.field === 'family') {
          if (key.leftArrow || key.rightArrow) {
            const current = row.value as (typeof WIRE_FAMILIES)[number] | '';
            const idx = current === '' ? -1 : (WIRE_FAMILIES as readonly string[]).indexOf(current);
            const nextIdx =
              idx === -1
                ? 0
                : (idx + (key.rightArrow ? 1 : -1) + WIRE_FAMILIES.length) % WIRE_FAMILIES.length;
            dispatch({
              type: 'authFormChange',
              field: 'family',
              value: WIRE_FAMILIES[nextIdx] ?? 'openai-compatible',
            });
            return true;
          }
          // Ignore printable input on the family row — arrows own this field.
          return true;
        }
        // Plain text field — backspace deletes the last character,
        // printable input appends.
        if (key.backspace) {
          dispatch({
            type: 'authFormChange',
            field: row.field,
            value: row.value.slice(0, -1),
          });
          return true;
        }
        if (input && !key.ctrl && !key.meta) {
          const printable = Array.from(input)
            .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
            .join('');
          if (printable.length > 0) {
            dispatch({
              type: 'authFormChange',
              field: row.field,
              value: row.value + printable,
            });
          }
          return true;
        }
      }
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
    // Arrows BEFORE the type-to-filter branch: a left/right key event can
    // arrive with a non-empty `input` on some terminals, and the filter would
    // then swallow it as a search character.
    if (state.modelPicker.step === 'model' && (key.leftArrow || key.rightArrow)) {
      dispatch({ type: 'modelPickerEffort', delta: key.rightArrow ? 1 : -1 });
      return true;
    }
    if (state.modelPicker.step === 'model' && input && !isEnter && !key.backspace) {
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
        // Re-derived rather than trusted: the reducer resets the choice on
        // every navigation, but a model whose strip is empty must never carry
        // one (a stale 'max' from a sibling row would be saved silently).
        const effortChoice =
          effortOptionsForFocused(state.modelPicker).length > 0
            ? state.modelPicker.effort
            : EFFORT_KEEP;
        if (!providerId || !modelId) return true;
        if (state.modelPicker.purpose === 'pick') {
          host.onModelPicked?.(providerId, modelId);
          dispatch({ type: 'modelPickerClose' });
          return true;
        }
        const complete = (err: string | null | undefined) => {
          if (err) {
            dispatch({ type: 'modelPickerHint', text: err });
            return;
          }
          const previousProvider = host.currentProvider;
          const previousModel = host.currentModel;
          const previousMaxContext = host.activeMaxContext;
          const nextMaxContext = host.getAgentCtxMaxContext();
          host.setLiveProvider?.(providerId);
          host.setLiveModel?.(modelId);
          host.setActiveMaxContext?.(nextMaxContext);
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'model-switch',
              fromProvider: previousProvider,
              fromModel: previousModel,
              toProvider: providerId,
              toModel: modelId,
              fromContext: previousMaxContext,
              toContext: nextMaxContext > 0 ? nextMaxContext : undefined,
              requestTokens: host.currentContextTokens > 0 ? host.currentContextTokens : undefined,
              runActive: state.status !== 'idle',
            },
          });
          // Effort rides the SAME Enter as the model: the strip is a property
          // of the row being committed, so a chosen level is persisted only
          // once the switch itself reported success.
          if (effortChoice !== EFFORT_KEEP) {
            void Promise.resolve(host.saveReasoningEffort?.(effortChoice as ReasoningEffort))
              .then((saveErr) => {
                dispatch({
                  type: 'addEntry',
                  entry: saveErr
                    ? {
                        kind: 'warn',
                        text: `Model switched, but reasoning effort was not saved: ${saveErr}`,
                      }
                    : { kind: 'info', text: `Reasoning effort → ${effortChoice}` },
                });
              })
              .catch((saveErr: unknown) => {
                dispatch({
                  type: 'addEntry',
                  entry: {
                    kind: 'warn',
                    text: `Model switched, but reasoning effort was not saved: ${
                      saveErr instanceof Error ? saveErr.message : String(saveErr)
                    }`,
                  },
                });
              });
          }
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

  // ── Theme picker ──────────────────────────────────────────
  if (state.themePicker.open) {
    if (key.escape) {
      dispatch({ type: 'themePickerClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'themePickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'themePickerMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'themePickerMove', delta: 1 });
      return true;
    }
    if (isEnter) {
      if (debouncedEnter(host)) return true;
      host.inputGateRef.current = true;
      try {
        host.onThemePickerEnter?.();
      } finally {
        host.inputGateRef.current = false;
      }
      return true;
    }
    return true;
  }

  // ── Skill picker ──────────────────────────────────────────
  if (state.skillPicker.open) {
    if (key.escape) {
      dispatch({ type: 'skillPickerClose' });
      return true;
    }
    if (key.mouse?.kind === 'wheel') {
      dispatch({ type: 'skillPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
      return true;
    }
    if (key.upArrow) {
      dispatch({ type: 'skillPickerMove', delta: -1 });
      return true;
    }
    if (key.downArrow) {
      dispatch({ type: 'skillPickerMove', delta: 1 });
      return true;
    }
    if (isEnter) {
      if (debouncedEnter(host)) return true;
      const entry = state.skillPicker.entries[state.skillPicker.selected];
      if (!entry) return true;
      dispatch({ type: 'skillPickerClose' });
      host.submit?.(`/skill ${entry.name}`);
      return true;
    }
    return true;
  }

  return false;
}
