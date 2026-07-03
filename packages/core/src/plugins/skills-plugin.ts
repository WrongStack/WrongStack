import * as os from 'node:os';
import * as path from 'node:path';
import type { Context, SlashCommand } from '../index.js';
import { FOREIGN_SKILL_TOOLS, securityScoreToTier } from '../skills/foreign-sources.js';
import { githubDirectAdapter } from '../skills/registry/github-direct-adapter.js';
import type { SkillRegistryAdapter } from '../skills/registry/registry-adapter.js';
import {
  createSkillsShAdapter,
  DEFAULT_SKILLS_SH_URL,
} from '../skills/registry/skills-sh-adapter.js';
import {
  bodyLineAdvisory,
  extractSkillFromPrompt,
  generateSkillSkeleton,
  openInEditor,
  validateSkillNameAvailable,
  writeSkeletonSkill,
} from '../skills/skill-generator.js';
import { SkillInstaller } from '../skills/skill-installer.js';
import type { Plugin } from '../types/plugin.js';
import type { SkillLoader } from '../types/skill.js';
import { color } from '../utils/color.js';
import { toErrorMessage } from '../utils/error.js';
import { resolveWstackPaths } from '../utils/wstack-paths.js';

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

function makeInstaller(
  skillLoader: SkillLoader | undefined,
  projectRoot: string,
  registryAdapters?: SkillRegistryAdapter[],
): SkillInstaller {
  const paths = resolveWstackPaths({ projectRoot });
  return new SkillInstaller({
    manifestPath: path.join(paths.globalRoot, 'installed-skills.json'),
    projectSkillsDir: paths.inProjectSkills,
    globalSkillsDir: paths.globalSkills,
    projectHash: paths.projectHash,
    skillLoader,
    ...(registryAdapters ? { registryAdapters } : {}),
  });
}

export function buildSkillCommand(skillLoader?: SkillLoader): SlashCommand {
  return {
    name: 'skill',
    description:
      'Show skill details or list available skills. Use /skill-gen to create new skills.',
    async run(args: string) {
      if (!skillLoader) return { message: 'No skill loader configured.' };
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
      return { message: await skillLoader.readBody(skill.name) };
    },
  };
}

