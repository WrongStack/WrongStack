/** `/skill-gen` — the skill authoring command (wizard, validate, skeleton, from-prompt, view, edit). */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SkillLoader } from '@wrongstack/contracts/types/skill';
import type { SlashCommand } from '@wrongstack/contracts/types/slash-command';
import type { Context } from '../core/context.js';
import { validateSkillDocument, validateSkillName } from '../skills/frontmatter.js';
import {
  bodyLineAdvisory,
  extractSkillFromPrompt,
  generateSkillSkeleton,
  openInEditor,
  validateSkillNameAvailable,
  writeSkeletonSkill,
} from '../skills/skill-generator.js';
import { color } from '../utils/color.js';
import { toErrorMessage } from '../utils/error.js';
import { resolveWstackPaths } from '../utils/wstack-paths.js';

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
      '  /skill-gen validate <name>        Validate an existing skill file, or check a proposed name',
      '  /skill-gen skeleton <name>        Generate a SKILL.md skeleton to draft',
      '         [--desc "..."] [--trigger a,b,c] [--global] [--force]',
      '  /skill-gen from-prompt <text>     Turn a prompt into a skill draft',
      '         [--global] [--force]',
      "  /skill-gen view <name>            Show a skill's body (read-only)",
      '  /skill-gen edit <name>            Open a skill in $EDITOR/$VISUAL',
      '',
      'Skeletons are written to .wrongstack/skills/<name>/SKILL.md (--global: active profile/skills/).',
      'The interactive wizard reads the bundled `skill-creator` skill and guides you step by step.',
    ].join('\n'),
    async run(args: string, ctx: Context) {
      const trimmed = args.trim();
      const [sub, ...rest] = tokenizeSkillArgs(trimmed);

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
        let message = `Available Skills:\n${lines.join('\n\n')}\n`;
        // Surface load-time diagnostics, but only when non-empty so normal
        // output is unchanged. Feature-detected: mock loaders may omit it.
        const diag = skillLoader.diagnostics?.();
        if (diag && (diag.shadowed.length > 0 || diag.skipped.length > 0)) {
          const notes: string[] = [];
          if (diag.shadowed.length > 0) {
            notes.push(color.dim('Shadowed (hidden by a higher-priority layer):'));
            for (const s of diag.shadowed) {
              notes.push(color.dim(`  ⚠ ${s.name} (${s.source}) ← overridden by ${s.shadowedBy}`));
            }
          }
          if (diag.skipped.length > 0) {
            notes.push(color.dim('Skipped (malformed SKILL.md):'));
            for (const k of diag.skipped) {
              const name = k.name ? ` "${k.name}"` : '';
              notes.push(color.dim(`  ✗ ${k.entry}${name} — ${k.reason}`));
            }
          }
          message += `\n${notes.join('\n')}\n`;
        }
        return { message };
      }

      // ── validate <name> ─────────────────────────────────────────────────
      if (sub === 'validate') {
        const name = rest[0];
        if (!name) return { message: 'Usage: /skill-gen validate <name>' };
        skillLoader?.invalidateCache();
        const manifest = await skillLoader?.find(name);
        const nativePath = path.join(
          ctx?.projectRoot ?? process.cwd(),
          '.wrongstack',
          'skills',
          name,
          'SKILL.md',
        );
        if (validateSkillName(name).length === 0) {
          const file = manifest?.path ?? nativePath;
          const raw = await fs.readFile(file, 'utf8').catch(() => undefined);
          if (raw !== undefined) {
            const violations = validateSkillDocument(raw, path.basename(path.dirname(file)));
            return {
              message: violations.length
                ? `Invalid skill "${name}":\n${violations.map((v) => `  - ${v}`).join('\n')}`
                : `✓ Skill "${name}" is valid.`,
            };
          }
        }
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
        return runFromPrompt(trimmed.slice('from-prompt'.length).trim(), ctx, skillLoader);
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
          // The editor is detached (it outlives this process), so we can't know
          // when the user saves. Invalidate now so the next read in this process
          // re-reads from disk instead of serving the pre-edit cached body —
          // mirroring the WebUI edit handler, which invalidates on save.
          skillLoader.invalidateCache();
          return {
            message: `Opening ${skill.path} in your editor… (skill cache cleared — changes load on next use)`,
          };
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
  if (validation.formatViolations.length > 0) {
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
    skillLoader?.invalidateCache();
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
  rawPrompt: string,
  ctx: Context,
  skillLoader?: SkillLoader,
): Promise<{ message: string }> {
  const isGlobal = /(?:^|\s)--global(?=\s|$)/.test(rawPrompt);
  const force = /(?:^|\s)--force(?=\s|$)/.test(rawPrompt);
  let promptText = rawPrompt.replace(/(?:^|[ \t])--(?:global|force)(?=\s|$)/g, '').trim();
  if (
    (promptText.startsWith('"') && promptText.endsWith('"')) ||
    (promptText.startsWith("'") && promptText.endsWith("'"))
  )
    promptText = promptText.slice(1, -1);
  if (!promptText) return { message: 'Usage: /skill-gen from-prompt <text> [--global] [--force]' };
  const draft = extractSkillFromPrompt(promptText);
  if (!draft.suggestedName) {
    return { message: '✗ Could not derive a skill name from the prompt. Provide a # heading.' };
  }
  // Validate the derived name (don't block on shadowing).
  const validation = await validateSkillNameAvailable(draft.suggestedName, skillLoader);
  if (validation.formatViolations.length > 0) {
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
    skillLoader?.invalidateCache();
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
function tokenizeSkillArgs(input: string): string[] {
  return (input.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? []).map((token) => {
    if (token.startsWith('"') && token.endsWith('"')) {
      return token.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    return token.startsWith("'") && token.endsWith("'") ? token.slice(1, -1) : token;
  });
}

export function parseFlagValue(tokens: string[], flag: string): string | undefined {
  const idx = tokens.indexOf(flag);
  if (idx === -1) return undefined;
  const next = tokens[idx + 1];
  return next && !next.startsWith('--') ? next : undefined;
}
