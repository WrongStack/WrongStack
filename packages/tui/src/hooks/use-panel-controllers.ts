import type { TokenSavingTier } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import React, { type Dispatch, type MutableRefObject, type SetStateAction, useEffect } from 'react';
import type { Action } from '../app-action-type.js';
import { coerceAgentSwarmMode, coercePanelPositionMap } from '../app-settings-type.js';
import type { AppProps } from '../app-props.js';
import type { State } from '../app-state.js';
import { type ContextMode, DEFAULT_STATUSLINE_MODE } from '../components/settings-picker.js';
import { createPanelOpenDispatcher } from '../on-panel-open.js';

interface PanelControllersOptions {
  state: State;
  stateRef: MutableRefObject<State>;
  dispatch: Dispatch<Action>;
  getPickableProviders: AppProps['getPickableProviders'];
  getProjectPickerItems: AppProps['getProjectPickerItems'];
  getLiveSessions: AppProps['getLiveSessions'];
  onPanelOpen: AppProps['onPanelOpen'];
  openStatuslinePicker: (field?: number) => void;
  openAuthPanel: (view?: 'list' | 'oauth') => boolean;
  openModePicker: () => void | Promise<void>;
  openBrainPanel: () => void | Promise<void>;
  openShadowPanel: () => void | Promise<void>;
  openHelpPanel: () => void | Promise<void>;
  getSettings: AppProps['getSettings'];
  getPluginItems: AppProps['getPluginItems'];
  onPluginToggle: AppProps['onPluginToggle'];
  getMcpServers: AppProps['getMcpServers'];
  onMcpToggle: AppProps['onMcpToggle'];
  onMcpRestart: AppProps['onMcpRestart'];
  getToolsItems: AppProps['getToolsItems'];
  onToolToggle: AppProps['onToolToggle'];
  setLiveToolCount: Dispatch<SetStateAction<number | undefined>>;
  /** Effort levels the active model documents (model-aware settings cycle). */
  getActiveModelReasoningEffortLevels?: AppProps['getActiveModelReasoningEffortLevels'];
}

