/**
 * `codebase-read-symbol` tool — read a function, method, class, or declaration via AST.
 *
 * Usage: codebase-read-symbol({
 *   file: string,             // relative or absolute file path
 *   symbol: string,           // name of the function, method, or declaration to inspect
 *   includeDocs?: boolean,    // preserve JSDoc / docstrings (default: true)
 *   target?: 'full' | 'body', // whether to read the full declaration (default) or only the inner body
 * })
 */

import { type Tool, ToolValidationError } from '@wrongstack/core/types';
import { safeResolveProjectPath } from '../_util.js';
import { readSymbolInFile } from './ast-symbol-reader.js';

export interface CodebaseReadSymbolInput {
  /** Target file path (relative to project root or absolute within project). */
  file: string;
  /**
   * Declaration name (function, method, class, interface, type, enum, variable).
   * Qualify nested members as "ClassName.method" when the bare name is ambiguous.
   */
  symbol: string;
  /** Keep leading JSDoc / docstrings / decorators in the output (defaults to true). */
  includeDocs?: boolean | undefined;
  /** Whether to read the complete declaration ('full', default) or only the inner block ('body'). */
  target?: 'full' | 'body' | undefined;
}

export interface CodebaseReadSymbolOutput {
  file: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  /** Numbered source code in standard `N→content` display format. */
  text: string;
}

export const codebaseReadSymbolTool: Tool<CodebaseReadSymbolInput, CodebaseReadSymbolOutput> = {
  name: 'codebase-read-symbol',
  category: 'Filesystem',
  icon: 'file',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  preserveFullOutput: true,
  timeoutMs: 15_000,
  description:
    'Read the exact implementation of a named declaration (function, method, class, interface, type, enum, variable) from a file using AST parsing. ' +
    'Returns line-numbered code in standard `N→content` format with exact start and end line numbers, eliminating offset guessing and saving context tokens.',
  usageHint:
    'SURGICAL AST CODE READING:\n\n' +
    '- Prefer this over `read` when you already know the symbol name (e.g. from `codebase-search` or `codebase-skeleton`).\n' +
    '- Returns exact line bounds (`startLine` and `endLine`) and line-numbered source (`N→content`).\n' +
    '- Eliminates guessing `offset` and `limit` for multi-line declarations.\n' +
    '- Leading docstrings and JSDoc are included by default (`includeDocs: true`). Set `includeDocs: false` to skip them.\n' +
    '- To read only the inner body block without signature, set `target: "body"`.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Target file path (relative to project root or absolute within project).',
      },
      symbol: {
        type: 'string',
        description:
          'Declaration name (function, method, class, interface, type, enum, variable). ' +
          'Qualify nested members as "ClassName.method" when the bare name is ambiguous. Not a test-case title.',
      },
      includeDocs: {
        type: 'boolean',
        description: 'Keep leading JSDoc / docstrings in the output (defaults to true).',
      },
      target: {
        type: 'string',
        enum: ['full', 'body'],
        description:
          "Whether to read the full declaration ('full', default) or only the inner block ('body').",
      },
    },
    required: ['file', 'symbol'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      symbol: { type: 'string' },
      kind: { type: 'string' },
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
      totalLines: { type: 'integer', minimum: 0 },
      text: { type: 'string', description: 'Numbered lines in standard N→content format.' },
    },
    required: ['file', 'symbol', 'kind', 'startLine', 'endLine', 'totalLines', 'text'],
  },
  async execute(input, ctx, execOpts) {
    if (!input?.file || typeof input.file !== 'string' || !input.file.trim()) {
      throw new ToolValidationError({
        message: 'codebase-read-symbol: file is required and must be a non-empty string',
        field: 'file',
      });
    }
    if (!input?.symbol || typeof input.symbol !== 'string' || !input.symbol.trim()) {
      throw new ToolValidationError({
        message: 'codebase-read-symbol: symbol is required and must be a non-empty string',
        field: 'symbol',
      });
    }
    if (input.target !== undefined && input.target !== 'full' && input.target !== 'body') {
      throw new ToolValidationError({
        message: `codebase-read-symbol: target must be "full" or "body", got ${JSON.stringify(input.target)}`,
        field: 'target',
      });
    }

    const signal = execOpts?.signal ?? ctx?.signal;
    signal?.throwIfAborted();

    const projectRoot = ctx.projectRoot ?? ctx.cwd ?? process.cwd();
    const file = await safeResolveProjectPath(input.file, ctx);

    const result = await readSymbolInFile(
      {
        file,
        symbol: input.symbol.trim(),
        includeDocs: input.includeDocs,
        target: input.target,
      },
      projectRoot,
    );

    // Keep the programmatic reader's raw source out of model-visible output.
    return {
      file: result.file,
      symbol: result.symbol,
      kind: result.kind,
      startLine: result.startLine,
      endLine: result.endLine,
      totalLines: result.totalLines,
      text: result.text,
    };
  },
};
