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

/**
 * Every field below is forwarded verbatim to one of the panel hooks, so the
 * types come from those hooks instead of `any`. AppProps already carries the
 * host-supplied callbacks (`getModes`, `getBrainData`, …) with their real
 * signatures — the decomposition just dropped them on the way through.
 */
export function useAppPanelsState(params: {
  projectRoot: string;
  dispatch: Dispatch<Action>;
  state: State;
  getModes?: Parameters<typeof useModePicker>[0]['getModes'];
  getPickableProviders?: Parameters<typeof useModelPickRequest>[0]['getPickableProviders'];
  getBrainData?: Parameters<typeof useBrainPanel>[0]['getBrainData'];
  brainPanelHost?: Parameters<typeof useBrainPanel>[0]['brainPanelHost'];
  onBrainRiskLevel?: Parameters<typeof useBrainRiskSync>[0]['onBrainRiskLevel'];
  getShadowData?: Parameters<typeof useShadowPanel>[1]['getShadowData'];
  onShadowStart?: Parameters<typeof useShadowPanel>[1]['onShadowStart'];
  onShadowStop?: Parameters<typeof useShadowPanel>[1]['onShadowStop'];
  /**
   * Required: `useHelpPanel` calls `slashRegistry.listWithOwner()` with no
   * guard, so an omitted registry threw the moment the help panel opened.
   * The previous `as any` at the call site hid exactly that.
   */
  slashRegistry: AppProps['slashRegistry'];
  hiddenItems: Parameters<typeof useStatuslineHiddenSync>[0]['hiddenItems'];
  setHiddenItems: Parameters<typeof useStatuslineHiddenSync>[0]['setHiddenItems'];
  subscribeCoordinatorEvents?: Parameters<typeof useAutonomousCoordinator>[0];
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

  const { openHelpPanel } = useHelpPanel(dispatch, slashRegistry);

  useStatuslineHiddenSync({
    pickerOpen: state.statuslinePicker.open,
    pickerHidden: state.statuslinePicker.hiddenItems,
    hiddenItems,
    setHiddenItems,
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
