/**
 * `codebase-repo-map` tool — generate a reference-weighted, token-budgeted Repository Map.
 *
 * Usage: codebase-repo-map({
 *   maxTokens?: number,       // maximum token budget for the map (default: 1200)
 *   focusFiles?: string[],    // list of paths to prioritize/boost in the ranking
 * })
 */

import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { safeResolveProjectPath } from '../_util.js';
import { generateRepoMap, type RepoMapResult } from './repo-map.js';
import { codebaseIndexDirOverride } from './writer.js';

export interface CodebaseRepoMapInput {
  /** Maximum token budget (approximate) for the generated map. Defaults to 1200. */
  maxTokens?: number | undefined;
  /** Optional file paths to prioritize and boost in the map generation. */
  focusFiles?: string[] | undefined;
}

const MIN_MAP_TOKENS = 100;
const MAX_MAP_TOKENS = 20_000;

export interface CodebaseRepoMapOutput extends RepoMapResult {
  status: 'ok';
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
        type: 'integer',
        description: `Maximum token budget (approximate) for the map. Defaults to 1200, range ${MIN_MAP_TOKENS}-${MAX_MAP_TOKENS}.`,
        minimum: MIN_MAP_TOKENS,
        maximum: MAX_MAP_TOKENS,
      },
      focusFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'File paths to prioritize and ensure inclusion in the map.',
      },
    },
    additionalProperties: false,
  },
  // Failures THROW so the executor marks the call is_error (a returned
  // `status: 'error'` payload was recorded as a successful call).
  async execute(input, ctx) {
    const projectRoot = ctx.projectRoot ?? ctx.cwd ?? process.cwd();
    // Unclamped, 0/negative produced an empty map and NaN a zero char budget;
    // a huge value let one call flood the context window.
    const maxTokens = Number.isFinite(input.maxTokens)
      ? Math.min(Math.max(Math.trunc(input.maxTokens as number), MIN_MAP_TOKENS), MAX_MAP_TOKENS)
      : undefined;
    // Security: focus files are READ (skeleton extraction, whose fallback
    // returns a file's full text) by an auto-permission tool, so an absolute or
    // `../` entry disclosed arbitrary files without a prompt. Enforce the same
    // realpath containment as codebase-skeleton before anything is opened.
    let focusFiles: string[] | undefined;
    if (input.focusFiles !== undefined) {
      if (!Array.isArray(input.focusFiles)) {
        throw new ToolValidationError({
          message: 'codebase-repo-map: focusFiles must be an array of file paths.',
          field: 'focusFiles',
        });
      }
      focusFiles = [];
      for (const file of input.focusFiles) {
        if (typeof file !== 'string' || !file.trim()) {
          throw new ToolValidationError({
            message: 'codebase-repo-map: focusFiles entries must be non-empty file paths.',
            field: 'focusFiles',
          });
        }
        await safeResolveProjectPath(file.trim(), ctx);
        focusFiles.push(path.resolve(projectRoot, file.trim()));
      }
    }
    const result = await generateRepoMap({
      projectRoot,
      maxTokens,
      focusFiles,
      // Honour a caller-supplied index location so the map reads the same
      // index the other codebase-* tools do.
      indexDir: codebaseIndexDirOverride(ctx),
    });

    return {
      status: 'ok',
      ...result,
    };
  },
};
