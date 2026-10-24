import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Action } from '../app-action-type.js';
import type { AppProps } from '../app-props.js';
import type { State } from '../app-state.js';
import type { StatuslineItem } from '../components/statusline-picker.js';

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
  /**
   * Live ConfigStore + the persist callback, threaded here so `/theme <preset>`
   * can apply a named preset directly instead of only opening the picker. Both
   * are optional: without them the command still opens the picker, it just
   * cannot persist an immediate apply.
   */
  configStore?: import('@wrongstack/contracts/types').ConfigStore | undefined;
  saveThemePreset?: AppProps['saveThemePreset'];
  applyThemePreset?:
    | ((preset: import('@wrongstack/contracts/types').ThemePresetId) => void)
    | undefined;
}
