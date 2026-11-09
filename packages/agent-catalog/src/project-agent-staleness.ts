/**
 * Staleness of learned project knowledge.
 *
 * What a roster role learns here is overwhelmingly *about this codebase*: which
 * file owns a contract, which barrel a package is consumed through, which test
 * pins an invariant. That is exactly what makes it valuable, and exactly what
 * makes it rot — the code moves on and the directive keeps pointing at a file
 * that is gone. Nothing ever re-checked it: a distilled addendum was only
 * rewritten when new directives arrived for the same skill, and the outcome
 * loop cannot retire a rule it cannot attribute (a dead path is never matched
 * in a report, so the directive simply stops being scored and lives forever).
 *
 * The check is deliberately narrow and deterministic: a repo-relative path an
 * entry cites, whose first segment is a real top-level directory of the
 * project, and which no longer exists on disk. Globs, package specifiers,
 * relative (`./`) paths and paths the entry itself says were removed are never
 * judged — the goal is to drop knowledge that is provably about code that is
 * not there any more, not to guess.
 */

import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import {
  clearProjectAgentConsolidated,
  consolidatedDocumentPath,
  loadProjectAgentConsolidated,
  readRawLearnedEntries,
} from './project-agent-consolidation.js';
import { renderLearnedInstructions } from './project-agent-learning-structured.js';
import { assertProjectAgentRole, roleDir, writeTextAtomically } from './project-agent-paths.js';
import { hasDirectiveContent } from './project-agent-quarantine.js';
import {
  clearProjectSkillAugmentation,
  listProjectSkillAugmentations,
  loadProjectSkillAugmentation,
  projectSkillAugmentationPath,
} from './project-agent-skill-layer.js';

/** Wording that marks a path as mentioned *because* it is gone. */
const MENTIONS_REMOVAL =
  /\b(?:removed|deleted|renamed|moved|no longer exists?|formerly|used to live|legacy|replaced by)\b/i;

/** Characters that make a token a pattern rather than a path. */
const GLOB_OR_PLACEHOLDER = /[*?{}[\]<>|$]/;

const BARE_PATH =
  /(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.(?:tsx|jsonc|json|jsx|yaml|mjs|cjs|yml|ts|js|md|sql|toml|css|html)\b/g;

function topLevelDirectories(projectRoot: string): Set<string> {
  try {
    return new Set(
      readdirSync(projectRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name),
    );
  } catch {
    return new Set();
  }
}

/** Normalize one cited token to a repo-relative path, or `undefined` if it is not one. */
function asRepoPath(token: string, roots: ReadonlySet<string>): string | undefined {
  let candidate = token
    .trim()
    .replace(/^[([{<]+/, '')
    .replace(/[)\]}>,.;:]+$/, '')
    .replace(/\\/g, '/');
  if (!candidate || candidate.includes('://') || /\s/.test(candidate)) return undefined;
  if (candidate.startsWith('@') || candidate.startsWith('.')) return undefined;
  if (GLOB_OR_PLACEHOLDER.test(candidate)) return undefined;
  // `packages/sdd/src/index.ts:43`, `index.ts:10-20`, `index.ts#L10-L20`, and
  // `foo.ts:buildProvider` → the file; a trailing slash names a directory.
  candidate = candidate
    .replace(/#L\d+(?:-L?\d+)?$/i, '')
    .replace(/:[\w$.-]+(?::\d+(?:-\d+)?)?$/, '')
    .replace(/[),.;:]+$/, '')
    .replace(/\/+$/, '');
  const segments = candidate.split('/');
  if (segments.length < 2 || segments.some((segment) => !segment || segment === '..')) {
    return undefined;
  }
  return roots.has(segments[0] as string) ? candidate : undefined;
}

function citedRepoPaths(text: string, roots: ReadonlySet<string>): string[] {
  const cited = new Set<string>();
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const repoPath = asRepoPath(match[1] ?? '', roots);
    if (repoPath) cited.add(repoPath);
  }
  for (const match of text.matchAll(BARE_PATH)) {
    const repoPath = asRepoPath(match[0], roots);
    if (repoPath) cited.add(repoPath);
  }
  return [...cited];
}

/**
 * A reusable checker bound to one project root. It memoizes existence checks,
 * so scanning a role's whole learning set costs one `stat` per distinct path.
 */
export interface StalePathChecker {
  /** Cited paths in `text` that no longer exist. Empty when the text is current. */
  stalePaths(text: string): string[];
}

/**
 * Directories a cited path may legitimately be relative to: the project root,
 * and every workspace package one level below a top-level directory
 * (`packages/core`, `apps/wrongstack`). Directives about a package routinely cite
 * `src/index.ts` meaning *that package's* entry, which is not a stale path just
 * because the repository root has no such file.
 */
