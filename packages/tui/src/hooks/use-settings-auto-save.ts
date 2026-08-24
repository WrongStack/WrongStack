import { type Dispatch, useEffect, useRef } from 'react';
import type { Action } from '../app-action-type.js';
import type { AppProps } from '../app-props.js';
import type { State } from '../app-state.js';

/** Persists live SettingsPicker mutations while skipping its initial hydration. */
export function useSettingsAutoSave(
  state: State,
  saveSettings: AppProps['saveSettings'],
  dispatch: Dispatch<Action>,
): void {
  // ── Auto-save settings on value change (←/→ arrow keys) ──
  // Gate ref: skip the first effect fire when settings just opened (all fields
  // were populated from getSettings(), so saving would be a no-op double-write).
  const settingsAutoSaveGateRef = useRef(true);

  // Reset the gate when settings opens.
  useEffect(() => {
    if (state.settingsPicker.open) {
      settingsAutoSaveGateRef.current = true;
    }
  }, [state.settingsPicker.open]);

  // Persist settings whenever a value field changes (mode, delayMs, toggles, …).
  // Does NOT fire on field-navigation (↑/↓) — only on value mutation (←/→).
  useEffect(() => {
    const sp = state.settingsPicker;
    const save = saveSettings;
    if (!sp.open || !save) return;

    if (settingsAutoSaveGateRef.current) {
      settingsAutoSaveGateRef.current = false;
      return;
    }

    Promise.resolve(
      save({
        mode: sp.mode,
        delayMs: sp.delayMs,
        titleAnimation: sp.titleAnimation,
        yolo: sp.yolo,
        fleetChatVerbosity: sp.fleetChat,
        chime: sp.chime,
        confirmExit: sp.confirmExit,
        nextPrediction: sp.nextPrediction,
        featureMcp: sp.featureMcp,
        featurePlugins: sp.featurePlugins,
        featureMemory: sp.featureMemory,
        featureSkills: sp.featureSkills,
        featureModelsRegistry: sp.featureModelsRegistry,
        featureTokenSaving: sp.tokenSavingTier,
        allowOutsideProjectRoot: sp.allowOutsideProjectRoot,
        contextAutoCompact: sp.contextAutoCompact,
        contextStrategy: sp.contextStrategy,
        contextMode: sp.contextMode,
        maxConcurrent: sp.maxConcurrent,
        logLevel: sp.logLevel,
        auditLevel: sp.auditLevel,
        indexOnStart: sp.indexOnStart,
        multiDiffSummaryThreshold: sp.multiDiffSummaryThreshold,
        lastSettingsField: sp.lastSettingsField,
        maxIterations: sp.maxIterations,
        autoProceedMaxIterations: sp.autoProceedMaxIterations,
        enhanceDelayMs: sp.enhanceDelayMs,
        preRefineSeconds: sp.preRefineSeconds,
        enhanceEnabled: sp.enhanceEnabled,
        enhanceLanguage: sp.enhanceLanguage,
        debugStream: sp.debugStream,
        statuslineMode: sp.statuslineMode,
        reasoningMode: sp.reasoningMode,
        reasoningEffort: sp.reasoningEffort,
        reasoningPreserve: sp.reasoningPreserve,
        thinkingWord: sp.thinkingWord,
        cacheTtl: sp.cacheTtl,
        configScope: sp.configScope,
        animationStyle: sp.animationStyle,
        breakerEnabled: sp.breakerEnabled,
        breakerAutoKillResetMs: sp.breakerAutoKillResetMs,
        showModelReasoning: sp.showModelReasoning,
        showAgentSwarmPanel: sp.showAgentSwarmPanel,
        panelPositions: sp.panelPositions,
        showSageMemoryInject: sp.showSageMemoryInject,
        sageMemoryInjectThreshold: sp.sageMemoryInjectThreshold,
        nextStepsTool: sp.nextStepsTool,
        readSymbols: sp.readSymbols,
        // WrongProxy / WrongTrace: persist the picker-state values to
        // the same Config keys the adapter exposes (see LiveSettingsInput
        // and the tui-settings-adapter.ts branch tree). Optional with
        // `??` fallback — older persisted configs may not have the keys.
        wrongProxyEnabled: sp.wrongProxyEnabled ?? false,
        wrongProxyUrl: sp.wrongProxyUrl ?? 'http://localhost:8000',
      }),
    ).then((err: string | null) => {
      if (err) dispatch({ type: 'settingsHint', text: err });
    });
  }, [
    state.settingsPicker.open,
    state.settingsPicker.mode,
    state.settingsPicker.delayMs,
    state.settingsPicker.titleAnimation,
    state.settingsPicker.yolo,
    state.settingsPicker.fleetChat,
    state.settingsPicker.chime,
    state.settingsPicker.confirmExit,
    state.settingsPicker.nextPrediction,
    state.settingsPicker.featureMcp,
    state.settingsPicker.featurePlugins,
    state.settingsPicker.featureMemory,
    state.settingsPicker.featureSkills,
    state.settingsPicker.featureModelsRegistry,
    state.settingsPicker.tokenSavingTier,
    state.settingsPicker.allowOutsideProjectRoot,
    state.settingsPicker.contextAutoCompact,
    state.settingsPicker.contextStrategy,
    state.settingsPicker.contextMode,
    state.settingsPicker.maxConcurrent,
    state.settingsPicker.logLevel,
    state.settingsPicker.auditLevel,
    state.settingsPicker.indexOnStart,
    state.settingsPicker.multiDiffSummaryThreshold,
    state.settingsPicker.maxIterations,
    state.settingsPicker.autoProceedMaxIterations,
    state.settingsPicker.enhanceDelayMs,
    state.settingsPicker.preRefineSeconds,
    state.settingsPicker.enhanceEnabled,
    state.settingsPicker.enhanceLanguage,
    state.settingsPicker.debugStream,
    state.settingsPicker.statuslineMode,
    state.settingsPicker.reasoningMode,
    state.settingsPicker.reasoningEffort,
    state.settingsPicker.reasoningPreserve,
    state.settingsPicker.thinkingWord,
    state.settingsPicker.cacheTtl,
    state.settingsPicker.configScope,
    state.settingsPicker.animationStyle,
    state.settingsPicker.breakerEnabled,
    state.settingsPicker.breakerAutoKillResetMs,
    state.settingsPicker.showModelReasoning,
    state.settingsPicker.showAgentSwarmPanel,
    state.settingsPicker.panelPositions,
    state.settingsPicker.showSageMemoryInject,
    state.settingsPicker.sageMemoryInjectThreshold,
    state.settingsPicker.nextStepsTool,
    state.settingsPicker.readSymbols,
    state.settingsPicker.wrongProxyEnabled,
    state.settingsPicker.wrongProxyUrl,
    saveSettings,
  ]);
}
