import { SKILL_LIMITS, stripFrontmatter } from '@wrongstack/core/skills';
import { toErrorMessage } from '@wrongstack/core/utils';
import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect } from 'react';
import type { Action } from '../app-action-type.js';
import type { AppProps } from '../app-props.js';
import type { State } from '../app-state.js';
import type { StatuslineItem } from '../components/statusline-picker.js';
import { registerSlashCommandLifecycle } from '../slash-command-lifecycle.js';
import { useDesignKitSlashCommands } from './use-design-kit-slash-commands.js';
import { useProviderSlashCommands } from './use-provider-slash-commands.js';
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

  // Bare `/skill` is a visual browser in the TUI. The named form keeps the
  // established behavior and opens the selected skill's capped instructions.
  useEffect(() => {
    if (!skillLoader) return;
    const cmd = {
      name: 'skill',
      aliases: ['skills'],
      description: 'Browse available skills and inspect the selected skill.',
      argsHint: '[name]',
      async run(args: string) {
        const name = (args ?? '').trim();
        if (name) {
          const skill = await skillLoader.find(name);
          if (!skill) return { message: `Skill "${name}" not found.` };
          const body = stripFrontmatter(await skillLoader.readBody(skill.name));
          const capped = body.slice(0, SKILL_LIMITS.MAX_SKILL_BODY_CHARS);
          return {
            message:
              capped.length < body.length
                ? `${capped}\n\n[Skill instructions truncated at ${SKILL_LIMITS.MAX_SKILL_BODY_CHARS.toLocaleString()} characters.]`
                : capped,
          };
        }

        try {
          const entries = await skillLoader.listEntries();
          dispatch({ type: 'skillPickerOpen', entries });
          return { message: undefined };
        } catch (err) {
          return { message: `Could not load skills: ${toErrorMessage(err)}` };
        }
      },
    };
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [slashRegistry, skillLoader, dispatch]);

  // Operational commands keep their typed CLI forms, while the bare form
  // opens a shared two-pane browser backed by live host state.
  useEffect(() => {
    if (!getResourceMenu) return;
    const names = [
      'fallback',
      'tier',
      'profile',
      'provider-status',
      'memory',
      'worktree',
      'git',
    ] as const;
    const cleanups: Array<() => void> = [];
    for (const name of names) {
      const original = slashRegistry.get(name);
      cleanups.push(
        registerSlashCommandLifecycle(
          slashRegistry,
          {
            name,
            description: original?.description ?? `Browse ${name} state interactively.`,
            argsHint: original?.argsHint,
            help: original?.help,
            async run(args: string, ctx) {
              if (args.trim())
                return original?.run(args, ctx) ?? { message: `/${name} is unavailable.` };
              try {
                const snapshot = await getResourceMenu(name);
                dispatch({ type: 'resourceMenuOpen', snapshot });
                return { message: undefined };
              } catch (err) {
                return { message: `Could not load ${name}: ${toErrorMessage(err)}` };
              }
            },
          },
          { owner: 'tui', official: true },
        ),
      );
    }
    return () => {
      for (const cleanup of [...cleanups].reverse()) cleanup();
    };
  }, [slashRegistry, getResourceMenu, dispatch]);

  // Existing live monitors are the richer UI for these resources. Typed
  // subcommands still flow to their canonical CLI handlers.
  useEffect(() => {
    const definitions = [
      { name: 'cron', open: () => dispatch({ type: 'toggleCronMonitor' as const }) },
      { name: 'prompts', open: () => void openPromptPicker() },
    ] as const;
    const cleanups: Array<() => void> = [];
    for (const definition of definitions) {
      const original = slashRegistry.get(definition.name);
      cleanups.push(
        registerSlashCommandLifecycle(
          slashRegistry,
          {
            name: definition.name,
            description: original?.description ?? `Open the ${definition.name} browser.`,
            argsHint: original?.argsHint,
            help: original?.help,
            async run(args: string, ctx) {
              if (args.trim()) {
                return (
                  original?.run(args, ctx) ?? { message: `/${definition.name} is unavailable.` }
                );
              }
              definition.open();
              return { message: undefined };
            },
          },
          { owner: 'tui', official: true },
        ),
      );
    }
    return () => {
      for (const cleanup of [...cleanups].reverse()) cleanup();
    };
  }, [slashRegistry, dispatch, openPromptPicker]);

  useSettingsSlashCommands(sliceDeps, 'appearance');

  // Register the TUI-only `/resume` command — opens the session resume picker.
  // Selecting one triggers onResumeSession to load and replay the full
  // conversation history.
  useSessionSlashCommands(sliceDeps, 'tail');
}
