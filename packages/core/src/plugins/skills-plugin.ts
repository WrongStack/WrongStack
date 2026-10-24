import type { Plugin } from '@wrongstack/contracts/types/plugin';
import type { SkillLoader } from '@wrongstack/contracts/types/skill';
import type { SlashCommand } from '@wrongstack/contracts/types/slash-command';
import { capSkillBody, stripFrontmatter } from '../core/system-prompt-skill-text.js';
import { githubDirectAdapter } from '../skills/registry/github-direct-adapter.js';
import type { SkillRegistryAdapter } from '../skills/registry/registry-adapter.js';
import {
  createSkillsShAdapter,
  DEFAULT_SKILLS_SH_URL,
} from '../skills/registry/skills-sh-adapter.js';
import { color } from '../utils/color.js';
import { buildSkillGeneratorCommand } from './skills-plugin-authoring.js';
import { skillDiscoveryReport } from './skills-plugin-diagnostics.js';
import {
  buildSkillImportCommand,
  buildSkillInstallCommand,
  buildSkillSearchCommand,
  buildSkillUninstallCommand,
  buildSkillUpdateCommand,
} from './skills-plugin-registry.js';

export { buildSkillGeneratorCommand } from './skills-plugin-authoring.js';
export {
  buildSkillImportCommand,
  buildSkillInstallCommand,
  buildSkillSearchCommand,
  buildSkillUninstallCommand,
  buildSkillUpdateCommand,
  resolveImportSourceDir,
} from './skills-plugin-registry.js';

interface SkillsPluginOptions {
  skillLoader?: SkillLoader | undefined;
  /**
   * Registry adapters. When unset the plugin wires the github-direct adapter
   * (for `user/repo` installs) plus a skills.sh adapter pointed at
   * `config.skills.registryUrl` (default {@link DEFAULT_SKILLS_SH_URL}).
   */
  registryAdapters?: SkillRegistryAdapter[] | undefined;
}

/**
 * SkillsPlugin — skill library + installer + authoring toolkit.
 *
 * Registers `/skill`, `/skill-gen`, `/skill-search`, `/skill-install`,
 * `/skill-import`, `/skill-update`, `/skill-uninstall`. First-party ("official")
 * plugin, so the commands keep their bare names. Needs a `SkillLoader` (injected
 * by the host via `config.skillLoader`); without one the commands report that
 * and no-op.
 */
export function createSkillsPlugin(opts?: SkillsPluginOptions): Plugin {
  return {
    name: 'wstack-skills',
    version: '1.1.0',
    description:
      'Skill library, registry search, installer and authoring toolkit: /skill, /skill-gen, /skill-search, /skill-install, ...',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      const rawConfig = api.config as never as Record<string, unknown>;
      const skillLoader = opts?.skillLoader ?? (rawConfig.skillLoader as SkillLoader | undefined);
      const registryUrl =
        (rawConfig.skills as { registryUrl?: string } | undefined)?.registryUrl?.trim() ||
        undefined;

      const registryAdapters = opts?.registryAdapters ?? [
        githubDirectAdapter,
        createSkillsShAdapter(registryUrl ? { baseUrl: registryUrl } : {}),
      ];

      api.slashCommands.register(buildSkillCommand(skillLoader));
      api.slashCommands.register(buildSkillGeneratorCommand(skillLoader));
      api.slashCommands.register(buildSkillSearchCommand(skillLoader, registryAdapters));
      api.slashCommands.register(buildSkillInstallCommand(skillLoader, registryAdapters));
      api.slashCommands.register(buildSkillImportCommand(skillLoader));
      api.slashCommands.register(buildSkillUpdateCommand(skillLoader, registryAdapters));
      api.slashCommands.register(buildSkillUninstallCommand(skillLoader));
      api.log.info(
        '[skills] loaded — /skill, /skill-gen, /skill-search, /skill-install, /skill-import, /skill-update/uninstall available',
      );
    },

    teardown(api) {
      for (const name of [
        'skill',
        'skill-gen',
        'skill-search',
        'skill-install',
        'skill-import',
        'skill-update',
        'skill-uninstall',
      ]) {
        api.slashCommands.unregister(name);
      }
      api.log.info('[skills] unloaded');
    },

    async health() {
      return { ok: true, message: 'skills ready' };
    },
  };
}

export function buildSkillCommand(skillLoader?: SkillLoader): SlashCommand {
  return {
    name: 'skill',
    description:
      'Show skill details or list available skills. Use /skill-gen to create new skills.',
    argsHint: '[name|use <name> <task>|reload|diagnostics]',
    help: 'List skills with /skill, inspect one with /skill <name>, or use /skill diagnostics to explain sources, shadowing and progressive prompt exclusions. /skill reload rescans the catalog.',
    async run(args, ctx) {
      if (!skillLoader) return { message: 'No skill loader configured.' };
      if (args.trim() === 'diagnostics') {
        const tools = ctx && (ctx.catalogTools.length > 0 ? ctx.catalogTools : ctx.tools);
        return skillDiscoveryReport(
          skillLoader,
          tools?.map((tool) => tool.name),
        );
      }
      if (args.trim() === 'reload') {
        skillLoader.invalidateCache();
        return { message: `Reloaded ${(await skillLoader.list()).length} skills.` };
      }
      const explicitUse = /^use\s+(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
      if (explicitUse) {
        const selected = await skillLoader.find(explicitUse[1] ?? '');
        if (!selected) return { message: `Skill "${explicitUse[1]}" not found.` };
        return {
          message: `Using skill "${selected.name}".`,
          runText: `Load the ${selected.name} skill with the skill tool, including any continuation pages, and apply its instructions to this task: ${explicitUse[2] || 'Continue the current user task.'}`,
        };
      }
      if (!args.trim()) {
        const entries = await skillLoader.listEntries();
        if (entries.length === 0) return { message: 'No skills found.' };
        const lines = entries.map((e) => {
          const scopeTag =
            e.scope.length > 0 ? `  ${color.dim(`(${e.scope.slice(0, 3).join(', ')})`)}` : '';
          return `  ${color.bold(e.name)}${scopeTag}\n    Use when: ${e.trigger}`;
        });
        return { message: `Available skills:\n${lines.join('\n\n')}\n` };
      }
      const skill = await skillLoader.find(args.trim());
      if (!skill) return { message: `Skill "${args.trim()}" not found.` };
      // Show the same frontmatter-free, capped body the model sees via the
      // `skill` tool and prompt injection — not the raw, unbounded SKILL.md
      // (a multi-KB skill would otherwise dump wholesale into the CLI output).
      const body = capSkillBody(stripFrontmatter(await skillLoader.readBody(skill.name)));
      return { message: body };
    },
  };
}