/** Owns panel openers and extension picker refresh/toggle controllers. */
export function usePanelControllers({
  state,
  stateRef,
  dispatch,
  getPickableProviders,
  getProjectPickerItems,
  getLiveSessions,
  onPanelOpen,
  openStatuslinePicker,
  openAuthPanel,
  openModePicker,
  openBrainPanel,
  openShadowPanel,
  openHelpPanel,
  getSettings,
  getPluginItems,
  onPluginToggle,
  getMcpServers,
  onMcpToggle,
  onMcpRestart,
  getToolsItems,
  onToolToggle,
  setLiveToolCount,
  getActiveModelReasoningEffortLevels,
}: PanelControllersOptions): {
  openModelPicker: () => Promise<void>;
  openProjectPicker: () => Promise<void>;
  openFKeyPicker: () => void;
  loadLiveSessions: () => Promise<void>;
  openSettings: () => void;
  toggleSelectedPlugin: () => Promise<void>;
  toggleSelectedMcpServer: () => Promise<void>;
  restartSelectedMcpServer: () => Promise<void>;
  toggleSelectedTool: () => Promise<void>;
} {
  const authPanelController = { openAuthPanel };
  // Open routines shared by their slash command AND a mouse click on the
  // matching status-bar chip. Kept in refs (below) so the empty-dep mouse
  // handler can fire the latest version without re-subscribing.
  const openModelPicker = React.useCallback(async () => {
    if (!getPickableProviders) return;
    const providers = await getPickableProviders();
    dispatch({ type: 'modelPickerOpen', providers });
  }, [getPickableProviders]);
  const openProjectPicker = React.useCallback(async () => {
    if (!getProjectPickerItems) return;
    const items = await getProjectPickerItems();
    dispatch({ type: 'projectPickerOpen', items });
  }, [getProjectPickerItems]);
  const openFKeyPicker = React.useCallback(() => {
    dispatch({ type: 'fKeyPickerOpen' });
  }, [dispatch]);
  const loadLiveSessions = React.useCallback(async () => {
    if (!getLiveSessions) {
      // No-op: show empty state (busy stays false from initial state).
      // Do NOT dispatch busy:true — that would leave the panel stuck in
      // "Loading..." forever with no way for the user to dismiss it.
      dispatch({ type: 'sessionsPanelSet', sessions: [] });
      return;
    }
    dispatch({ type: 'sessionsPanelBusy', on: true });
    try {
      const sessions = await getLiveSessions();
      dispatch({ type: 'sessionsPanelSet', sessions });
    } catch {
      dispatch({ type: 'sessionsPanelBusy', on: false });
    }
  }, [getLiveSessions]);

  // ── Slash-command → TUI panel bridge ────────────────────────────────
  // Slash commands (e.g. `/plugin`, `/plugin menu`, `/f1`…`/f12`, `/audit`)
  // call `onPanelOpen.current(action)` to dispatch a panel-open action. The
  // CLI passes `onPanelOpen` from cli-main.ts → execution.ts → run-tui.ts;
  // without binding `current` to a real dispatcher here, every such slash
  // command silently falls through to its text response and the picker
  // never opens. The dispatcher logic lives in `./on-panel-open.ts` so it
  // can be exercised by `tests/on-panel-open-bridge.test.ts` without
  // mounting React (ink-testing-library does not flush useEffects).
  useEffect(() => {
    if (!onPanelOpen) return;
    const dispatcher = createPanelOpenDispatcher({
      dispatch,
      openProjectPicker,
      openStatuslinePicker,
      openAuthPanel: authPanelController.openAuthPanel,
      openModePicker,
      openBrainPanel,
      openShadowPanel,
      openHelpPanel,
    });
    onPanelOpen.current = dispatcher;
    return () => {
      if (onPanelOpen) onPanelOpen.current = null;
    };
  }, [
    onPanelOpen,
    dispatch,
    openProjectPicker,
    openStatuslinePicker,
    authPanelController.openAuthPanel,
    openModePicker,
    openBrainPanel,
    openShadowPanel,
    openHelpPanel,
  ]);
  // Keep the F10 sessions panel live: refresh every 5s while open
  useEffect(() => {
    if (!state.sessionsPanelOpen || !getLiveSessions) return undefined;
    const t = setInterval(() => {
      void loadLiveSessions();
    }, 5_000);
    return () => clearInterval(t);
  }, [state.sessionsPanelOpen, getLiveSessions, loadLiveSessions]);
  const openSettings = React.useCallback(() => {
    if (!getSettings) return;
    const s = getSettings();
    dispatch({
      type: 'settingsOpen',
      mode: s.mode,
      delayMs: s.delayMs,
      titleAnimation: s.titleAnimation ?? true,
      yolo: s.yolo ?? false,
      fleetChat: s.fleetChatVerbosity ?? 'off',
      chime: s.chime ?? false,
      confirmExit: s.confirmExit ?? true,
      nextPrediction: s.nextPrediction ?? false,
      featureMcp: s.featureMcp ?? true,
      featurePlugins: s.featurePlugins ?? true,
      featureMemory: s.featureMemory ?? true,
      featureSkills: s.featureSkills ?? true,
      featureModelsRegistry: s.featureModelsRegistry ?? true,
      tokenSavingTier: s.featureTokenSaving ?? ('off' as TokenSavingTier),
      allowOutsideProjectRoot: s.allowOutsideProjectRoot ?? true,
      contextAutoCompact: s.contextAutoCompact ?? true,
      contextStrategy: s.contextStrategy ?? 'hybrid',
      contextMode: (s.contextMode as ContextMode) ?? 'balanced',
      maxConcurrent: s.maxConcurrent ?? 10,
      logLevel: s.logLevel ?? 'info',
      auditLevel: s.auditLevel ?? 'standard',
      indexOnStart: s.indexOnStart ?? true,
      multiDiffSummaryThreshold: s.multiDiffSummaryThreshold ?? 5,
      lastSettingsField: s.lastSettingsField ?? 0,
      maxIterations: s.maxIterations ?? 500,
      autoProceedMaxIterations: s.autoProceedMaxIterations ?? 50,
      enhanceDelayMs: s.enhanceDelayMs ?? 60_000,
      enhanceEnabled: s.enhanceEnabled ?? true,
      enhanceLanguage: (s.enhanceLanguage as 'original' | 'english') ?? 'original',
      debugStream: s.debugStream ?? false,
      statuslineMode: s.statuslineMode ?? DEFAULT_STATUSLINE_MODE,
      reasoningMode: s.reasoningMode ?? 'auto',
      reasoningEffort: s.reasoningEffort ?? 'high',
      reasoningEffortLevels: getActiveModelReasoningEffortLevels?.(),
      reasoningPreserve: s.reasoningPreserve ?? false,
      thinkingWord: s.thinkingWord ?? 'thinking',
      cacheTtl: s.cacheTtl ?? 'default',
      configScope: s.configScope ?? 'global',
      animationStyle: s.animationStyle ?? 'rainbow',
      breakerEnabled: s.breakerEnabled ?? false,
      breakerAutoKillResetMs: s.breakerAutoKillResetMs ?? 60_000,
      showModelReasoning: s.showModelReasoning ?? true,
      showAgentSwarmPanel: coerceAgentSwarmMode(s.showAgentSwarmPanel),
      // Migrate the legacy `showAgentSwarmPanel: 'sidebar'` tri-state into
      // the new per-panel `panelPositions.fleet` map so users with old
      // configs don't lose their sidebar routing. The legacy field
      // governed the FleetPanel swarm (F2), not the F3 agents monitor —
      // mapping to `agents` here would double-render both surfaces. The
      // 'off' value is dropped from the binary per-panel map (a panel is
      // either bottom or sidebar — no hidden state at the per-panel level).
      //
      // Only migrate when the per-panel key is UNDEFINED — the new field
      // is an independent toggle that persists verbatim, so an explicit
      // `panelPositions.fleet: 'bottom'` must NOT be reverted to
      // `'sidebar'` on every save.
      panelPositions: coercePanelPositionMap({
        ...s.panelPositions,
        ...(coerceAgentSwarmMode(s.showAgentSwarmPanel) === 'sidebar' &&
        s.panelPositions?.fleet === undefined
          ? { fleet: 'sidebar' as const }
          : {}),
      }),
      showSageMemoryInject: s.showSageMemoryInject ?? false,
      sageMemoryInjectThreshold: s.sageMemoryInjectThreshold ?? 0.85,
      nextStepsTool: s.nextStepsTool ?? false,
      readSymbols: s.readSymbols ?? false,
      // WrongProxy / WrongTrace: hydrate from the picker state slice.
      // Same defaults as the WebUI LocalPrefs and the CLI adapter's
      // branch tree — see tui-settings-adapter.ts.
      wrongProxyEnabled: s.wrongProxyEnabled ?? false,
      wrongProxyUrl: s.wrongProxyUrl ?? 'http://localhost:3444',
    });
  }, [getSettings, getActiveModelReasoningEffortLevels]);

  const refreshPluginPicker = React.useCallback(() => {
    if (!getPluginItems) return;
    dispatch({ type: 'pluginPickerSetItems', items: getPluginItems() });
  }, [getPluginItems]);

  useEffect(() => {
    if (!state.pluginPicker.open) return;
    refreshPluginPicker();
  }, [state.pluginPicker.open, refreshPluginPicker]);

  const toggleSelectedPlugin = React.useCallback(async () => {
    if (!onPluginToggle) return;
    const selected = stateRef.current.pluginPicker.items[stateRef.current.pluginPicker.selected];
    if (!selected) return;
    // Reserved for future rows that explicitly opt out of picker toggling.
    // Current bundled audit rows are toggleable.
    if (selected.lockable === false) {
      dispatch({
        type: 'pluginPickerHint',
        text: `${selected.name} is locked — see /plugin report for the reason.`,
      });
      return;
    }
    dispatch({ type: 'pluginPickerBusy', busy: true });
    try {
      const result = await onPluginToggle(selected.name);
      dispatch({ type: 'pluginPickerSetItems', items: result.items });
      dispatch({ type: 'pluginPickerHint', text: result.error ?? result.message });
    } catch (err) {
      dispatch({ type: 'pluginPickerBusy', busy: false });
      dispatch({
        type: 'pluginPickerHint',
        text: `Failed to toggle ${selected.name}: ${toErrorMessage(err)}`,
      });
    }
  }, [onPluginToggle]);

  // ── MCP picker ─────────────────────────────────────────────────
  const refreshMcpPicker = React.useCallback(() => {
    if (!getMcpServers) return;
    dispatch({ type: 'mcpPickerSetItems', items: getMcpServers() });
  }, [getMcpServers]);

  useEffect(() => {
    if (!state.mcpPicker.open) return;
    refreshMcpPicker();
  }, [state.mcpPicker.open, refreshMcpPicker]);

  const toggleSelectedMcpServer = React.useCallback(async () => {
    if (!onMcpToggle) return;
    const selected = stateRef.current.mcpPicker.items[stateRef.current.mcpPicker.selected];
    if (!selected) return;
    dispatch({ type: 'mcpPickerBusy', busy: true });
    try {
      const result = await onMcpToggle(selected.name);
      dispatch({ type: 'mcpPickerSetItems', items: result.items });
      dispatch({ type: 'mcpPickerHint', text: result.error ?? result.message });
    } catch (err) {
      dispatch({ type: 'mcpPickerBusy', busy: false });
      dispatch({
        type: 'mcpPickerHint',
        text: `Failed to toggle ${selected.name}: ${toErrorMessage(err)}`,
      });
    }
  }, [onMcpToggle]);

  const restartSelectedMcpServer = React.useCallback(async () => {
    if (!onMcpRestart) return;
    const selected = stateRef.current.mcpPicker.items[stateRef.current.mcpPicker.selected];
    if (!selected) return;
    dispatch({ type: 'mcpPickerBusy', busy: true });
    try {
      const result = await onMcpRestart(selected.name);
      dispatch({ type: 'mcpPickerSetItems', items: result.items });
      dispatch({ type: 'mcpPickerHint', text: result.error ?? result.message });
    } catch (err) {
      dispatch({ type: 'mcpPickerBusy', busy: false });
      dispatch({
        type: 'mcpPickerHint',
        text: `Failed to restart ${selected.name}: ${toErrorMessage(err)}`,
      });
    }
  }, [onMcpRestart]);

  // ── Tools picker ───────────────────────────────────────────────
  const refreshToolsPicker = React.useCallback(() => {
    if (!getToolsItems) return;
    const items = getToolsItems();
    dispatch({ type: 'toolsPickerSetItems', items });
    setLiveToolCount(items.filter((item) => item.enabled).length);
  }, [getToolsItems]);

  useEffect(() => {
    if (!state.toolsPicker.open) return;
    refreshToolsPicker();
  }, [state.toolsPicker.open, refreshToolsPicker]);

  const toggleSelectedTool = React.useCallback(async () => {
    if (!onToolToggle) return;
    const selected = stateRef.current.toolsPicker.items[stateRef.current.toolsPicker.selected];
    if (!selected) return;
    dispatch({ type: 'toolsPickerBusy', busy: true });
    try {
      const result = await onToolToggle(selected.name);
      dispatch({ type: 'toolsPickerSetItems', items: result.items });
      setLiveToolCount(result.items.filter((item) => item.enabled).length);
      dispatch({ type: 'toolsPickerHint', text: result.error ?? result.message });
    } catch (err) {
      dispatch({ type: 'toolsPickerBusy', busy: false });
      dispatch({
        type: 'toolsPickerHint',
        text: `Failed to toggle ${selected.name}: ${toErrorMessage(err)}`,
      });
    }
  }, [onToolToggle]);

  return {
    openModelPicker,
    openProjectPicker,
    openFKeyPicker,
    loadLiveSessions,
    openSettings,
    toggleSelectedPlugin,
    toggleSelectedMcpServer,
    restartSelectedMcpServer,
    toggleSelectedTool,
  };
}
