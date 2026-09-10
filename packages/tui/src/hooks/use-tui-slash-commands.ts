import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Action } from '../app-action-type.js';
import type { AppProps } from '../app-props.js';
import type { State } from '../app-state.js';
import type { StatuslineItem } from '../components/statusline-picker.js';
import { useDesignKitSlashCommands } from './use-design-kit-slash-commands.js';
import { useProviderSlashCommands } from './use-provider-slash-commands.js';
import { useResourceSlashCommands } from './use-resource-slash-commands.js';
import { useSessionSlashCommands } from './use-session-slash-commands.js';
import { useSettingsSlashCommands } from './use-settings-slash-commands.js';

/** Registration options shared by the parent and its domain slice hooks. */
export interface TuiSlashCommandOptions {
  slashRegistry: AppProps['slashRegistry'];
  skillLoader: AppProps['skillLoader'];
  getResourceMenu: AppProps['getResourceMenu'];
  getPickableProviders: AppProps['getPickableProviders'];
  switchProviderAndModel: AppProps['switchProviderAndModel'];
  openModelPicker: () => Promise<void>;
  openFKeyPicker: () => void;
  projectRoot: string;
  agent: AppProps['agent'];
  dispatch: Dispatch<Action>;
  getSettings: AppProps['getSettings'];
  saveSettings: AppProps['saveSettings'];
  openSettings: () => void;
  state: State;
  openStatuslinePicker: () => void;
  setHiddenItems: (items: StatuslineItem[]) => void;
  hiddenItemsRef: MutableRefObject<StatuslineItem[]>;
  setMailboxPanelOpen: Dispatch<SetStateAction<boolean>>;
  switchAutonomy: AppProps['switchAutonomy'];
  listSessions: AppProps['listSessions'];
  openPromptPicker: () => Promise<void>;
}

/** Registers TUI-owned slash commands and releases them on dependency changes. */
export function useTuiSlashCommands({
  slashRegistry,
  skillLoader,
  getResourceMenu,
  getPickableProviders,
  switchProviderAndModel,
  openModelPicker,
  openFKeyPicker,
  projectRoot,
  agent,
  dispatch,
  getSettings,
  saveSettings,
  openSettings,
  state,
  openStatuslinePicker,
  setHiddenItems,
  hiddenItemsRef,
  setMailboxPanelOpen,
  switchAutonomy,
  listSessions,
  openPromptPicker,
}: TuiSlashCommandOptions): void {
  // Session-domain slash commands moved to slices (decomposition Phase 2):
  // 'head' → /solo · 'mid' → /mailbox, /autonomy · 'tail' → /resume.
  const sliceDeps: TuiSlashCommandOptions = {
    slashRegistry,
    skillLoader,
    getResourceMenu,
    getPickableProviders,
    switchProviderAndModel,
    openModelPicker,
    openFKeyPicker,
    projectRoot,
    agent,
    dispatch,
    getSettings,
    saveSettings,
    openSettings,
    state,
    openStatuslinePicker,
    setHiddenItems,
    hiddenItemsRef,
    setMailboxPanelOpen,
    switchAutonomy,
    listSessions,
    openPromptPicker,
  };

  useSessionSlashCommands(sliceDeps, 'head');

  useProviderSlashCommands(sliceDeps);

  useDesignKitSlashCommands(sliceDeps);

  useSettingsSlashCommands(sliceDeps, 'core');

  useSessionSlashCommands(sliceDeps, 'mid');

  useResourceSlashCommands(sliceDeps);

  useSettingsSlashCommands(sliceDeps, 'appearance');

  // Register the TUI-only `/resume` command — opens the session resume picker.
  // Selecting one triggers onResumeSession to load and replay the full
  // conversation history.
  useSessionSlashCommands(sliceDeps, 'tail');
}
