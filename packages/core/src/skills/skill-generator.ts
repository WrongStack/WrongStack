/**
 * Skill authoring helpers — deterministic (no LLM) utilities that power the
 * `/skill-gen` sub-commands: validate, skeleton, from-prompt, edit.
 *
 * These are pure functions over the skill loader + filesystem so they're trivial
 * to test and don't need a running agent. The interactive `/skill-gen` wizard
 * (default, no sub-command) still delegates to the `skill-creator` skill via
 * `runText` — that's the right call for the open-ended "help me write one"
 * flow. These utilities cover the deterministic parts: name/format checks,
 * scaffold generation, prompt→skill extraction, and opening in `$EDITOR`.
 *
 * Distinct from `security-scanner/skill-generator.ts`, which deterministically
 * generates a *security-scanning* skill from a tech stack — that one builds a
 * specific skill from a fixed pattern library; this one is the general-purpose
 * authoring toolkit.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ERROR_CODES, WrongStackError } from '../types/errors.js';
import type { SkillEntry, SkillLoader } from '../types/skill.js';
import { buildWin32CmdShimInvocation } from '../utils/win32-cmd.js';
import { isValidSkillNameFormat, parseSkillFrontmatter, validateSkillName } from './frontmatter.js';
import { SKILL_LIMITS } from './limits.js';

/** Result of validating a proposed skill name. */
export interface SkillNameValidation {
  /** Whether the name is valid kebab-case AND free of collisions. */
  ok: boolean;
  /** Format violations (empty when the name is valid kebab-case). */
  formatViolations: string[];
  /** Existing skills with the same name (empty when there's no collision). */
  conflicts: SkillEntry[];
}

/**
 * Validate a proposed skill name: format (kebab-case, ≤64 chars) plus collision
 * check against every skill the loader can see (project, user, foreign,
 * bundled). A collision isn't fatal — project skills intentionally shadow
 * lower layers — so `ok` is true when the only collision is with a foreign or
 * bundled skill (intended shadowing), but `conflicts` is still populated so the
 * user can decide. A collision with another project or user skill of the same
 * name does fail (`ok: false`), since that would silently overwrite it.
 */
export async function validateSkillNameAvailable(
  name: string,
  loader?: SkillLoader,
): Promise<SkillNameValidation> {
  const formatViolations = validateSkillName(name);
  const conflicts = loader ? (await loader.listEntries()).filter((e) => e.name === name) : [];
  const formatOk = formatViolations.length === 0;
  // A collision with a same-or-higher priority layer (project↔project, user↔user)
  // is a real conflict. Collisions with foreign/bundled skills are intended
  // shadowing (project skills win by priority) and don't fail validation.
  const collisionBlocks = conflicts.some((c) => c.source === 'project' || c.source === 'user');
  return {
    ok: formatOk && !collisionBlocks,
    formatViolations,
    conflicts,
  };
}

export interface SkillSkeletonOptions {
  name: string;
  description: string;
  /** Trigger keywords for the `Triggers:` line. */
  triggerKeywords?: string[] | undefined;
  /** Optional version (default `1.0.0`). */
  version?: string | undefined;
}

/**
 * Generate a SKILL.md body (with frontmatter) following the agentskills.io
 * format and the `skill-creator` skill's recommended skeleton. Deterministic:
 * the same inputs always produce the same output, and the result round-trips
 * through `parseSkillFrontmatter` (so what we write is what the loader reads).
 *
 * The body is a skeleton — the user fills in Rules/Patterns/etc. The
 * `skill-creator` skill is the right tool for the open-ended authoring; this
 * is the scaffold.
 */
