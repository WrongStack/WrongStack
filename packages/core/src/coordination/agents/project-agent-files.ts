import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { validateProjectAgentConfig } from './project-agent-config-validation.js';
import {
  agentsDir,
  isProjectAgentRoleName,
  roleDir,
  writeTextAtomically,
} from './project-agent-paths.js';
import { splitLearnedEntries } from './project-agent-learning-entries.js';
import {
  classifyLearnedEntry,
  MIN_INSTRUCTIVE_LENGTH,
} from './project-agent-learning-normalize.js';
import {
  mergeStructuredEntries,
  parseStructuredLearnedEntriesFromContent,
  renderLearnedInstructions,
} from './project-agent-learning-structured.js';
import type { ProjectAgentConfig, RoleKnowledgeManifest } from './project-agent-identity-types.js';

/**
 * Write or update the learned instruction buffer for a given role.
 *
 * `append` (the "teach this agent" flow) merges the text into the **structured**
 * entry list rather than concatenating it after the rendered document. Raw
 * concatenation used to be silently destructive: the structured parser only
 * falls back to the legacy chunk path when it finds no stamped entries, so a
 * taught paragraph appended to a stamped buffer was invisible to the parser and
 * the next capture — which re-renders the whole file from parsed entries —
 * deleted it without a trace.
 *
 * `replace` writes the content verbatim (the review/edit surfaces own the
 * document at that point).
 */
export function updateProjectAgentLearned(
  role: string,
  content: string,
  projectRoot?: string,
  mode: 'append' | 'replace' = 'append',
): string {
  const dir = roleDir(role, projectRoot);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'learned.md');
  if (mode === 'replace') {
    writeTextAtomically(filePath, content);
    return filePath;
  }

  const existing = (() => {
    try {
      return readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  })();
  const now = new Date().toISOString();
  const entries = parseStructuredLearnedEntriesFromContent(existing, splitLearnedEntries(existing));
  // Taught text is authored by a human and is not held to the automatic
  // capture quality bar; it is only stripped of decoration and split into
  // directives so it participates in dedup, categorisation and rendering.
  const clean = (chunk: string): string =>
    chunk
      .replace(/^>\s?/gm, '')
      .replace(/^[-*]\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
  const chunks = content
    .split(/\n{2,}/)
    .map(clean)
    .filter(Boolean);
  const longEnough = chunks.filter((chunk) => chunk.length >= MIN_INSTRUCTIVE_LENGTH);
  // Taught text is never dropped for being terse. Splitting on blank lines is
  // a convenience for multi-rule input; when no paragraph clears the bar the
  // whole note is kept as one directive rather than discarded.
  const directives = longEnough.length > 0 ? longEnough : chunks.length > 0 ? [clean(content)] : [];
  const merged = directives.reduce(
    (acc, text) =>
      mergeStructuredEntries(acc, {
        text,
        category: classifyLearnedEntry(text),
        capturedAt: now,
      }),
    entries,
  );
  writeTextAtomically(filePath, renderLearnedInstructions(role, merged, now));
  return filePath;
}

/**
 * Write or update the project identity file for a given role.
 * Replaces any existing identity.md with the new content.
 */
export function updateProjectAgentIdentity(
  role: string,
  content: string,
  projectRoot?: string,
): string {
  const dir = roleDir(role, projectRoot);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'identity.md');
  writeTextAtomically(filePath, content);
  return filePath;
}

/**
 * Write or update the config.json override for a given role.
 */
export function updateProjectAgentConfig(
  role: string,
  config: ProjectAgentConfig,
  projectRoot?: string,
): string {
  const validated = validateProjectAgentConfig(config);
  const dir = roleDir(role, projectRoot);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'config.json');
  writeTextAtomically(filePath, `${JSON.stringify(validated, null, 2)}\n`);
  return filePath;
}

/**
 * Write or update the knowledge manifest for a given role.
 */
export function updateProjectAgentKnowledge(
  role: string,
  manifest: RoleKnowledgeManifest,
  projectRoot?: string,
): string {
  const dir = roleDir(role, projectRoot);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'knowledge.json');
  writeTextAtomically(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return filePath;
}

/**
 * Reset all project-level customizations for a given role back to factory
 * defaults by removing its `.wrongstack/agents/<role>/` directory.
 * When `role` is omitted or `'*'`, resets all roles.
 * Returns a list of paths that were removed.
 */
export function resetProjectAgentIdentity(role?: string, projectRoot?: string): string[] {
  const removed: string[] = [];
  if (!role || role === '*') {
    const dir = agentsDir(projectRoot);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
    return removed;
  }
  const dir = roleDir(role, projectRoot);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

/**
 * Improve (or refresh) the project-custom identity for a given role
 * by clearing the learned.md and identity.md and re-scaffolding empty
 * templates. This is the explicit "refresh" trigger a user can call
 * when they want the project agent to re-learn from scratch.
 *
 * Returns a status report string.
 */
export function refreshProjectAgentIdentity(role: string, projectRoot?: string): string {
  const dir = roleDir(role, projectRoot);
  mkdirSync(dir, { recursive: true });

  for (const file of ['learned.md', 'identity.md', 'consolidated.md', 'consolidation.json']) {
    const fp = path.join(dir, file);
    try {
      rmSync(fp, { force: true });
    } catch {
      // file didn't exist
    }
  }

  writeTextAtomically(
    path.join(dir, 'learned.md'),
    renderLearnedInstructions(role, [], new Date().toISOString()),
  );
  writeTextAtomically(
    path.join(dir, 'identity.md'),
    `# Project identity for ${role}\n\n<!-- Describe how this agent should behave in the context of this project. -->\n`,
  );

  return `Project identity for role "${role}" has been refreshed. The identity.md and learned.md files are reset to empty templates. Run an agent-improve pass to populate them with project-specific knowledge.`;
}

/**
 * List every role that has any project-level agent customization or policy.
 */
export function listProjectAgentRoles(projectRoot?: string): string[] {
  const dir = agentsDir(projectRoot);
  try {
    return readdirSync(dir).filter((name: string) => {
      if (!isProjectAgentRoleName(name)) return false;
      const sub = path.join(dir, name);
      try {
        return [
          'learned.md',
          'identity.md',
          'config.json',
          'knowledge.json',
          'learning.json',
          'profile.json',
          'consolidated.md',
          'consolidation.json',
        ].some((file) => existsSync(path.join(sub, file)));
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
