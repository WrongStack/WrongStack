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
    'Generate a reference-weighted, token-budgeted Repository Map (Repo Map) of the codebase. ' +
    'Extracts the most architecturally central types, interfaces, classes, and function signatures ' +
    'across the repository into a compact outline (~800-1500 tokens). ' +
    'Use this at the beginning of tasks or when navigating unfamiliar repositories to get a bird-eye view of the architecture.',
  usageHint:
    'USE AT THE START OF COMPLEX OR REPOSITORY-WIDE TASKS:\n\n' +
    '- Call with default parameters to get a global architecture map within ~1200 tokens.\n' +
    '- Pass `focusFiles: ["src/auth.ts"]` to ensure candidate files are guaranteed to be mapped alongside related entry-points.\n' +
    '- Use the returned line numbers (e.g. `/* L32-L45 */`) to navigate or partially read only the functions you need.',
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