export function generateSkillSkeleton(opts: SkillSkeletonOptions): string {
  const name = opts.name.trim();
  if (!isValidSkillNameFormat(name)) {
    throw new WrongStackError({
      message: `Cannot generate skeleton: invalid skill name "${name}". Names must be kebab-case (a-z0-9 and hyphens), ≤64 chars.`,
      code: ERROR_CODES.VALIDATION_ERROR,
      subsystem: 'general',
      context: { name },
    });
  }
  const description = opts.description.trim();
  const triggers = (opts.triggerKeywords ?? [])
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => `"${k}"`)
    .join(', ');
  const triggerLine = triggers ? `\n  Triggers: user says ${triggers}.` : '';
  const version = opts.version?.trim() || '1.0.0';
  const title = name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  return `---
name: ${name}
description: |
  ${description || `Use this skill when <trigger situation>.`}${triggerLine}
version: ${version}
---

# ${title}

## Overview

${description || 'One-line description of what this skill does.'}

## Rules

1. Rule one
2. Rule two

## Patterns

### Do

\`\`\`ts
// good example
\`\`\`

### Don't

\`\`\`ts
// bad example
\`\`\`

## Skills in scope

- \`other-skill\` — for delegation when this skill needs help
`;
}

/** Result of extracting a skill draft from a free-form prompt. */
export interface ExtractedSkillDraft {
  /** Suggested name (kebab-case) derived from the prompt, or empty. */
  suggestedName: string;
  /** Description (first paragraph of the prompt). */
  description: string;
  /** Remaining prompt text, used as the skill body. */
  body: string;
  /** Trigger keywords extracted from the prompt. */
  triggerKeywords: string[];
}

/**
 * Heuristically extract a skill draft from a free-form prompt. No LLM — just
 * light structure detection:
 *   - First non-empty paragraph → `description`.
 *   - A `# heading` or the first line → suggested kebab-case `suggestedName`.
 *   - Remaining text → `body`.
 *   - Quoted tokens and the heading words → `triggerKeywords`.
 *
 * The output is a starting point the user (or the skill-creator wizard) refines.
 */