function resolutionBases(projectRoot: string, roots: ReadonlySet<string>): string[] {
  const bases = [projectRoot];
  for (const top of roots) {
    try {
      for (const entry of readdirSync(path.join(projectRoot, top), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const base = path.join(projectRoot, top, entry.name);
        if (existsSync(path.join(base, 'package.json'))) bases.push(base);
      }
    } catch {
      // Unreadable directory: fewer bases only ever means fewer paths judged
      // present, and `src/` citations then fall back to the root check.
    }
  }
  return bases;
}

export function createStalePathChecker(projectRoot: string): StalePathChecker {
  const roots = topLevelDirectories(projectRoot);
  let bases: string[] | undefined;
  const exists = new Map<string, boolean>();
  const present = (repoPath: string): boolean => {
    let known = exists.get(repoPath);
    if (known === undefined) {
      if (existsSync(path.join(projectRoot, repoPath))) {
        known = true;
      } else {
        bases ??= resolutionBases(projectRoot, roots);
        known = bases.some((base) => existsSync(path.join(base, repoPath)));
      }
      exists.set(repoPath, known);
    }
    return known;
  };
  return {
    stalePaths(text: string): string[] {
      if (roots.size === 0 || !text || MENTIONS_REMOVAL.test(text)) return [];
      return citedRepoPaths(text, roots).filter((repoPath) => !present(repoPath));
    },
  };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Remove every directive line of a markdown document (a skill addendum or the
 * role's consolidated document) that cites a path which no longer exists,
 * together with the continuation lines indented beneath it. Headings, quotes
 * and stamps are never removed; a section left without content keeps its
 * heading, which the next distillation pass tidies.
 */
export function scrubStaleLines(
  text: string,
  checker: StalePathChecker,
): { text: string; removed: string[] } {
  if (!text.trim()) return { text, removed: [] };
  const lines = text.split('\n');
  const kept: string[] = [];
  const removed: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trimStart();
    const isStructure =
      !trimmed || trimmed.startsWith('#') || trimmed.startsWith('>') || /^-{3,}\s*$/.test(trimmed);
    if (!isStructure && checker.stalePaths(line).length > 0) {
      removed.push(trimmed);
      const base = indentOf(line);
      while (i + 1 < lines.length) {
        const next = lines[i + 1] as string;
        if (!next.trim() || indentOf(next) <= base) break;
        i++;
      }
      continue;
    }
    kept.push(line);
  }
  if (removed.length === 0) return { text, removed };
  return {
    text: kept
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    removed,
  };
}

export interface StaleRefreshResult {
  role: string;
  /** Buffer directives removed because they cite a path that is gone. */
  bufferEntries: number;
  /** Lines removed from the role document and the skill addenda. */
  documentLines: number;
  /** Skill addenda deleted because nothing but stale lines was left in them. */
  clearedSkills: string[];
}

/**
 * Drop everything a role has learned that cites a path which no longer exists:
 * directives in the capture buffer, lines of the role document, lines of each
 * skill addendum. Removed material is appended to `archive/stale-<at>.md`, so
 * nothing is lost to an audit — it only stops being injected.
 *
 * Writes nothing when nothing is stale, so running it on every host start is
 * a handful of `stat` calls and no churn in a committed directory. Callers on
 * a hot path must swallow errors: staleness is hygiene, not correctness.
 */
export function refreshStaleProjectAgentLearning(
  role: string,
  projectRoot: string,
  checker: StalePathChecker = createStalePathChecker(projectRoot),
): StaleRefreshResult {
  const normalizedRole = assertProjectAgentRole(role);
  const result: StaleRefreshResult = {
    role: normalizedRole,
    bufferEntries: 0,
    documentLines: 0,
    clearedSkills: [],
  };
  const at = new Date().toISOString();
  const archived: string[] = [];

  const entries = readRawLearnedEntries(normalizedRole, projectRoot);
  const current = entries.filter(
    (entry) => checker.stalePaths(`${entry.what}\n${entry.how}`).length === 0,
  );
  if (current.length < entries.length) {
    const gone = entries.filter((entry) => !current.includes(entry));
    result.bufferEntries = gone.length;
    archived.push('## learned.md', '', ...gone.map((entry) => `- ${entry.what}`), '');
    // Same footer rule as outcome updates: this is not a capture, so the
    // document keeps the newest capture's timestamp rather than "now".
    const newest =
      current
        .map((entry) => entry.capturedAt)
        .filter(Boolean)
        .sort()
        .pop() ?? at;
    writeTextAtomically(
      path.join(roleDir(normalizedRole, projectRoot), 'learned.md'),
      renderLearnedInstructions(normalizedRole, current, newest),
    );
  }

  const consolidated = loadProjectAgentConsolidated(normalizedRole, projectRoot);
  if (consolidated) {
    const scrubbed = scrubStaleLines(consolidated, checker);
    if (scrubbed.removed.length > 0) {
      result.documentLines += scrubbed.removed.length;
      archived.push('## consolidated.md', '', ...scrubbed.removed, '');
      if (hasDirectiveContent(scrubbed.text)) {
        writeTextAtomically(consolidatedDocumentPath(normalizedRole, projectRoot), scrubbed.text);
      } else {
        clearProjectAgentConsolidated(normalizedRole, projectRoot);
      }
    }
  }

  for (const skill of listProjectSkillAugmentations(normalizedRole, projectRoot)) {
    const addendum = loadProjectSkillAugmentation(normalizedRole, skill, projectRoot);
    const scrubbed = scrubStaleLines(addendum, checker);
    if (scrubbed.removed.length === 0) continue;
    result.documentLines += scrubbed.removed.length;
    archived.push(`## skills/${skill}.md`, '', ...scrubbed.removed, '');
    if (hasDirectiveContent(scrubbed.text)) {
      writeTextAtomically(
        projectSkillAugmentationPath(normalizedRole, skill, projectRoot),
        `${scrubbed.text}\n`,
      );
    } else {
      clearProjectSkillAugmentation(normalizedRole, skill, projectRoot);
      result.clearedSkills.push(skill);
    }
  }

  if (archived.length > 0) {
    writeTextAtomically(
      path.join(
        roleDir(normalizedRole, projectRoot),
        'archive',
        `stale-${at.replace(/[:.]/g, '-')}.md`,
      ),
      [
        `# Stale learning retired for \`${normalizedRole}\``,
        '',
        `> Removed ${at}: each item cites a path that no longer exists in this project.`,
        '',
        ...archived,
      ].join('\n'),
    );
  }
  return result;
}
