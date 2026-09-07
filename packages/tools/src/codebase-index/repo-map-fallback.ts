/**
 * Filesystem repo map — the path taken when the index has no ranks yet.
 *
 * This is the original heuristic map: walk the tree, score each file by
 * entry-point name and depth, and pack skeletons until the budget runs out.
 * It knows nothing about who references whom, so it is strictly a stand-in
 * for {@link generateRepoMap}'s graph-ranked output on a fresh clone, during
 * the first index run, or in a directory that was never indexed at all.
 *
 * Two defects of the original are fixed here, because a stand-in that lies is
 * worse than no stand-in: it no longer stops after ~500 files (this repo has
 * 8,412, so the old cap meant the "map" described whichever directories the
 * walk happened to reach first), and it honours `.gitignore` instead of a
 * hardcoded list of four directory names.
 */

import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadGitignoreMatcher } from './gitignore.js';
import { isIndexablePath } from './languages.js';
import { renderSkeletonSections } from './repo-map-render.js';
import type { RepoMapOptions, RepoMapResult } from './repo-map-types.js';

const ENTRY_POINT_REGEX =
  /(?:^|[/\\])(?:index|main|app|server|cli|lib|api|types|routes|mod)\.[a-zA-Z0-9]+$/i;
const TEST_OR_MOCK_REGEX = /(?:test|spec|mock|fixture|bench|example)[s]?[/\\._]/i;

/** Directories that are never source, and that `.gitignore` may not list. */
const ALWAYS_SKIP = new Set(['node_modules', 'dist', 'build', 'coverage']);

/**
 * Heuristic entry-point score. Kept identical to the original scoring so the
 * fallback's output does not shift when it is the path actually taken.
 */
function getEntryPointBonus(relPath: string): number {
  if (TEST_OR_MOCK_REGEX.test(relPath)) return -20;
  if (ENTRY_POINT_REGEX.test(relPath)) return 25;
  const depth = relPath.split(/[/\\]/).length;
  if (depth <= 2) return 10;
  if (depth <= 3) return 5;
  return 0;
}

export async function generateFallbackRepoMap(opts: RepoMapOptions): Promise<RepoMapResult> {
  const projectRoot = opts.projectRoot;
  const charBudget = (opts.maxTokens ?? 1200) * 4;
  const focusSet = new Set((opts.focusFiles ?? []).map((f) => path.resolve(projectRoot, f)));
  const isGitIgnored = await loadGitignoreMatcher(projectRoot);

  const allFiles: string[] = [];
  async function scan(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ALWAYS_SKIP.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      // The matcher takes a forward-slash project-relative path, as in the
      // indexer's own walk.
      const rel = path.relative(projectRoot, fullPath).replace(/\\/g, '/');
      if (isGitIgnored(rel, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.isFile() && isIndexablePath(fullPath)) {
        allFiles.push(fullPath);
      }
    }
  }
  await scan(projectRoot);

  if (allFiles.length === 0) {
    return {
      map: '// [Repo map: No indexable source files found]',
      filesCount: 0,
      totalFilesScanned: 0,
      estimatedTokens: 0,
      rankedFiles: [],
    };
  }

  const scored = allFiles.map((file) => {
    const relPath = path.relative(projectRoot, file).replace(/\\/g, '/');
    const score = 10 + (focusSet.has(file) ? 100 : 0) + getEntryPointBonus(relPath);
    return { file, relPath, score };
  });
  scored.sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));

  const { sections, files } = await renderSkeletonSections(
    scored.map((s) => ({ absolute: s.file, relative: s.relPath })),
    charBudget,
    { skeleton: opts.options },
  );

  const map = sections.join('\n\n');
  return {
    map,
    filesCount: files.length,
    totalFilesScanned: allFiles.length,
    estimatedTokens: Math.ceil(map.length / 4),
    rankedFiles: files,
  };
}