export function buildSkillGeneratorCommand(skillLoader?: SkillLoader): SlashCommand {
  return {
    name: 'skill-gen',
    description:
      'Create or validate skills. /skill-gen (wizard) | validate <name> | skeleton <name> | from-prompt <text> | view <name> | edit <name> | list',
    help: [
      '╔═══ Skill Generator ═══╗',
      '',
      'Create and validate AI skills.',
      '',
      'Usage:',
      '  /skill-gen                        Start the interactive AI-guided wizard',
      '  /skill-gen list                   List existing skills (with source)',
      '  /skill-gen validate <name>        Validate a skill name (format + collisions)',
      '  /skill-gen skeleton <name>        Generate a SKILL.md skeleton to draft',
      '         [--desc "..."] [--trigger a,b,c] [--global] [--force]',
      '  /skill-gen from-prompt <text>     Turn a prompt into a skill draft',
      '         [--global] [--force]',
      "  /skill-gen view <name>            Show a skill's body (read-only)",
      '  /skill-gen edit <name>            Open a skill in $EDITOR/$VISUAL',
      '',
      'Skeletons are written to .wrongstack/skills/<name>/SKILL.md (--global: ~/.wrongstack/skills/).',
      'The interactive wizard reads the bundled `skill-creator` skill and guides you step by step.',
    ].join('\n'),
    async run(args: string, ctx: Context) {
      const trimmed = args.trim();
      const [sub, ...rest] = trimmed.split(/\s+/);

      // ── list ────────────────────────────────────────────────────────────
      if (sub === 'list' || sub === 'ls') {
        if (!skillLoader) return { message: 'No skill loader configured.' };
        const entries = await skillLoader.listEntries();
        if (entries.length === 0) return { message: 'No skills found.' };
        const lines = entries.map((e) => {
          const src =
            e.source === 'project'
              ? '📁'
              : e.source === 'user'
                ? '👤'
                : e.source === 'claude-project' || e.source === 'claude-user'
                  ? '🌐'
                  : e.source === 'foreign'
                    ? `🌐(${e.originTool ?? '?'})`
                    : e.source === 'extra'
                      ? '➕'
                      : '📦';
          return `  ${src} ${e.name}\n     ${e.trigger}`;
        });
        return { message: `Available Skills:\n${lines.join('\n\n')}\n` };
      }

      // ── validate <name> ─────────────────────────────────────────────────
      if (sub === 'validate') {
        const name = rest[0];
        if (!name) return { message: 'Usage: /skill-gen validate <name>' };
        const result = await validateSkillNameAvailable(name, skillLoader);
        const lines: string[] = [`Validating "${name}":`];
        if (result.formatViolations.length > 0) {
          lines.push(`  ✗ Format issues:`);
          for (const v of result.formatViolations) lines.push(`    - ${v}`);
        } else {
          lines.push(`  ✓ Format: valid kebab-case`);
        }
        if (result.conflicts.length > 0) {
          const sameLayer = result.conflicts.filter(
            (c) => c.source === 'project' || c.source === 'user',
          );
          const shadowing = result.conflicts.filter(
            (c) => c.source !== 'project' && c.source !== 'user',
          );
          if (sameLayer.length > 0) {
            lines.push(`  ✗ Collisions (same layer — would overwrite):`);
            for (const c of sameLayer) lines.push(`    - ${c.name} (${c.source})`);
          }
          if (shadowing.length > 0) {
            lines.push(`  ⚠ Shadows lower-priority skills (intentional override):`);
            for (const c of shadowing) lines.push(`    - ${c.name} (${c.source})`);
          }
        } else {
          lines.push(`  ✓ No collisions`);
        }
        lines.push(result.ok ? `  → Ready to use.` : `  → Fix the issues above first.`);
        return { message: lines.join('\n') };
      }

      // ── skeleton <name> [--desc ...] [--trigger a,b] [--global] [--force]
      if (sub === 'skeleton') {
        return runSkeleton(rest, ctx, skillLoader);
      }

      // ── from-prompt <text> [--global] [--force] ─────────────────────────
      if (sub === 'from-prompt') {
        return runFromPrompt(rest, ctx, skillLoader);
      }

      // ── view <name> ─────────────────────────────────────────────────────
      if (sub === 'view') {
        const skillName = rest[0];
        if (!skillName) return { message: 'Usage: /skill-gen view <name>' };
        if (!skillLoader) return { message: 'No skill loader configured.' };
        const skill = await skillLoader.find(skillName);
        if (!skill) return { message: `Skill "${skillName}" not found.` };
        const body = await skillLoader.readBody(skillName);
        return { message: [`Skill: ${skillName}`, `Path: ${skill.path}`, '', body].join('\n') };
      }

      // ── edit <name> ─────────────────────────────────────────────────────
      if (sub === 'edit') {
        const skillName = rest[0];
        if (!skillName) return { message: 'Usage: /skill-gen edit <name>' };
        if (!skillLoader) return { message: 'No skill loader configured.' };
        const skill = await skillLoader.find(skillName);
        if (!skill) return { message: `Skill "${skillName}" not found.` };
        try {
          await openInEditor(skill.path);
          return { message: `Opening ${skill.path} in your editor…` };
        } catch (err) {
          return { message: `✗ ${toErrorMessage(err)}` };
        }
      }

      // ── default: interactive wizard (legacy `edit <name>` kept as alias) ─
      // Accept `/skill-gen edit <name>` as a legacy alias for `view` only when
      // someone passes it without the new semantics — but we already handled
      // `edit` above, so this only fires for bare `/skill-gen` or unknown args.
      if (trimmed.startsWith('edit ')) {
        // Back-compat: old `edit <name>` meant "view". Re-route to view.
        return buildSkillGeneratorCommand(skillLoader).run(`view ${rest.join(' ')}`, ctx);
      }

      // AI-guided creation: return runText so the AI reads the skill-creator
      // skill and walks the user through it.
      return {
        message:
          '╔═══ Skill Generator ═══╗\n\nThe AI will guide you through creating a new skill.\nAnswer its questions naturally. (Or use /skill-gen skeleton <name> for a quick scaffold.)',
        runText:
          'I want to create a new AI skill. Read the skill-creator skill and guide me through the process. Ask me questions one at a time — name, description, what to cover — then create the SKILL.md file. After writing it, run /skill-gen validate <name> to confirm.',
      };
    },
  };
}

