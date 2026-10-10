/**
 * `codebase-invariant-check` tool — deterministic backward-compatibility & invariant audit.
 *
 * Allows agents, auditors, and workflows to pre-screen candidate code modifications
 * or compare file versions to identify breaking changes across TypeScript, Python, Go, Rust, etc.
 */

import * as fs from 'node:fs/promises';
import { type Tool, ToolValidationError } from '@wrongstack/core/types';
import { safeResolveProjectPath } from '../_util.js';
import { type InvariantViolation, polyglotInvariantEngine } from './ast-invariant-engine.js';
import { detectLang, EXT_TO_LANG } from './languages.js';
import type { SymbolLang } from './schema.js';

const KNOWN_LANGS: ReadonlySet<string> = new Set<string>([...Object.values(EXT_TO_LANG), 'other']);

export interface CodebaseInvariantCheckInput {
  file?: string | undefined;
  originalCode?: string | undefined;
  modifiedCode: string;
  lang?: SymbolLang | undefined;
}

export interface CodebaseInvariantCheckOutput {
  valid: boolean;
  /** False when the language has no invariant rules — `valid` then proves nothing. */
  verified: boolean;
  violations: InvariantViolation[];
  summary: string;
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
    'Deterministically check AST backward-compatibility invariants between original code and a candidate mutation for TypeScript/JavaScript, Python, Go and Rust. ' +
    'Detects removed exports (INV-001), mandatory parameter additions (INV-002), interface breaking expansions (INV-003), and incompatible return type changes (INV-004). ' +
    'Other languages return `verified: false`.',
  usageHint:
    'PRE-FLIGHT AST INVARIANT AUDIT:\n\n' +
    '- Provide `file` and `modifiedCode` (or both `originalCode` and `modifiedCode`).\n' +
    '- Returns `valid: true` when no rule was violated; check `verified` — it is false for languages without rules.\n' +
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
  serialize(output) {
    // Failed checks already carry every violation in structured form. Keep
    // unsupported-language guidance, which contains information absent there.
    const { summary, ...details } = output;
    return JSON.stringify(
      output.verified && !output.valid && output.violations.length > 0
        ? details
        : { ...details, summary },
    );
  },
  // Failures THROW. The old catch returned `valid: false` — a successful call
  // (is_error:false) whose payload was indistinguishable from "this change
  // breaks compatibility", so an unreadable file read as a real violation.
  async execute(input, ctx) {
    if (typeof input?.modifiedCode !== 'string') {
      throw new ToolValidationError({
        message: 'codebase-invariant-check: modifiedCode must be a string.',
        field: 'modifiedCode',
      });
    }
    if (input.lang !== undefined && !KNOWN_LANGS.has(input.lang)) {
      // An unknown hint used to flow straight into the engine, which then
      // compared contracts with the wrong extractor and reported PASSED.
      throw new ToolValidationError({
        message: `codebase-invariant-check: unknown lang "${String(input.lang)}". Valid ids: ${[...KNOWN_LANGS].sort().join(', ')}.`,
        field: 'lang',
      });
    }

    let originalCode = input.originalCode;
    let lang = input.lang;

    // `=== undefined`, not falsy: an explicit empty `originalCode` (a brand-new
    // file) is a real baseline and must not be silently replaced by the file
    // on disk.
    if (originalCode === undefined && input.file) {
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
      throw new ToolValidationError({
        message: 'Neither originalCode nor file was provided for invariant comparison.',
        field: 'originalCode',
      });
    }

    const res = await polyglotInvariantEngine.evaluate({
      originalCode,
      modifiedCode: input.modifiedCode,
      lang,
      filePath: input.file,
    });

    // An unsupported language yields zero violations because nothing was
    // extracted — reporting that as "100% backward compatible" was false.
    const summary = !res.supported
      ? `AST Invariants NOT VERIFIED: no invariant rules exist for '${res.lang}' (supported: ts, tsx, js, jsx, py, go, rs). Review compatibility manually.`
      : res.valid
        ? 'AST Invariants PASSED. No export removal, mandatory parameter/property addition, or incompatible return type change detected.'
        : `AST Invariants FAILED with ${res.violations.length} violation(s):\n` +
          res.violations.map((v) => ` - [${v.ruleId}] ${v.symbolName}: ${v.message}`).join('\n');

    return {
      valid: res.valid,
      verified: res.supported,
      violations: res.violations,
      summary,
    };
  },
};
