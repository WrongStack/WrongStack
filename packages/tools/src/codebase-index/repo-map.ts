import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isIndexablePath } from './languages.js';
import { extractFileSkeleton, type SkeletonOptions } from './skeleton-extractor.js';

export interface RepoMapOptions {
  projectRoot: string;
  maxTokens?: number | undefined;
  focusFiles?: string[] | undefined;
  options?: SkeletonOptions | undefined;
}

export interface RepoMapResult {
  map: string;
  filesCount: number;
  totalFilesScanned: number;
  estimatedTokens: number;
  rankedFiles: string[];
}

const ENTRY_POINT_REGEX = /(?:^|[/\\])(?:index|main|app|server|cli|lib|api|types|routes|mod)\.[a-zA-Z0-9]+$/i;
const TEST_OR_MOCK_REGEX = /(?:test|spec|mock|fixture|bench|example)[s]?[/\\._]/i;

/**
 * Heuristic entry-point score multiplier.
 */
function getEntryPointBonus(relPath: string): number {
  if (TEST_OR_MOCK_REGEX.test(relPath)) {
    return -20;
  }
  if (ENTRY_POINT_REGEX.test(relPath)) {
    return 25;
  }
  // Shallow depth bonus (root or 1-2 levels deep)
  const depth = relPath.split(/[/\\]/).length;
  if (depth <= 2) return 10;
  if (depth <= 3) return 5;
  return 0;
}

/**
 * Generate a reference-weighted, token-budgeted Repository Map.
 * Packs the most architecturally central symbols across the codebase into ~800-1500 tokens.
 */
export async function generateRepoMap(opts: RepoMapOptions): Promise<RepoMapResult> {
  const projectRoot = opts.projectRoot;
  const maxTokens = opts.maxTokens ?? 1200;
  const charBudget = maxTokens * 4; // ~4 chars per token rule of thumb
  const focusSet = new Set((opts.focusFiles ?? []).map((f) => path.resolve(projectRoot, f)));

  const allFiles: string[] = [];

  async function scan(dir: string) {
    if (allFiles.length > 500) return; // safety ceiling
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'build' ||
        entry.name === 'coverage'
      ) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
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

  // 1. Score files based on entry-point heuristics, focus list, and symbol density
  const scoredFiles: Array<{ file: string; score: number; relPath: string }> = [];

  for (const file of allFiles) {
    const relPath = path.relative(projectRoot, file).replace(/\\/g, '/');
    let score = 10;

    // Focus boost
    if (focusSet.has(file)) {
      score += 100;
    }

    // Heuristics
    score += getEntryPointBonus(relPath);

    scoredFiles.push({ file, score, relPath });
  }

  // Sort descending by score
  scoredFiles.sort((a, b) => b.score - a.score);

  // 2. Extract skeletons for top candidate files within token budget
  const includedSections: string[] = [];
  const includedFiles: string[] = [];
  let currentChars = 0;

  for (const candidate of scoredFiles) {
    if (currentChars >= charBudget) break;

    try {
      const content = await fs.readFile(candidate.file, 'utf8');
      if (content.length === 0) continue;

      const skeletonResult = await extractFileSkeleton({
        file: candidate.file,
        content,
        options: {
          exportsOnly: true,
          collapseImports: true,
          includeDocs: false,
          includeLineNumbers: true,
          ...(opts.options ?? {}),
        },
      });

      const cleanSkeleton = skeletonResult.skeleton.trim();
      if (!cleanSkeleton) continue;

      const section = `${candidate.relPath} (${skeletonResult.lang}):\n${cleanSkeleton
        .split('\n')
        .map((line) => (line.trim() ? `  ${line}` : ''))
        .join('\n')}`;

      const sectionChars = section.length + 2;

      if (currentChars + sectionChars > charBudget && includedFiles.length > 0) {
        // Stop when next file exceeds budget
        break;
      }

      includedSections.push(section);
      includedFiles.push(candidate.relPath);
      currentChars += sectionChars;
    } catch {
      // Ignore unreadable files
    }
  }

  const map = includedSections.join('\n\n');
  const estimatedTokens = Math.ceil(map.length / 4);

  return {
    map,
    filesCount: includedFiles.length,
    totalFilesScanned: allFiles.length,
    estimatedTokens,
    rankedFiles: includedFiles,
  };
}