/** Parse and run the `skeleton` sub-command. */
async function runSkeleton(
  rest: string[],
  ctx: Context,
  skillLoader?: SkillLoader,
): Promise<{ message: string }> {
  const name = rest.find((p) => !p.startsWith('--'));
  if (!name) {
    return {
      message:
        'Usage: /skill-gen skeleton <name> [--desc "..."] [--trigger a,b,c] [--global] [--force]',
    };
  }
  const desc = parseFlagValue(rest, '--desc');
  const triggers = parseFlagValue(rest, '--trigger')
    ?.split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const isGlobal = rest.includes('--global');
  const force = rest.includes('--force');

  // Validate before writing.
  const validation = await validateSkillNameAvailable(name, skillLoader);
  if (!validation.ok) {
    const issues = [...validation.formatViolations];
    for (const c of validation.conflicts) {
      if (c.source === 'project' || c.source === 'user') {
        issues.push(
          `collides with existing ${c.source} skill "${c.name}" (use --force to overwrite)`,
        );
      }
    }
    return { message: `✗ Cannot scaffold "${name}":\n  - ${issues.join('\n  - ')}` };
  }

  const body = generateSkillSkeleton({ name, description: desc ?? '', triggerKeywords: triggers });
  const paths = resolveWstackPaths({ projectRoot: ctx.projectRoot });
  const skillsDir = isGlobal ? paths.globalSkills : paths.inProjectSkills;
  try {
    const written = await writeSkeletonSkill(skillsDir, body, { overwrite: force });
    const advisory = bodyLineAdvisory(body);
    return {
      message: [
        `✓ Scaffolded ${name} → ${written}`,
        advisory.over ? `  ⚠ Body is ${advisory.lines} lines (skill-creator recommends ≤500).` : '',
        `  Next: edit the body, then /skill-gen validate ${name}.`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  } catch (err) {
    return { message: `✗ ${toErrorMessage(err)}` };
  }
}

/** Parse and run the `from-prompt` sub-command. */
async function runFromPrompt(
  rest: string[],
  ctx: Context,
  skillLoader?: SkillLoader,
): Promise<{ message: string }> {
  // Everything that isn't a flag is the prompt text.
  const promptText = rest
    .filter((p) => !p.startsWith('--'))
    .join(' ')
    .trim();
  if (!promptText) {
    return { message: 'Usage: /skill-gen from-prompt <text> [--global] [--force]' };
  }
  const isGlobal = rest.includes('--global');
  const force = rest.includes('--force');

  const draft = extractSkillFromPrompt(promptText);
  if (!draft.suggestedName) {
    return { message: '✗ Could not derive a skill name from the prompt. Provide a # heading.' };
  }
  // Validate the derived name (don't block on shadowing).
  const validation = await validateSkillNameAvailable(draft.suggestedName, skillLoader);
  if (!validation.ok) {
    return {
      message:
        `✗ Derived name "${draft.suggestedName}" has issues:\n  - ` +
        [
          ...validation.formatViolations,
          ...validation.conflicts.map((c) => `collides with ${c.name}`),
        ].join('\n  - '),
    };
  }

  const body = generateSkillSkeleton({
    name: draft.suggestedName,
    description: draft.description,
    triggerKeywords: draft.triggerKeywords,
  });
  // Splice the extracted body into the skeleton's Overview.
  const withBody = draft.body
    ? body.replace('## Overview\n', `## Overview\n\n${draft.body}\n`)
    : body;
  const paths = resolveWstackPaths({ projectRoot: ctx.projectRoot });
  const skillsDir = isGlobal ? paths.globalSkills : paths.inProjectSkills;
  try {
    const written = await writeSkeletonSkill(skillsDir, withBody, { overwrite: force });
    return {
      message:
        `✓ Drafted ${draft.suggestedName} from prompt → ${written}\n` +
        `  Triggers: ${draft.triggerKeywords.join(', ') || '(none detected)'}\n` +
        `  Next: review and edit the body, then /skill-gen validate ${draft.suggestedName}.`,
    };
  } catch (err) {
    return { message: `✗ ${toErrorMessage(err)}` };
  }
}

/** Extract the value following a `--flag` from a token list. */
function parseFlagValue(tokens: string[], flag: string): string | undefined {
  const idx = tokens.indexOf(flag);
  if (idx === -1) return undefined;
  const next = tokens[idx + 1];
  return next && !next.startsWith('--') ? next : undefined;
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
      const query = parts
        .filter((p) => !p.startsWith('--'))
        .join(' ')
        .trim();
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
