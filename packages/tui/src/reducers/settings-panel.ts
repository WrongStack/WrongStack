import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';
import { SETTINGS_FIELD_COUNT } from '../components/settings-picker.js';
import { coercePanelPositionMap } from '../app-settings-type.js';
import { closePanels } from './helpers.js';

const settingsPanelActionTypes = [
  'settingsOpen',
  'settingsClose',
  'settingsFieldMove',
  'settingsFieldSet',
  'settingsFilterSet',
] as const satisfies readonly Action['type'][];

type SettingsPanelAction = Extract<Action, { type: (typeof settingsPanelActionTypes)[number] }>;
const settingsPanelActionTypeSet = new Set<string>(settingsPanelActionTypes);

export function isSettingsPanelAction(action: Action): action is SettingsPanelAction {
  return settingsPanelActionTypeSet.has(action.type);
}

/** Reduces opening, closing, focus, and filtering for the settings panel. */
export function reduceSettingsPanel(state: State, action: SettingsPanelAction): State {
  switch (action.type) {
    case 'settingsOpen':
      return {
        ...state,
        ...closePanels(state),
        settingsPicker: {
          open: true,
          // The persisted `lastSettingsField` (from the canonical Settings
          // shape) drives where the picker lands on open. The slice's
          // `field` is a working copy that mirrors it until the user
          // navigates again. `state.settingsPicker.lastSettingsField` is
          // the fallback for the (rare) case where the action omits it
          // — e.g., a tests/dispatch path that hasn't been updated yet.
          // `||` (not `??`): a payload `lastSettingsField` of 0 means
          // "no saved value" (the default in the canonical Settings),
          // so we fall through to the runtime state's tracked value.
          // This lets the in-session `settingsFieldSet`/`settingsFieldMove`
          // preserve the field across close/reopen within the same session,
          // while a non-zero persisted value (loaded from disk) takes
          // priority on a fresh open.
          field: action.lastSettingsField || state.settingsPicker.lastSettingsField || 0,
          lastSettingsField:
            action.lastSettingsField || state.settingsPicker.lastSettingsField || 0,
          mode: action.mode,
          delayMs: action.delayMs,
          titleAnimation: action.titleAnimation,
          yolo: action.yolo,
          fleetChat: action.fleetChat,
          chime: action.chime,
          confirmExit: action.confirmExit,
          nextPrediction: action.nextPrediction,
          featureMcp: action.featureMcp,
          featurePlugins: action.featurePlugins,
          featureMemory: action.featureMemory,
          featureSkills: action.featureSkills,
          featureModelsRegistry: action.featureModelsRegistry,
          tokenSavingTier: action.tokenSavingTier,
          allowOutsideProjectRoot: action.allowOutsideProjectRoot,
          contextAutoCompact: action.contextAutoCompact,
          contextStrategy: action.contextStrategy,
          contextMode: action.contextMode,
          maxConcurrent: action.maxConcurrent,
          logLevel: action.logLevel,
          auditLevel: action.auditLevel,
          indexOnStart: action.indexOnStart,
          multiDiffSummaryThreshold: action.multiDiffSummaryThreshold,
          maxIterations: action.maxIterations,
          autoProceedMaxIterations: action.autoProceedMaxIterations,
          enhanceDelayMs: action.enhanceDelayMs,
          preRefineSeconds: state.settingsPicker.preRefineSeconds,
          enhanceEnabled: action.enhanceEnabled,
          enhanceLanguage: action.enhanceLanguage,
          debugStream: action.debugStream,
          statuslineMode: action.statuslineMode,
          reasoningMode: action.reasoningMode,
          reasoningEffort: action.reasoningEffort,
          reasoningPreserve: action.reasoningPreserve,
          thinkingWord: action.thinkingWord,
          thinkingWordEditing: false,
          thinkingWordDraft: '',
          // Filter is always cleared on open — the user starts fresh.
          // Persisted `lastSettingsField` is restored separately above.
          filter: '',
          cacheTtl: action.cacheTtl,
          configScope: action.configScope,
          animationStyle: action.animationStyle,
          breakerEnabled: action.breakerEnabled,
          breakerAutoKillResetMs: action.breakerAutoKillResetMs,
          showModelReasoning: action.showModelReasoning,
          showAgentSwarmPanel: action.showAgentSwarmPanel,
          panelPositions: coercePanelPositionMap(action.panelPositions),
          showSageMemoryInject: action.showSageMemoryInject,
          sageMemoryInjectThreshold: action.sageMemoryInjectThreshold,
          nextStepsTool: action.nextStepsTool,
          readSymbols: action.readSymbols,
          // WrongProxy / WrongTrace: hydrate from the persisted boot-time
          // values pushed into the action by the TUI settings adapter.
          // The runtime probe (see `packages/cli/src/wiring/proxy-probe.ts`)
          // reacts to these via the WS `prefs.update` pipeline.
          wrongProxyEnabled: action.wrongProxyEnabled,
          wrongProxyUrl: action.wrongProxyUrl,
          // WrongProxy URL text-edit state (field 60): always defaults to
          // 'not editing' + empty draft on open. The Start action seeds
          // the draft from `wrongProxyUrl` at the reducer boundary.
          wrongProxyUrlEditing: false,
          wrongProxyUrlDraft: '',
          hint: undefined,
        },
      };
    case 'settingsClose':
      // Always reset the text-edit flag + draft on close, so a stuck
      // edit never leaks into the next open.
      return {
        ...state,
        ...closePanels(state),
        settingsPicker: {
          ...state.settingsPicker,
          open: false,
          filter: '',
          wrongProxyUrlEditing: false,
          wrongProxyUrlDraft: '',
        },
      };
    case 'settingsFieldMove': {
      const next =
        (state.settingsPicker.field + action.delta + SETTINGS_FIELD_COUNT) % SETTINGS_FIELD_COUNT;
      // Moving focus abandons any in-progress thinking-word edit so the draft
      // can't linger on an unrelated field. `lastSettingsField` tracks the
      // current focus so the canonical Settings shape stays in sync — the
      // app.tsx auto-save effect writes it back to disk.
      // Also abandons any in-progress WrongProxy URL edit (field 60) for
      // the same reason — a stale draft can't survive navigation.
      return {
        ...state,
        settingsPicker: {
          ...state.settingsPicker,
          field: next,
          lastSettingsField: next,
          thinkingWordEditing: false,
          thinkingWordDraft: '',
          wrongProxyUrlEditing: false,
          wrongProxyUrlDraft: '',
          hint: undefined,
        },
      };
    }
    case 'settingsFieldSet': {
      const field = action.field >= 0 && action.field < SETTINGS_FIELD_COUNT ? action.field : 0;
      // Keep `lastSettingsField` in sync with the new focus so the
      // canonical Settings shape reflects the user's most recent pick
      // even if the picker is closed before the auto-save effect fires.
      // Also abandons any in-progress WrongProxy URL edit (field 60) for
      // the same reason — a stale draft can't survive a direct jump.
      return {
        ...state,
        settingsPicker: {
          ...state.settingsPicker,
          field,
          lastSettingsField: field,
          wrongProxyUrlEditing: false,
          wrongProxyUrlDraft: '',
          hint: undefined,
        },
      };
    }
    case 'settingsFilterSet':
      // Live filter for the row-search modal. Setting a non-empty value
      // implicitly activates filter mode; setting '' clears it. The
      // `lastSettingsField` is intentionally untouched — a filter is
      // navigation, not a value the user is "configuring".
      return {
        ...state,
        settingsPicker: { ...state.settingsPicker, filter: action.filter },
      };
    default:
      void (action satisfies never);
      return state;
  }
}
