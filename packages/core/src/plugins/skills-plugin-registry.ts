/** Registry-backed skill commands: `/skill-search`, `/skill-install`, `/skill-import`, `/skill-update`, `/skill-uninstall`. */

import * as os from 'node:os';
import * as path from 'node:path';
import type { SkillLoader } from '@wrongstack/contracts/types/skill';
import type { SlashCommand } from '@wrongstack/contracts/types/slash-command';
import type { Context } from '../core/context.js';
import { FOREIGN_SKILL_TOOLS, securityScoreToTier } from '../skills/foreign-sources.js';
import type { SkillRegistryAdapter } from '../skills/registry/registry-adapter.js';
import { SkillInstaller } from '../skills/skill-installer.js';
import { color } from '../utils/color.js';
import { toErrorMessage } from '../utils/error.js';
import { resolveWstackPaths } from '../utils/wstack-paths.js';
import { parseFlagValue } from './skills-plugin-authoring.js';

function makeInstaller(
  skillLoader: SkillLoader | undefined,
  projectRoot: string,
  registryAdapters?: SkillRegistryAdapter[],
): SkillInstaller {
  const paths = resolveWstackPaths({ projectRoot });
  return new SkillInstaller({
    manifestPath: path.join(paths.configDir, 'installed-skills.json'),
    projectSkillsDir: paths.inProjectSkills,
    globalSkillsDir: paths.globalSkills,
    projectHash: paths.projectHash,
    skillLoader,
    ...(registryAdapters ? { registryAdapters } : {}),
  });
}

