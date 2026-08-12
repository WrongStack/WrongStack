import type React from 'react';
import type { Action, State } from '../app-reducer.js';
import type { BrainPanelRow } from '../brain-panel-model.js';
import type { AutonomyStage } from './use-statusline-state.js';

export interface PickerKeysHost {
  state: State;
  dispatch: React.Dispatch<Action>;
  lastEnterAtRef: { current: number };
  inputGateRef: { current: boolean };

  switchProviderAndModel:
    | ((providerId: string, modelId: string) => string | null | Promise<string | null>)
    | undefined;
  setLiveProvider: ((v: string) => void) | undefined;
  setLiveModel: ((v: string) => void) | undefined;
  setActiveMaxContext: ((v: number | undefined) => void) | undefined;
  getAgentCtxMaxContext: () => number;
  activeMaxContext: number | undefined;
  currentContextTokens: number;
  currentProvider: string | undefined;
  currentModel: string | undefined;

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
  onPromptPickerFavorite: (() => void) | undefined;
  onPromptPickerEdit: (() => void) | undefined;
  onResumePickerEnter: (() => Promise<void>) | undefined;
  onSessionsPanelEnter: (() => Promise<void>) | undefined;
  onProjectPickerEnter: (() => Promise<void>) | undefined;
  onSlashPickerEnter: (() => void) | undefined;
  onSettingsPickerEnter: (() => void) | undefined;
  onPluginPickerToggle: (() => Promise<void> | void) | undefined;
  onMcpPickerToggle: (() => Promise<void> | void) | undefined;
  onMcpPickerRestart: (() => Promise<void> | void) | undefined;
  onToolsPickerToggle: (() => Promise<void> | void) | undefined;
  onHelpPanelEnter: (() => void) | undefined;
  onBrainRiskChange: ((delta: number) => void) | undefined;
  onBrainAdjust: ((row: BrainPanelRow, delta: number) => void) | undefined;
  onBrainEnter: ((row: BrainPanelRow) => void) | undefined;
  onBrainDelete: ((row: BrainPanelRow) => void) | undefined;
  onBrainVoterMod: ((index: number, mod: 'persona' | 'veto') => void) | undefined;
  onModelPicked: ((providerId: string, modelId: string) => void) | undefined;
  onShadowStart: (() => Promise<void> | void) | undefined;
  onShadowStop: (() => Promise<void> | void) | undefined;
  onFKeyPickerEnter: (() => void) | undefined;
  onPickerEnter: (() => Promise<void>) | undefined;
  /**
   * Enter-handler for the `/theme` picker. The key dispatcher delegates
   * the apply step here so the parent can call `setActiveTheme()` and
   * persist the choice to configStore. Optional — omitted hosts simply
   * leave Enter as a no-op (the picker still navigates, just doesn't apply).
   */
  onThemePickerEnter?: (() => void) | undefined;

  onSlashPickerTab: (() => void) | undefined;
}
