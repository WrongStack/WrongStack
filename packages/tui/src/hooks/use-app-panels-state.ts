import type { Dispatch } from 'react';
import type { AppProps } from '../app-props.js';
import type { Action, State } from '../app-reducer.js';
import { useAutonomousCoordinator } from './use-autonomous-coordinator.js';
import { useBrainPanel } from './use-brain-panel.js';
import { useBrainRiskSync } from './use-brain-risk-sync.js';
import { useHelpPanel } from './use-help-panel.js';
import { useModePicker } from './use-mode-picker.js';
import { useModelPickRequest } from './use-model-pick.js';
import { usePromptPicker } from './use-prompt-picker.js';
import { useShadowPanel } from './use-shadow-panel.js';
import { useStatuslineHiddenSync } from './use-statusline-hidden-sync.js';
import { useStreamChipExpiration } from './use-stream-chip-expiration.js';

export function useAppPanelsState(params: {
  projectRoot: string;
  dispatch: Dispatch<Action>;
  state: State;
  getModes?: any;
  getPickableProviders?: any;
  getBrainData?: any;
  brainPanelHost?: any;
  onBrainRiskLevel?: any;
  getShadowData?: any;
  onShadowStart?: any;
  onShadowStop?: any;
  slashRegistry?: AppProps['slashRegistry'];
  hiddenItems: any;
  setHiddenItems: (items: any) => void;
  subscribeCoordinatorEvents?: any;
}) {
  const {
    projectRoot,
    dispatch,
    state,
    getModes,
    getPickableProviders,
    getBrainData,
    brainPanelHost,
    onBrainRiskLevel,
    getShadowData,
    onShadowStart,
    onShadowStop,
    slashRegistry,
    hiddenItems,
    setHiddenItems,
    subscribeCoordinatorEvents,
  } = params;

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

  const { openHelpPanel } = useHelpPanel(dispatch, slashRegistry as any);

  useStatuslineHiddenSync({
    pickerOpen: state.statuslinePicker.open,
    pickerHidden: state.statuslinePicker.hiddenItems,
    hiddenItems,
    setHiddenItems: (items: any) => setHiddenItems(items),
  });

  useStreamChipExpiration({
    brainPrompt: state.brainPrompt,
    enhance: state.enhance,
    visibleChips: state.statuslinePicker.visibleChips,
    dispatch,
  });

  useAutonomousCoordinator(subscribeCoordinatorEvents, dispatch);

  return {
    openPromptPicker,
    setPromptFavorite,
    openModePicker,
    requestModelPick,
    handleModelPicked,
    brainCtl,
    openBrainPanel,
    changeBrainRisk,
    openShadowPanel,
    handleShadowStart,
    handleShadowStop,
    openHelpPanel,
  };
}
