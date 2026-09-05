/**
 * `codebase-ast-replace` tool — surgically replace a function, method, or class body via AST.
 *
 * Usage: codebase-ast-replace({
 *   file: string,             // relative or absolute file path
 *   symbol: string,           // name of the function, method, or declaration to mutate
 *   newBody: string,          // new implementation code
 *   target?: 'body' | 'full', // whether to replace only the body (default) or the full declaration
 * })
 */

import * as path from 'node:path';
import type { Tool } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { safeResolveProjectPath } from '../_util.js';
import { type MutateSymbolOptions, replaceSymbolInFile } from './ast-symbol-mutator.js';

export interface CodebaseAstReplaceInput extends MutateSymbolOptions {}

export interface CodebaseAstReplaceOutput {
  status: 'ok' | 'error';
  file: string;
  symbol: string;
  originalRange?: { startLine: number; endLine: number } | undefined;
  newRange?: { startLine: number; endLine: number } | undefined;
  violations?: string[] | undefined;
  error?: string | undefined;
}

export const codebaseAstReplaceTool: Tool<CodebaseAstReplaceInput, CodebaseAstReplaceOutput> = {
  name: 'codebase-ast-replace',
  category: 'Edit',
  icon: 'edit',
  permission: 'confirm',
  subjectKey: 'file',
  mutating: true,
  capabilities: ['fs.write', 'fs.read'],
  description:
    'Surgically replace the implementation body or full definition of a function, method, class, or type alias using AST parsing. ' +
    'Guarantees zero string-matching errors, regex escape bugs, or whitespace indentation mismatches. ' +
    'Automatically verifies AST backward-compatibility invariants (no mandatory param addition, no export deletion, no interface breaking).',
  usageHint:
    'SURGICAL AST-BASED CODE EDITING:\n\n' +
    '- Use when updating an existing function, method, or class without worrying about context lines.\n' +
    '- Pass `symbol: "calculateTotal"` and `newBody: "return items.reduce(...);"`.\n' +
    '- Default `target: "body"` replaces only the inner `{ ... }` block while preserving the signature and JSDoc.\n' +
    '- Use `target: "full"` if you also need to modify the function parameters or return type.\n' +
    '- Setting `allowBreakingChanges: true` bypasses the invariant engine if breaking changes are deliberate.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Target file path (relative to project root or absolute).',
      },
      symbol: {
        type: 'string',
        description: 'Name of the function, method, class, interface, or variable to replace.',
      },
      newBody: {
        type: 'string',
        description: 'The new body implementation (or complete declaration if target="full").',
      },
      target: {
        type: 'string',
        enum: ['body', 'full'],
        description:
          "Whether to replace only the inner body ('body', default) or the entire symbol declaration ('full').",
      },
      checkInvariants: {
        type: 'boolean',
        description:
          'Whether to check AST backward-compatibility invariants before write. Defaults to true.',
      },
      allowBreakingChanges: {
        type: 'boolean',
        description:
          'Explicitly allow breaking changes (e.g. adding mandatory parameter, removing export) if intentional.',
      },
    },
    required: ['file', 'symbol', 'newBody'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    try {
      const projectRoot = ctx.projectRoot ?? ctx.cwd ?? process.cwd();
      // H-5 (security report VF-07): this was the only MUTATING file tool that
      // resolved its target with a bare isAbsolute passthrough — an absolute
      // or ../ path wrote outside the project root (unprompted under YOLO).
      // safeResolveProjectPath keeps the project-root-relative contract while
      // enforcing containment; the mutator then receives an already-canonical
      // absolute path.
      const file = await safeResolveProjectPath(input.file, ctx);
      const result = await replaceSymbolInFile({ ...input, file }, projectRoot);

      return {
        status: 'ok',
        file: path.relative(projectRoot, result.file).replace(/\\/g, '/'),
        symbol: result.symbol,
        originalRange: result.originalRange,
        newRange: result.newRange,
        violations: result.violations?.map((v) => `[${v.ruleId}] ${v.message}`),
      };
    } catch (err) {
      return {
        status: 'error',
        file: input.file,
        symbol: input.symbol,
        error: toErrorMessage(err),
      };
    }
  },
};
