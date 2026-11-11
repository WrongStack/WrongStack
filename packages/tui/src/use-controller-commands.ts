import type { Director } from '@wrongstack/coordination';
import type { AppProps } from './app-props.js';
import type { resolveControllerProps } from './controller-props.js';
import type { useAppEnvironment } from './hooks/use-app-environment.js';
import type { useAppRefSpine } from './hooks/use-app-ref-spine.js';
import type { useAppState } from './hooks/use-app-state.js';
import type { useAuthPanel } from './hooks/use-auth-panel.js';
import { useCoreTuiCommands } from './hooks/use-core-tui-commands.js';
import type { useKanbanBoardFocus } from './hooks/use-kanban-board-focus.js';
import { usePanelControllers } from './hooks/use-panel-controllers.js';
import type { useSessionRewind } from './hooks/use-session-rewind.js';
import type { useStdout } from './ink.js';
import type { useControllerPanelHooks } from './use-controller-panel-hooks.js';

/**
 * Core TUI slash commands plus the panel/picker controllers they and the key pipeline open.
 */
export function useControllerCommands({
  controllerProps,
  boardFocusRef,
  setFocusedBoardId,
  stdout,
  clearPendingConfirms,
  dispatch,
  liveDirector,
  handleRewindTo,
  handleRewindRedo,
  state,
  openStatuslinePicker,
  authPanelController,
  props,
  spine,
  envResult,
  panelHooks,
}: {
  controllerProps: ReturnType<typeof resolveControllerProps>;
  boardFocusRef: ReturnType<typeof useKanbanBoardFocus>['boardFocusRef'];
  setFocusedBoardId: ReturnType<typeof useKanbanBoardFocus>['setFocusedBoardId'];
  stdout: ReturnType<typeof useStdout>['stdout'];
  clearPendingConfirms: () => void;
  dispatch: ReturnType<typeof useAppState>['dispatch'];
  liveDirector: () => Director | null;
  handleRewindTo: ReturnType<typeof useSessionRewind>['handleRewindTo'];
  handleRewindRedo: ReturnType<typeof useSessionRewind>['handleRewindRedo'];
  state: ReturnType<typeof useAppState>['state'];
  openStatuslinePicker: (field?: number) => void;
  authPanelController: ReturnType<typeof useAuthPanel>;
  props: AppProps;
  spine: ReturnType<typeof useAppRefSpine>;
  envResult: ReturnType<typeof useAppEnvironment>;
  panelHooks: ReturnType<typeof useControllerPanelHooks>;
}) {
  const { stateRef, activeCtrlRef, streamingTextRef } = spine;
  const { memoryContextMonitorRef, memoryRecordTotalRef, setLiveToolCount } = envResult;
  const { openModePicker, openBrainPanel, openShadowPanel, subagentModelsCtl, openHelpPanel } =
    panelHooks;
  const { getCronJobs, runSteerSequence } = useCoreTuiCommands({
    agent: controllerProps.agent,
    slashRegistry: controllerProps.slashRegistry,
    memoryStore: controllerProps.memoryStore,
    onPanelOpen: controllerProps.onPanelOpen,
    memoryContextMonitorRef,
    memoryRecordTotalRef,
    stateRef,
    boardFocusRef,
    setFocusedBoardId,
    terminalWidth: stdout.columns ?? 80,
    getModeLabel: controllerProps.getModeLabel,
    activeCtrlRef,
    clearPendingConfirms,
    dispatch,
    liveDirector,
    streamingTextRef,
    director: controllerProps.director,
    handleRewindTo,
    handleRewindRedo,
    getSettings: controllerProps.getSettings,
  });

  const panelControllers = usePanelControllers({
    state,
    stateRef,
    dispatch,
    getPickableProviders: controllerProps.getPickableProviders,
    getProjectPickerItems: controllerProps.getProjectPickerItems,
    getLiveSessions: controllerProps.getLiveSessions,
    onPanelOpen: controllerProps.onPanelOpen,
    openStatuslinePicker,
    openAuthPanel: authPanelController.openAuthPanel,
    openModePicker,
    openBrainPanel,
    openShadowPanel,
    openSubagentModelsPanel: controllerProps.subagentModelsHost
      ? subagentModelsCtl.openSubagentModelsPanel
      : undefined,
    openHelpPanel,
    getSettings: controllerProps.getSettings,
    getPluginItems: controllerProps.getPluginItems,
    onPluginToggle: controllerProps.onPluginToggle,
    getMcpServers: controllerProps.getMcpServers,
    onMcpToggle: controllerProps.onMcpToggle,
    onMcpRestart: controllerProps.onMcpRestart,
    onMcpManage: controllerProps.onMcpManage,
    getToolsItems: controllerProps.getToolsItems,
    onToolToggle: controllerProps.onToolToggle,
    setLiveToolCount,
    getActiveModelReasoningEffortLevels: props.getActiveModelReasoningEffortLevels,
    canOpenTreeOverlay: () =>
      Boolean(
        typeof props.treeCoordinator === 'function'
          ? props.treeCoordinator()
          : props.treeCoordinator,
      ),
    canOpenPluginPanel: () =>
      Boolean(props.pluginUiRegistry && props.pluginUiRegistry.listPanels().length > 0),
  });
  return { panelControllers, getCronJobs, runSteerSequence };
}
