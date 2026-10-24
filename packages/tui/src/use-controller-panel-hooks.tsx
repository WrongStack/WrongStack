import { useAutonomousCoordinator } from './hooks/use-autonomous-coordinator.js';
import { useBrainPanel } from './hooks/use-brain-panel.js';
import { useBrainRiskSync } from './hooks/use-brain-risk-sync.js';
import { useBugHuntLoop } from './hooks/use-bug-hunt-loop.js';
import { useHelpPanel } from './hooks/use-help-panel.js';
import { useMailboxViewModel } from './hooks/use-mailbox-view-model.js';
import { useModePicker } from './hooks/use-mode-picker.js';
import { useModelPickRequest } from './hooks/use-model-pick.js';
import { usePromptPicker } from './hooks/use-prompt-picker.js';
import { useShadowPanel } from './hooks/use-shadow-panel.js';
import { useSubagentModelsPanel } from './hooks/use-subagent-models-panel.js';
export function useControllerPanelHooks(inputs: {
  projectRoot: string;
  dispatch: React.ActionDispatch<[action: import('./app-action-type.js').Action]>;
  getModes:
    | (() => Promise<{
        modes: import('@wrongstack/contracts/types').Mode[];
        activeId: string | null;
      }>)
    | undefined;
  getPickableProviders: (() => Promise<import('./ui-contracts.js').ProviderOption[]>) | undefined;
  state: import('./app-state.js').State;
  getBrainData:
    | (() => {
        riskLevel: import('./brain-contracts.js').BrainRiskLevel;
        log: { kind: string; question: string; outcome: string; age: string }[];
      })
    | undefined;
  brainPanelHost: import('./brain-panel-model.js').BrainPanelHost | undefined;
  onBrainRiskLevel:
    | ((level: import('./brain-contracts.js').BrainRiskLevel) => string | undefined)
    | undefined;
  getShadowData:
    | (() => { activeId: string | null; running: boolean; model: string; intervalMs: number })
    | undefined;
  onShadowStart: (() => Promise<string | undefined>) | undefined;
  onShadowStop: (() => Promise<string | undefined>) | undefined;
  subagentModelsHost:
    | import('./subagent-models-panel-model.js').SubagentModelsPanelHost
    | undefined;
  slashRegistry: import('@wrongstack/core/registry').SlashCommandRegistry;
  subscribeCoordinatorEvents:
    | ((
        fn: (event: import('@wrongstack/core/coordination').CoordinatorEvent) => void,
      ) => () => void)
    | undefined;
  submitRef: React.RefObject<(text?: string | undefined) => void>;
  events: import('@wrongstack/contracts/kernel').EventBus;
}) {
  const {
    projectRoot,
    dispatch,
    getModes,
    getPickableProviders,
    state,
    getBrainData,
    brainPanelHost,
    onBrainRiskLevel,
    getShadowData,
    onShadowStart,
    onShadowStop,
    subagentModelsHost,
    slashRegistry,
    subscribeCoordinatorEvents,
    submitRef,
    events,
  } = inputs;

  const { openPromptPicker, setPromptFavorite } = usePromptPicker({ projectRoot, dispatch });
  const { openModePicker } = useModePicker({ dispatch, getModes });

  const { requestModelPick, handleModelPicked } = useModelPickRequest({
    dispatch,
    getPickableProviders,
    pickerOpen: state.modelPicker.open,
  });
  const brainCtl = useBrainPanel({ dispatch, getBrainData, brainPanelHost, requestModelPick });
  const openBrainPanel = brainCtl.openBrainPanel;
  const { changeBrainRisk } = useBrainRiskSync({
    dispatch,
    riskLevel: state.brainPanel.riskLevel,
    brainPanelOpen: state.brainPanel.open,
    onBrainRiskLevel,
  });

  const { openShadowPanel, handleShadowStart, handleShadowStop } = useShadowPanel(dispatch, {
    getShadowData,
    onShadowStart,
    onShadowStop,
  });

  const subagentModelsCtl = useSubagentModelsPanel({
    dispatch,
    subagentModelsHost,
    requestModelPick,
  });

  const { openHelpPanel } = useHelpPanel(dispatch, slashRegistry);

  useAutonomousCoordinator(subscribeCoordinatorEvents, dispatch);

  const bugHuntLoop = useBugHuntLoop(
    dispatch,
    (command) => {
      void submitRef.current(command);
    },
    // Wholesale history replacement (notably /clear) must end any hunt —
    // see the historyGen effect inside useBugHuntLoop.
    state.historyGen,
  );

  const mailbox = useMailboxViewModel(events);
  const { setMailboxPanelOpen } = mailbox;
  return {
    openPromptPicker,
    setPromptFavorite,
    openModePicker,
    handleModelPicked,
    brainCtl,
    openBrainPanel,
    changeBrainRisk,
    openShadowPanel,
    handleShadowStart,
    handleShadowStop,
    subagentModelsCtl,
    openHelpPanel,
    bugHuntLoop,
    mailbox,
    setMailboxPanelOpen,
  };
}
