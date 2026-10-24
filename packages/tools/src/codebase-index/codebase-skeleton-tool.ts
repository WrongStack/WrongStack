/**
 * `codebase-skeleton` tool — extract AST-based file skeletons with body redaction.
 *
 * Usage: codebase-skeleton({
 *   path: string,             // relative or absolute file or directory path
 *   includeDocs?: boolean,    // preserve JSDoc / docstrings (default: true)
 *   collapseImports?: boolean,// collapse import headers (default: false)
 *   exportsOnly?: boolean,    // filter to exported declarations (default: false)
 *   maxFiles?: number,        // max files to scan when path is a directory (default: 20)
 *   maxChars?: number,        // directory skeleton budget, cut at a file boundary (default: 60k)
 * })
 *
 * Returns: { path, isDir, skeleton, stats: { originalLines, skeletonLines, tokenSavingsPercent, symbolCount } }
 * Serialized for the model as a one-line summary followed by the skeleton text.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { safeResolveProjectPath } from '../_util.js';
import { extractDirectorySkeleton } from './directory-skeleton.js';
import {
  extractFileSkeleton,
  type FileSkeletonResult,
  type SkeletonOptions,
} from './skeleton-extractor.js';

export interface CodebaseSkeletonInput extends SkeletonOptions {
  /** Relative or absolute file or directory path. */
  path: string;
  /** Maximum number of files to process if `path` is a directory. Defaults to 20. */
  maxFiles?: number;
  /** Character budget for a directory skeleton. Defaults to 60,000. */
  maxChars?: number;
}

/** One directory file's place in the result; its skeleton is in `skeleton`. */
export type CodebaseSkeletonFile = Pick<FileSkeletonResult, 'file' | 'lang' | 'stats'>;

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
  files?: CodebaseSkeletonFile[];
  /** Directory files left out to stay within `maxChars`, directory-relative. */
  omittedFiles?: string[];
  /** The directory walk stopped at `maxFiles` with more files left. */
  moreFiles?: boolean;
  maxFiles?: number;
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 60_000;
const MAX_MAX_CHARS = 200_000;

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  // Math.max/min propagate NaN, which made the directory walk stop at 0 files.
  const requested = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(Math.max(min, requested), max);
}

/**
 * The model-facing text: a summary line, what a directory result left out,
 * then the skeleton itself. Plain text keeps the skeleton's own line breaks,
 * so a client that spills a large result to a file can still page through it.
 */
function renderSkeleton(output: CodebaseSkeletonOutput): string {
  const { stats } = output;
  const summary = [
    output.path,
    output.isDir ? `${stats.fileCount ?? 0} files` : undefined,
    `${stats.originalLines} → ${stats.skeletonLines} lines (${stats.tokenSavingsPercent}% saved)`,
    `${stats.symbolCount} symbols`,
  ]
    .filter(Boolean)
    .join(' · ');
  const notes: string[] = [];
  if (output.omittedFiles && output.omittedFiles.length > 0) {
    // As paths this tool accepts: the omitted list is directory-relative, and
    // a bare `agent/x.ts` would resolve against the project root.
    const dir = output.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const paths = output.omittedFiles.map((file) => `${dir}/${file}`);
    notes.push(
      `Left out ${paths.length} file(s) to stay within ${output.maxChars ?? DEFAULT_MAX_CHARS} chars; ` +
        `call again on one of them or a narrower path: ${paths.join(', ')}`,
    );
  }
  if (output.moreFiles) {
    notes.push(
      `Stopped at maxFiles=${output.maxFiles ?? ''}: the directory has more files. Narrow the path or raise maxFiles.`,
    );
  }
  return [summary, ...notes, '', output.skeleton].join('\n');
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
  // A skeleton is structural source data: dropping its middle can hide declarations
  // and make downstream analysis incorrect. A directory result is bounded at a file
  // boundary by maxFiles and maxChars, so preserve it whole for the model.
  preserveFullOutput: true,
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
        type: 'integer',
        description: 'Max files to include if path is a directory (defaults to 20, max 50).',
        minimum: 1,
        maximum: 50,
      },
      maxChars: {
        type: 'integer',
        description:
          'Character budget for a directory skeleton (defaults to 60000, max 200000). Files past it are listed, not cut.',
        minimum: 2_000,
        maximum: MAX_MAX_CHARS,
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  serialize(output) {
    return renderSkeleton(output);
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
      const maxFiles = boundedInt(input.maxFiles, 20, 1, 50);
      const maxChars = boundedInt(input.maxChars, DEFAULT_MAX_CHARS, 2_000, MAX_MAX_CHARS);
      const dirResult = await extractDirectorySkeleton({
        dirPath: targetPath,
        maxFiles,
        maxChars,
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
        // Each file's skeleton and symbol ranges are already in `skeleton`
        // (with inline line ranges): carrying them twice doubled the result.
        files: dirResult.files.map(({ file, lang, stats }) => ({
          file: path.relative(targetPath, file).replace(/\\/g, '/'),
          lang,
          stats,
        })),
        ...(dirResult.omittedFiles.length > 0 ? { omittedFiles: dirResult.omittedFiles } : {}),
        ...(dirResult.moreFiles ? { moreFiles: true } : {}),
        maxFiles,
        maxChars,
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