export function buildSkillSearchCommand(
  _skillLoader: SkillLoader | undefined,
  registryAdapters: SkillRegistryAdapter[],
): SlashCommand {
  return {
    name: 'skill-search',
    description: 'Search the skill registry (skills.sh) for installable skills.',
    argsHint: '<query> [--page N] [--pageSize N]',
    help: [
      '╔═══ Skill Search ═══╗',
      '',
      'Search the skill registry for installable skills.',
      'Results show name, author, installs, security score, and the install ref.',
      '',
      'Usage:',
      '  /skill-search react                 Search for "react" skills',
      '  /skill-search "code review" --page 2  Second page of results',
      '',
      `Registries: ${registryAdapters.map((a) => a.id).join(', ')}.`,
      'To install a hit: /skill-install <owner/repo> (or the full install ref shown).',
    ].join('\n'),
    async run(args: string) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const queryParts = parts.filter(
        (part, index) =>
          !part.startsWith('--') && !['--page', '--pageSize'].includes(parts[index - 1] ?? ''),
      );
      const query = queryParts
        .join(' ')
        .trim()
        .replace(/^(["'])([\s\S]*)\1$/, '$2');
      if (!query) return { message: 'Usage: /skill-search <query> [--page N]' };
      const page = parseFlagValue(parts, '--page');
      const pageSize = parseFlagValue(parts, '--pageSize');

      // Use a throwaway installer just to fan out across adapters (search()
      // doesn't touch the manifest or filesystem).
      const tmpInstaller = new SkillInstaller({
        manifestPath: ':memory:', // never written — search() is read-only
        projectSkillsDir: '/dev/null',
        globalSkillsDir: '/dev/null',
        projectHash: 'search',
        registryAdapters,
      });
      try {
        const perAdapter = await tmpInstaller.search(query, {
          ...(page ? { page: Number(page) } : {}),
          ...(pageSize ? { pageSize: Number(pageSize) } : {}),
        });
        const total = perAdapter.reduce((n, b) => n + b.results.length, 0);
        if (total === 0) {
          return {
            message: `No skills found for "${query}" in ${registryAdapters.map((a) => a.id).join(', ')}.`,
          };
        }
        const lines: string[] = [`Found ${total} skill(s) for "${query}":`];
        for (const block of perAdapter) {
          if (block.results.length === 0) continue;
          lines.push(`\n${color.bold(block.adapterId)}:`);
          for (const r of block.results) {
            const tier = r.securityScore != null ? securityScoreToTier(r.securityScore) : undefined;
            const scoreMark =
              tier === 'low'
                ? ` ⚠${r.securityScore}`
                : r.securityScore != null
                  ? ` ✓${r.securityScore}`
                  : '';
            const installs = r.installs != null ? ` · ${formatCount(r.installs)} installs` : '';
            const author = r.author ? ` ${color.dim(r.author)}` : '';
            lines.push(`  ${color.bold(r.name)}${author}${scoreMark}${installs}`);
            if (r.description) lines.push(`    ${truncate(r.description, 90)}`);
            lines.push(`    ${color.dim('→ /skill-install ' + r.installRef)}`);
          }
        }
        return { message: lines.join('\n') };
      } catch (err) {
        return { message: `✗ Search failed: ${toErrorMessage(err)}` };
      }
    },
  };
}

export function buildSkillInstallCommand(
  skillLoader?: SkillLoader,
  registryAdapters?: SkillRegistryAdapter[],
): SlashCommand {
  return {
    name: 'skill-install',
    description: 'Install skills from a GitHub repository or a registry hit (skills.sh:<id>).',
    argsHint: '<user/repo[@ref] | skills.sh:<owner/repo> | registry:<id>> [--global]',
    help: [
      '╔═══ Skill Install ═══╗',
      '',
      'Install skills from GitHub (direct) or a registry (resolved to GitHub).',
      '',
      'Usage:',
      '  /skill-install <user/repo>              Install from default branch (main)',
      '  /skill-install <user/repo@ref>          Install specific tag/branch/commit',
      '  /skill-install <user/repo> --global     Install to user-global skills',
      '  /skill-install skills.sh:<owner/repo>   Resolve a skills.sh hit and install',
      '',
      'Supports single-skill repos (SKILL.md at root) and multi-skill repos (skills/).',
      'Use /skill-search to find skills, then install with the shown install ref.',
      '',
      'Private repos: set GITHUB_TOKEN (or GH_TOKEN) in your environment.',
    ].join('\n'),
    async run(args: string, ctx: Context) {
      const parts = args.trim().split(/\s+/);
      const ref = parts.find((p) => !p.startsWith('--'));
      const isGlobal = parts.includes('--global');

      if (!ref) {
        return {
          message:
            'Usage: /skill-install <user/repo[@ref] | skills.sh:<owner/repo>> [--global]\nUse /skill-search to find skills.',
        };
      }

      const installer = makeInstaller(skillLoader, ctx.projectRoot, registryAdapters);

      try {
        const results = await installer.install(ref, { global: isGlobal });
        if (results.length === 0) return { message: 'No skills found in the repository.' };

        const scope = isGlobal ? 'user-global' : 'project';
        const lines = [`Installed ${results.length} skill(s) [${scope}]:`];
        for (const r of results) {
          lines.push(`  ✓ ${r.name} (${r.source}@${r.ref})`);
          lines.push(`    → ${r.path}`);
        }
        return { message: lines.join('\n') };
      } catch (err) {
        const msg = toErrorMessage(err);
        return { message: `✗ Install failed: ${msg}` };
      }
    },
  };
}

/** Importable tool sources: Claude plus the other foreign agents. */
const IMPORT_SOURCE_TOOLS: ReadonlyArray<{ id: string; subdir: string }> = [
  { id: 'claude', subdir: 'skills' },
  ...FOREIGN_SKILL_TOOLS,
];

/**
 * Resolve a `--from <tool>` source directory for `/skill-import`. Returns the
 * project-level dir (`<project>/.<tool>/<subdir>`) or user-level (`~/.<tool>/<subdir>`
 * when `global`), or `undefined` for an unknown tool id. Exported for testing.
 */
export function resolveImportSourceDir(
  tool: string,
  opts: { global: boolean; projectRoot: string; homeDir?: string },
): string | undefined {
  const entry = IMPORT_SOURCE_TOOLS.find((t) => t.id === tool);
  if (!entry) return undefined;
  const base = opts.global ? (opts.homeDir ?? os.homedir()) : opts.projectRoot;
  return path.join(base, '.' + entry.id, entry.subdir);
}

export function buildSkillImportCommand(skillLoader?: SkillLoader): SlashCommand {
  return {
    name: 'skill-import',
    description: 'Import skills from a local directory or another agent into .wrongstack/skills.',
    argsHint: '[<src-dir> | --from <tool> | --from-claude] [--global] [--link]',
    help: [
      '╔═══ Skill Import ═══╗',
      '',
      'Copy (or symlink) skills into .wrongstack/skills so you can edit and commit',
      'them. Foreign skills are already readable without importing — this takes ownership.',
      '',
      'Usage:',
      '  /skill-import --from cursor              Import project .cursor/skills',
      '  /skill-import --from codex --global      Import ~/.codex/skills',
      '  /skill-import --from claude              Import project .claude/skills (--from-claude alias)',
      '  /skill-import /path/to/skills            Import from any directory',
      '  /skill-import --from trae --link         Symlink instead of copy',
      '',
      `Known tools: ${IMPORT_SOURCE_TOOLS.map((t) => t.id).join(', ')}.`,
      'Each subdirectory with a valid SKILL.md is imported.',
    ].join('\n'),
    async run(args: string, ctx: Context) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const isGlobal = parts.includes('--global');
      const link = parts.includes('--link');
      const fromIdx = parts.indexOf('--from');
      let tool: string | undefined;
      if (fromIdx !== -1) tool = parts[fromIdx + 1];
      else if (parts.includes('--from-claude')) tool = 'claude';
      const positional = parts.find((p) => !p.startsWith('--') && p !== tool);

      let srcDir: string | undefined;
      if (tool) {
        srcDir = resolveImportSourceDir(tool, { global: isGlobal, projectRoot: ctx.projectRoot });
        if (!srcDir) {
          return {
            message: `Unknown tool "${tool}". Known: ${IMPORT_SOURCE_TOOLS.map((t) => t.id).join(', ')}`,
          };
        }
      } else if (positional) {
        srcDir = path.resolve(ctx.projectRoot, positional);
      } else {
        return {
          message:
            'Usage: /skill-import <src-dir> | --from <tool> | --from-claude [--global] [--link]',
        };
      }

      const installer = makeInstaller(skillLoader, ctx.projectRoot);
      try {
        const results = await installer.importFromDir(srcDir, { global: isGlobal, link });
        if (results.length === 0) {
          return { message: `No valid skills found in ${srcDir}.` };
        }
        const scope = isGlobal ? 'user-global' : 'project';
        const lines = [
          `Imported ${results.length} skill(s) [${scope}]${link ? ' (symlinked)' : ''}:`,
        ];
        for (const r of results) {
          lines.push(`  ✓ ${r.name}`);
          lines.push(`    → ${r.path}`);
        }
        return { message: lines.join('\n') };
      } catch (err) {
        return { message: `✗ Import failed: ${toErrorMessage(err)}` };
      }
    },
  };
}

export function buildSkillUpdateCommand(
  skillLoader?: SkillLoader,
  registryAdapters?: SkillRegistryAdapter[],
): SlashCommand {
  return {
    name: 'skill-update',
    description: 'Update installed skills from their GitHub source.',
    argsHint: '[name|ref] [--global]',
    help: [
      '╔═══ Skill Update ═══╗',
      '',
      'Update installed skills from their GitHub source.',
      '',
      'Usage:',
      '  /skill-update                  Update all installed skills',
      '  /skill-update <name>           Update a specific skill',
      '  /skill-update <user/repo@ref>  Update to a different ref',
      '  /skill-update <name> --global  Update a global skill',
    ].join('\n'),
    async run(args: string, ctx: Context) {
      const parts = args.trim().split(/\s+/);
      const nameOrRef = parts.find((p) => !p.startsWith('--'));
      const isGlobal = parts.includes('--global');

      const installer = makeInstaller(skillLoader, ctx.projectRoot, registryAdapters);

      try {
        const result = await installer.update(nameOrRef, { global: isGlobal });
        const lines: string[] = [];

        if (result.updated.length > 0) {
          lines.push(`Updated ${result.updated.length} skill(s):`);
          for (const u of result.updated) {
            lines.push(
              u.oldRef !== u.newRef
                ? `  ✓ ${u.name} (${u.oldRef} → ${u.newRef})`
                : `  ✓ ${u.name} (refreshed)`,
            );
          }
        }
        if (result.unchanged.length > 0) lines.push(`Up to date: ${result.unchanged.join(', ')}`);
        if (result.errors.length > 0) {
          for (const e of result.errors) lines.push(`  ✗ ${e.name}: ${e.error}`);
        }
        if (lines.length === 0) return { message: 'No installed skills to update.' };

        return { message: lines.join('\n') };
      } catch (err) {
        const msg = toErrorMessage(err);
        return { message: `✗ Update failed: ${msg}` };
      }
    },
  };
}

export function buildSkillUninstallCommand(skillLoader?: SkillLoader): SlashCommand {
  return {
    name: 'skill-uninstall',
    description: 'Remove an installed skill.',
    argsHint: '<name> [--global]',
    help: [
      '╔═══ Skill Uninstall ═══╗',
      '',
      'Remove an installed skill and its files.',
      '',
      'Usage:',
      '  /skill-uninstall <name>             Remove from project skills',
      '  /skill-uninstall <name> --global    Remove from user-global skills',
    ].join('\n'),
    async run(args: string, ctx: Context) {
      const parts = args.trim().split(/\s+/);
      const name = parts.find((p) => !p.startsWith('--'));
      const isGlobal = parts.includes('--global');

      if (!name) {
        // List installed skills when no name given
        const installer = makeInstaller(skillLoader, ctx.projectRoot);
        const installed = await installer.listInstalled();
        if (installed.length === 0) return { message: 'No installed skills found.' };
        const scope = isGlobal ? 'user' : 'project';
        const filtered = installed.filter((s) => s.scope === scope);
        if (filtered.length === 0) {
          return { message: `No installed skills found (${scope} scope).` };
        }
        const lines = [`Installed skills (${scope}):`];
        for (const s of filtered) {
          lines.push(`  ${s.name}  ${s.source}@${s.ref}  (${s.installedAt.slice(0, 10)})`);
        }
        lines.push('', 'Use /skill-uninstall <name> to remove.');
        return { message: lines.join('\n') };
      }

      const installer = makeInstaller(skillLoader, ctx.projectRoot);

      try {
        await installer.uninstall(name, { global: isGlobal });
        return { message: `✓ Skill "${name}" uninstalled.` };
      } catch (err) {
        const msg = toErrorMessage(err);
        return { message: `✗ Uninstall failed: ${msg}` };
      }
    },
  };
}

// ── Formatting helpers ────────────────────────────────────────────────────

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
