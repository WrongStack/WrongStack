/**
 * Frontmatter `paths` matching: does a skill's own declaration cover a file?
 *
 * Globs are project-relative; a glob without a `/` matches the file name in
 * any directory. `{a,b}` groups are expanded here because the shared glob
 * engine has no brace syntax. Everything is bounded: a skill is untrusted
 * text, and this runs on the tool-execution path.
 */

import { basename, isAbsolute, relative, resolve } from 'node:path';
import { compilePathGlob } from '../utils/glob-match.js';

export const MAX_GLOBS_PER_SKILL = 16;
const MAX_BRACE_EXPANSIONS = 32;
const MAX_CACHED_GLOBS = 256;

/** Expand `{a,b}` groups (innermost first), bounded so a hostile glob stays cheap. */
export function expandBraces(glob: string): string[] {
  let out = [glob];
  for (let round = 0; round < 8; round++) {
    let changed = false;
    const next: string[] = [];
    for (const pattern of out) {
      const group = /\{([^{}]*)\}/.exec(pattern);
      if (!group) {
        next.push(pattern);
        continue;
      }
      changed = true;
      const head = pattern.slice(0, group.index);
      const tail = pattern.slice(group.index + group[0].length);
      for (const option of group[1]!.split(',')) next.push(`${head}${option}${tail}`);
    }
    out = [...new Set(next)].slice(0, MAX_BRACE_EXPANSIONS);
    if (!changed) break;
  }
  return out;
}

const globCache = new Map<string, RegExp | null>();

function compiled(pattern: string): RegExp | null {
  let regex = globCache.get(pattern);
  if (regex !== undefined) return regex;
  try {
    regex = compilePathGlob(pattern);
  } catch {
    regex = null;
  }
  if (globCache.size >= MAX_CACHED_GLOBS) globCache.delete(globCache.keys().next().value!);
  globCache.set(pattern, regex);
  return regex;
}

/**
 * The file relative to the project, or undefined when it lies outside it. A
 * relative path is resolved from `cwd` first: tools take paths relative to
 * the working directory, which may be below the project root.
 */
function projectPath(
  file: string,
  root: string | undefined,
  cwd: string | undefined,
): string | undefined {
  if (!isAbsolute(file)) {
    if (!root) {
      const norm = file.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      return !norm ||
        norm === '..' ||
        norm.startsWith('../') ||
        norm.includes('/../') ||
        norm.endsWith('/..')
        ? undefined
        : norm;
    }
    file = resolve(cwd ?? root, file);
  }
  if (!root) return undefined;
  const rel = relative(root, file).replace(/\\/g, '/');
  return !rel || rel.startsWith('../') || rel === '..' || isAbsolute(rel) ? undefined : rel;
}

/** The declared glob that covers `file`, or undefined. */
export function declaredPathMatch(
  skill: { paths?: readonly string[] | undefined },
  file: string,
  projectRoot: string | undefined,
  cwd?: string | undefined,
): string | undefined {
  if (!skill.paths?.length) return undefined;
  const rel = projectPath(file, projectRoot, cwd);
  if (!rel) return undefined;
  for (const glob of skill.paths.slice(0, MAX_GLOBS_PER_SKILL)) {
    for (const raw of expandBraces(glob)) {
      const pattern = raw.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      if (!pattern) continue;
      const subject = pattern.includes('/') ? rel : basename(rel);
      if (compiled(pattern)?.test(subject)) return glob;
    }
  }
  return undefined;
}
