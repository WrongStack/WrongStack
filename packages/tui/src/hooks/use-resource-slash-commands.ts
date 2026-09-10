import { SKILL_LIMITS, stripFrontmatter } from '@wrongstack/core/skills';
import { toErrorMessage } from '@wrongstack/core/utils';
import { useEffect } from 'react';
import { registerSlashCommandLifecycle } from '../slash-command-lifecycle.js';
import type { TuiSlashCommandOptions } from './use-tui-slash-commands.js';

/**
 * Resource-domain slash commands (/skill, the seven operational resource-menu
 * browsers fallback/tier/profile/provider-status/memory/worktree/git, and
 * cron/prompts), moved verbatim from useTuiSlashCommands (decomposition
 * Phase 2 — docs/decomposition-plan.md). Registers at pinned positions
 * 12–21 (tests/slash-registration-enumeration.test.ts), between the session
 * slice's 'mid' part (10–11) and the settings slice's 'appearance' part (22).
 */
export function useResourceSlashCommands(deps: TuiSlashCommandOptions): void {
  const { slashRegistry, skillLoader, getResourceMenu, dispatch, openPromptPicker } = deps;

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
}
