/**
 * `codebase-skeleton` tool — extract AST-based file skeletons with body redaction.
 *
 * Usage: codebase-skeleton({
 *   path: string,             // relative or absolute file or directory path
 *   includeDocs?: boolean,    // preserve JSDoc / docstrings (default: true)
 *   collapseImports?: boolean,// collapse import headers (default: false)
 *   exportsOnly?: boolean,    // filter to exported declarations (default: false)
 *   maxFiles?: number,        // max files to scan when path is a directory (default: 20)
 * })
 *
 * Returns: { path, isDir, skeleton, stats: { originalLines, skeletonLines, tokenSavingsPercent, symbolCount } }
 */

import * as fs from 'node:fs/promises';
import type { Tool } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { safeResolveProjectPath } from '../_util.js';
import {
  extractDirectorySkeleton,
  extractFileSkeleton,
  type FileSkeletonResult,
  type SkeletonOptions,
} from './skeleton-extractor.js';

export interface CodebaseSkeletonInput extends SkeletonOptions {
  /** Relative or absolute file or directory path. */
  path: string;
  /** Maximum number of files to process if `path` is a directory. Defaults to 20. */
  maxFiles?: number;
}

export interface CodebaseSkeletonOutput {
  path: string;
  isDir: boolean;
  skeleton: string;
  stats: {
    originalLines: number;
    skeletonLines: number;
    tokenSavingsPercent: number;
    symbolCount: number;
    fileCount?: number;
  };
  files?: FileSkeletonResult[];
}

export const codebaseSkeletonTool: Tool<CodebaseSkeletonInput, CodebaseSkeletonOutput> = {
  name: 'codebase-skeleton',
  category: 'Project',
  icon: 'index',
  description:
    'Extract an AST-based skeleton of a file or directory with implementation bodies stripped. ' +
    'Preserves imports, type definitions, interfaces, docstrings, and function/method signatures while saving ~70-90% tokens. ' +
    'Prefer this before reading full multi-hundred-line files when exploring module structure, contracts, or candidate APIs.',
  usageHint:
    'FIRST CHOICE FOR MODULE CONTRACT & OUTLINE UNDERSTANDING:\n\n' +
    '- Call on large source files to inspect signatures, types, and exports before issuing a full `read`.\n' +
    '- Call on directories to generate a compact repository or module map.\n' +
    '- Use `includeDocs: true` (default) to keep API documentation.\n' +
    '- Use `collapseImports: true` to further compress import-heavy modules.',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  timeoutMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative or absolute file or directory path to extract skeleton for.',
      },
      includeDocs: {
        type: 'boolean',
        description: 'Keep JSDoc / docstrings in the output skeleton (defaults to true).',
      },
      collapseImports: {
        type: 'boolean',
        description: 'Collapse import blocks into a single summary comment (defaults to false).',
      },
      exportsOnly: {
        type: 'boolean',
        description: 'Only include exported/public declarations (defaults to false).',
      },
      maxFiles: {
        type: 'number',
        description: 'Max files to include if path is a directory (defaults to 20, max 50).',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(input, ctx, execOpts) {
    const signal = execOpts?.signal ?? ctx?.signal;
    signal?.throwIfAborted();

    // H-5 (security report VF-06): this tool is `permission: 'auto'`, so the
    // resolve must not be a bare isAbsolute passthrough — an absolute or ../
    // path read arbitrary files (the fallback extractor returns FULL content
    // for non-source files) without ever prompting. safeResolveProjectPath
    // keeps this tool's documented contract (relative = project-root-relative,
    // NOT session-cwd-relative) while enforcing the shared realpath
    // containment; restricted mode now actually restricts this tool.
    const targetPath = await safeResolveProjectPath(input.path, ctx);

    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(targetPath);
    } catch (err) {
      throw new Error(
        `codebase-skeleton: file or directory not found at "${input.path}": ${toErrorMessage(err)}`,
      );
    }

    const options: SkeletonOptions = {
      includeDocs: input.includeDocs ?? true,
      collapseImports: input.collapseImports ?? false,
      exportsOnly: input.exportsOnly ?? false,
    };

    if (stat.isDirectory()) {
      const maxFiles = Math.min(Math.max(1, input.maxFiles ?? 20), 50);
      const dirResult = await extractDirectorySkeleton({
        dirPath: targetPath,
        maxFiles,
        options,
      });

      let totalSymbols = 0;
      for (const f of dirResult.files) {
        totalSymbols += f.stats.symbolCount;
      }

      return {
        path: input.path,
        isDir: true,
        skeleton: dirResult.combinedSkeleton,
        stats: {
          originalLines: dirResult.totalOriginalLines,
          skeletonLines: dirResult.totalSkeletonLines,
          tokenSavingsPercent: dirResult.overallSavingsPercent,
          symbolCount: totalSymbols,
          fileCount: dirResult.files.length,
        },
        files: dirResult.files,
      };
    }

    const content = await fs.readFile(targetPath, 'utf8');
    const fileResult = await extractFileSkeleton({
      file: targetPath,
      content,
      options,
    });

    return {
      path: input.path,
      isDir: false,
      skeleton: fileResult.skeleton,
      stats: fileResult.stats,
    };
  },
};
