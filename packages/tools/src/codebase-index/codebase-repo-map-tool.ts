/**
 * `codebase-repo-map` tool — generate a reference-weighted, token-budgeted Repository Map.
 *
 * Usage: codebase-repo-map({
 *   maxTokens?: number,       // maximum token budget for the map (default: 1200)
 *   focusFiles?: string[],    // list of paths to prioritize/boost in the ranking
 * })
 */

import type { Tool } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { generateRepoMap, type RepoMapResult } from './repo-map.js';
import { codebaseIndexDirOverride } from './writer.js';

export interface CodebaseRepoMapInput {
  /** Maximum token budget (approximate) for the generated map. Defaults to 1200. */
  maxTokens?: number | undefined;
  /** Optional file paths to prioritize and boost in the map generation. */
  focusFiles?: string[] | undefined;
}

export interface CodebaseRepoMapOutput extends RepoMapResult {
  status: 'ok' | 'error';
  error?: string | undefined;
}

export const codebaseRepoMapTool: Tool<CodebaseRepoMapInput, CodebaseRepoMapOutput> = {
  name: 'codebase-repo-map',
  category: 'Project',
  icon: 'index',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  description:
    'Generate a centrality-ranked, token-budgeted Repository Map of the codebase (~1200 token default). Use it for orientation before a cross-file change. ' +
    "Ranking comes from the index's reference graph (PageRank over calls, imports, type references and inheritance), not from filenames, " +
    'so the map opens with the package clusters and their hub files, then the repository-wide hotspots, ' +
    'then the signatures of the most central files. ' +
    'Use this at the beginning of tasks or when navigating unfamiliar repositories to get a bird-eye view of the architecture.',
  usageHint:
    'USE AT THE START OF COMPLEX OR REPOSITORY-WIDE TASKS:\n\n' +
    '- Call with default parameters to get a global architecture map within ~1200 tokens.\n' +
    '- The `1.00 = most central` scores are relative to this repository only; never compare them across projects.\n' +
    '- Pass `focusFiles: ["src/auth.ts"]` to put specific files at the head of the map alongside the central ones.\n' +
    '- Use the returned line numbers (e.g. `/* L32-L45 */`) to navigate or partially read only the functions you need.\n' +
    '- Falls back to a filename heuristic when the index has not been built yet; run `/codebase-reindex` to get the ranked map.',
  inputSchema: {
    type: 'object',
    properties: {
      maxTokens: {
        type: 'number',
        description: 'Maximum token budget (approximate) for the map. Defaults to 1200.',
      },
      focusFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'File paths to prioritize and ensure inclusion in the map.',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    try {
      const projectRoot = ctx.projectRoot ?? ctx.cwd ?? process.cwd();
      const result = await generateRepoMap({
        projectRoot,
        maxTokens: input.maxTokens,
        focusFiles: input.focusFiles,
        // Honour a caller-supplied index location so the map reads the same
        // index the other codebase-* tools do.
        indexDir: codebaseIndexDirOverride(ctx),
      });

      return {
        status: 'ok',
        ...result,
      };
    } catch (err) {
      return {
        status: 'error',
        map: '',
        filesCount: 0,
        totalFilesScanned: 0,
        estimatedTokens: 0,
        rankedFiles: [],
        error: toErrorMessage(err),
      };
    }
  },
};
