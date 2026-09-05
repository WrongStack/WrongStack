/**
 * `codebase-invariant-check` tool — deterministic backward-compatibility & invariant audit.
 *
 * Allows agents, auditors, and workflows to pre-screen candidate code modifications
 * or compare file versions to identify breaking changes across TypeScript, Python, Go, Rust, etc.
 */

import * as fs from 'node:fs/promises';
import type { Tool } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { safeResolveProjectPath } from '../_util.js';
import { type InvariantViolation, polyglotInvariantEngine } from './ast-invariant-engine.js';
import { detectLang } from './languages.js';
import type { SymbolLang } from './schema.js';

export interface CodebaseInvariantCheckInput {
  file?: string | undefined;
  originalCode?: string | undefined;
  modifiedCode: string;
  lang?: SymbolLang | undefined;
}

export interface CodebaseInvariantCheckOutput {
  valid: boolean;
  violations: InvariantViolation[];
  summary: string;
  error?: string | undefined;
}

export const codebaseInvariantCheckTool: Tool<
  CodebaseInvariantCheckInput,
  CodebaseInvariantCheckOutput
> = {
  name: 'codebase-invariant-check',
  category: 'Inspect',
  icon: 'index',
  permission: 'auto',
  subjectKey: 'file',
  mutating: false,
  capabilities: ['fs.read'],
  description:
    'Mathematically verify AST backward-compatibility invariants between original code and candidate mutations across TypeScript, Python, Go, Rust, Java, etc. ' +
    'Detects missing exports (INV-001), mandatory parameter additions (INV-002), interface breaking expansions (INV-003), and return type changes (INV-004) with zero hallucinations.',
  usageHint:
    'PRE-FLIGHT AST INVARIANT AUDIT:\n\n' +
    '- Provide `file` and `modifiedCode` (or both `originalCode` and `modifiedCode`).\n' +
    '- Returns `valid: true` if changes are strictly backward compatible.\n' +
    '- Returns structured `violations[]` with exact rule IDs, offending symbol names, and fix instructions.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Path to existing source file to compare against candidate modifications.',
      },
      originalCode: {
        type: 'string',
        description: 'Original source code string (if not reading from an existing file).',
      },
      modifiedCode: {
        type: 'string',
        description: 'The candidate modified code string to validate.',
      },
      lang: {
        type: 'string',
        description: 'Language hint (ts, py, go, rs, etc.). Inferred from file path if omitted.',
      },
    },
    required: ['modifiedCode'],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    try {
      let originalCode = input.originalCode;
      let lang = input.lang;

      if (!originalCode && input.file) {
        // H-5 (security report VF-06 family): shared realpath containment
        // instead of a bare isAbsolute passthrough — same gap as the
        // skeleton tool, same fix (project-root-relative contract kept).
        const resolved = await safeResolveProjectPath(input.file, ctx);
        originalCode = await fs.readFile(resolved, 'utf8');
        if (!lang) {
          lang = detectLang(resolved) ?? 'ts';
        }
      }

      if (originalCode === undefined) {
        return {
          valid: false,
          violations: [],
          summary: 'Neither originalCode nor file was provided for invariant comparison.',
          error: 'Missing originalCode or file path.',
        };
      }

      const res = await polyglotInvariantEngine.evaluate({
        originalCode,
        modifiedCode: input.modifiedCode,
        lang,
        filePath: input.file,
      });

      const summary = res.valid
        ? 'AST Invariants PASSED. Mutation is 100% backward compatible.'
        : `AST Invariants FAILED with ${res.violations.length} violation(s):\n` +
          res.violations.map((v) => ` - [${v.ruleId}] ${v.symbolName}: ${v.message}`).join('\n');

      return {
        valid: res.valid,
        violations: res.violations,
        summary,
      };
    } catch (err) {
      return {
        valid: false,
        violations: [],
        summary: `Error during invariant evaluation: ${toErrorMessage(err)}`,
        error: toErrorMessage(err),
      };
    }
  },
};
