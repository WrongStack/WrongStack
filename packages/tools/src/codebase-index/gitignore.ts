/**
 * Minimal but faithful `.gitignore` matcher for the indexer.
 *
 * Supports the parts of the gitignore spec that matter for skipping source
 * files: comments / blanks, `!` negation (last match wins), trailing-slash
 * directory-only rules, leading-slash / embedded-slash anchoring, and the
 * `*` / `**` / `?` / `[...]` globs (via core's {@link compileGlob}).
 *
 * Only the project-root `.gitignore` is read. Nested `.gitignore` files are not
 * walked — the common build/dependency dirs that would live deeper are already
 * covered by the indexer's always-on `DEFAULT_IGNORE`.
 *
 * Known limitation: a `!negated` file inside an ignored directory will not be
 * re-included, because the indexer prunes ignored directories before descending
 * (a large performance win). This matches most lightweight implementations.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { compileGlob } from '@wrongstack/core/utils';

export type IgnoreMatcher = (relPath: string, isDir: boolean) => boolean;

interface Rule {
  /** Matches the entry itself or anything under it (for dirs / plain names). */
  eqOrUnder: RegExp;
  /** Matches only entries strictly under it (for dir-only rules on files). */
  under: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

/** Strip the `^`/`$` anchors compileGlob adds so we can re-anchor ourselves. */
function globBody(glob: string): string {
  return compileGlob(glob).source.replace(/^\^/, '').replace(/\$$/, '');
}

/** Compile a list of raw `.gitignore` lines into a matcher. */
export function compileGitignore(lines: string[]): IgnoreMatcher {
  const rules: Rule[] = [];

  for (const raw of lines) {
    let line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    line = line.trim();

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }

    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;

    // A slash anywhere (after the trailing slash is stripped) anchors the
    // pattern to the gitignore's directory (the project root here). A bare name
    // matches at any depth.
    const anchored = line.startsWith('/') || line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);

    const body = globBody(line);
    const prefix = anchored ? '^' : '(?:^|.*/)';
    rules.push({
      eqOrUnder: new RegExp(`${prefix}${body}(?:/.*)?$`),
      under: new RegExp(`${prefix}${body}/.*$`),
      negated,
      dirOnly,
    });
  }

  const hasNegation = rules.some((r) => r.negated);

  return (relPath: string, isDir: boolean): boolean => {
    const p =
      relPath.includes('\\') || relPath.startsWith('/')
        ? relPath.replace(/\\/g, '/').replace(/^\/+/, '')
        : relPath;
    let ignored = false;
    for (const r of rules) {
      // A directory-only rule never matches a file by its own name; it only
      // matches files that live strictly beneath the named directory.
      const re = r.dirOnly && !isDir ? r.under : r.eqOrUnder;
      if (re.test(p)) {
        ignored = !r.negated;
        if (!hasNegation && ignored) return true;
      }
    }
    return ignored;
  };
}

/** Read `<projectRoot>/.gitignore` and compile it. Missing file → matches nothing. */
export async function loadGitignoreMatcher(projectRoot: string): Promise<IgnoreMatcher> {
  let lines: string[] = [];
  try {
    const raw = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');
    lines = raw.split('\n');
  } catch {
    // No .gitignore — nothing extra to ignore beyond the indexer defaults.
  }
  return compileGitignore(lines);
}
