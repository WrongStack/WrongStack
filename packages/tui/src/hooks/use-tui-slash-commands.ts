import type { TuiSlashCommandOptions } from './tui-slash-command-options.js';
import { useDesignKitSlashCommands } from './use-design-kit-slash-commands.js';
import { useProviderSlashCommands } from './use-provider-slash-commands.js';
import { useResourceSlashCommands } from './use-resource-slash-commands.js';
import { useSessionSlashCommands } from './use-session-slash-commands.js';
import { useSettingsSlashCommands } from './use-settings-slash-commands.js';

export type { TuiSlashCommandOptions } from './tui-slash-command-options.js';

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