export function extractSkillFromPrompt(prompt: string): ExtractedSkillDraft {
  const text = prompt.trim();
  if (!text) {
    return { suggestedName: '', description: '', body: '', triggerKeywords: [] };
  }

  // Detect a markdown heading as the title; fall back to the first line.
  const headingMatch = text.match(/^#{1,6}\s+(.+?)\s*$/m);
  const firstLine =
    text
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? text;
  const titleSource = headingMatch?.[1] ?? firstLine.replace(/^#+\s*/, '');
  const suggestedName = toKebab(titleSource).slice(0, SKILL_LIMITS.SKILL_NAME_MAX_LEN);

  // Split into paragraphs (blocks separated by blank lines).
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const description = paragraphs[0]?.replace(/^#{1,6}\s+/m, '').trim() ?? titleSource;
  const body = paragraphs.slice(1).join('\n\n');

  // Trigger keywords: quoted tokens ("..."), plus a few significant words from
  // the title (lowercased, >3 chars, not stopwords).
  const quoted = [...text.matchAll(/"([^"]{2,40})"/g)]
    .map((m) => m[1])
    .filter((q): q is string => typeof q === 'string')
    .map((q) => q.toLowerCase());
  const titleWords = titleSource
    .split(/\W+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
  const triggerKeywords = dedupe([...quoted, ...titleWords]).slice(0, 8);

  return { suggestedName, description, body, triggerKeywords };
}

/**
 * Open a file in the user's editor (`$VISUAL` → `$EDITOR` → platform default).
 * Detached + unref'd so the editor outlives the WrongStack process. Throws a
 * `WrongStackError` when no editor can be resolved.
 */
export async function openInEditor(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const editor =
    (env['VISUAL']?.trim() && env['VISUAL']) ||
    (env['EDITOR']?.trim() && env['EDITOR']) ||
    defaultEditor();
  if (!editor) {
    throw new WrongStackError({
      message:
        'No editor found. Set the EDITOR or VISUAL environment variable ' +
        '(e.g. `export EDITOR=code` or `export EDITOR=vim`).',
      code: ERROR_CODES.VALIDATION_ERROR,
      subsystem: 'general',
      context: { filePath },
    });
  }
  const shell = process.platform === 'win32';
  // Split editor into command + args (e.g. `code --wait`). The file path is
  // appended last so it works whether the editor is a single binary or a
  // command-with-flags string.
  const parts = editor.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new WrongStackError({
      message: 'Resolved editor command is empty.',
      code: ERROR_CODES.VALIDATION_ERROR,
      subsystem: 'general',
      context: { filePath },
    });
  }
  const editorArgs = [...parts.slice(1), filePath];

  // On win32 an editor is usually a `.cmd` shim, which Node refuses to spawn
  // without a shell (CVE-2024-27980). `shell: true` used to supply that — but it
  // hands the whole line to cmd.exe, where `&` separates commands. `filePath`
  // derives from a skill DIRECTORY name, and `<projectRoot>/.wrongstack/skills`
  // is repo-committed, so an untrusted repo controlled that string: a directory
  // named `x&<payload>&` executed the payload here. Build an explicit quoted
  // `cmd /d /c call` line instead, which refuses metacharacters outright.
  const child = shell
    ? (() => {
        const inv = buildWin32CmdShimInvocation(parts[0] as string, editorArgs);
        return spawn(inv.command, inv.args, {
          stdio: 'ignore',
          detached: true,
          windowsVerbatimArguments: inv.windowsVerbatimArguments,
          // Suppresses the console flash the cmd.exe wrapper would otherwise
          // show before the editor appears. Repo convention — see
          // `core/tests/architecture/spawn-convention.test.ts`.
          windowsHide: true,
        });
      })()
    : spawn(parts[0] as string, editorArgs, {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
  child.unref();
}

/**
 * Write a skeleton skill to `<skillsDir>/<name>/SKILL.md`. Returns the written
 * path. Used by `/skill-gen skeleton` and `/skill-gen from-prompt`. Refuses to
 * overwrite an existing SKILL.md unless `overwrite` is set — a guard against
 * clobbering a hand-edited skill.
 */
export async function writeSkeletonSkill(
  skillsDir: string,
  body: string,
  opts: { overwrite?: boolean | undefined } = {},
): Promise<string> {
  // Parse the frontmatter to find the name (so the dir matches the skill name).
  const fm = parseSkillFrontmatter(body);
  const name = fm.name;
  if (!name || !isValidSkillNameFormat(name)) {
    throw new WrongStackError({
      message: 'Skeleton body has no valid `name` in its frontmatter.',
      code: ERROR_CODES.VALIDATION_ERROR,
      subsystem: 'general',
    });
  }
  const skillDir = path.join(skillsDir, name);
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (!opts.overwrite) {
    try {
      await fs.access(skillFile);
      throw new WrongStackError({
        message: `A skill already exists at ${skillFile}. Use --force to overwrite.`,
        code: ERROR_CODES.VALIDATION_ERROR,
        subsystem: 'general',
        context: { skillFile },
      });
    } catch (err) {
      // re-throw the WrongStackError from above; swallow ENOENT (file absent).
      if (err instanceof WrongStackError) throw err;
    }
  }
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(skillFile, body, 'utf8');
  return skillFile;
}

/** Soft length advisory for a SKILL.md body (the `skill-creator` 500-line rule). */
export function bodyLineAdvisory(body: string): { lines: number; over: boolean } {
  const lines = body.split('\n').length;
  return { lines, over: lines > SKILL_LIMITS.SKILL_BODY_LINE_LIMIT };
}

// ── Utilities ─────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'your',
  'have',
  'will',
  'are',
  'was',
  'were',
  'been',
  'into',
  'when',
  'use',
  'skill',
  'about',
]);

function toKebab(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SKILL_LIMITS.SKILL_NAME_MAX_LEN) || 'skill'
  );
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function defaultEditor(): string | undefined {
  if (process.platform === 'win32') return 'notepad';
  if (process.platform === 'darwin') return 'open';
  return undefined; // linux: require explicit EDITOR/VISUAL
}
