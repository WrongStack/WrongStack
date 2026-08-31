/**
 * code-metrics plugin — lightweight per-file code metrics using regex-based
 * line counting and complexity heuristics.
 *
 * Tools registered:
 * - measure_code_metrics : Compute lines, comments, blanks, function count,
 *   and cyclomatic-complexity-like score for a file or directory.
 * - metrics_status : Report config + counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit` to source files, injecting a
 *   one-line metric summary of the changed file.
 *
 * Config (`config.extensions['code-metrics']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "extensions": [".ts", ".tsx", ".js", ".jsx"],
 *   "maxFiles": 50
 * }
 * ```
 *
 * @public
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { collectSourceFilesAsync, matchesExtension, withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface FileMetrics {
  file: string;
  lines: number;
  codeLines: number;
  commentLines: number;
  blankLines: number;
  functionCount: number;
  complexity: number;
}

interface CodeMetricsState {
  measureCount: number;
  fileCount: number;
  hookInvocationCount: number;
  errorCount: number;
  hookUnregister: null | (() => void);
}

const state: CodeMetricsState = {
  measureCount: 0,
  fileCount: 0,
  hookInvocationCount: 0,
  errorCount: 0,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface CodeMetricsConfig {
  enabled: boolean;
  extensions: string[];
  maxFiles: number;
}

const DEFAULTS: CodeMetricsConfig = {
  enabled: false,
  extensions: ['.ts', '.tsx', '.js', '.jsx'],
  maxFiles: 50,
};

function readConfig(raw: unknown): CodeMetricsConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawExts = r['extensions'] ?? r['file_extensions'] ?? r['fileExtensions'];
  const rawMax = r['maxFiles'] ?? r['max_files'] ?? r['limit'];
  return {
    enabled: r['enabled'] !== false,
    extensions: Array.isArray(rawExts)
      ? (rawExts as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.extensions,
    maxFiles:
      typeof rawMax === 'number' && rawMax >= 1 && rawMax <= 500
        ? rawMax
        : DEFAULTS.maxFiles,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// withinProject() imported from ../runtime/index.js

function normalizeExtensions(exts: string[]): string[] {
  return exts.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`));
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function relativePath(p: string): string {
  return toPosix(relative(process.cwd(), p));
}

// ---------------------------------------------------------------------------
// Metrics computation
// ---------------------------------------------------------------------------

function countFunctions(content: string): number {
  let count = 0;
  const declRe = /\bfunction\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(/g;
  const methodRe = /\b[A-Za-z_$][A-Za-z0-9_$]*\s*\([^)]*\)\s*\{/g;
  const arrowRe = /=>\s*(?:\{|\(|[^\s;{}])/g;

  declRe.lastIndex = 0;
  for (const _match of content.matchAll(declRe)) count++;

  methodRe.lastIndex = 0;
  for (const match of content.matchAll(methodRe)) {
    // Avoid double-counting function declarations already matched above.
    const prefix = content.slice(0, match.index).trimEnd();
    if (/\bfunction\s*$/.test(prefix)) continue;
    count++;
  }

  arrowRe.lastIndex = 0;
  for (const _match of content.matchAll(arrowRe)) count++;

  return count;
}

/**
 * Heuristic cyclomatic-complexity formula (per file, not per function):
 *   control keywords (if | else if | for | while | switch | catch)
 *   + short-circuit / nullish operators (&& || ??)
 *   + assignment-or operators (||= &&= ??=)
 *   + ternary `?`
 * Optional chaining (`?.`) is not a decision point — `a?.b ?? c` adds 1.
 */
export const COMPLEXITY_FORMULA =
  'control(if|else if|for|while|switch|catch) + (&& || ?? ||= &&= ??=) + ternary ?; optional chaining ?. is not counted';

function stripNonExecutable(code: string): string {
  return code
    // Remove multi-line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Remove single-line comments
    .replace(/\/\/[^\n]*/g, ' ')
    // Remove string literals (single, double, template)
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, ' ')
    // Remove TypeScript optional property annotations (e.g. `foo?: string`)
    .replace(/\b[A-Za-z_$][A-Za-z0-9_$]*\s*\?\s*:/g, ' ');
}

function countComplexity(content: string): number {
  const code = stripNonExecutable(content);
  const controlRe = /\b(if|else\s+if|for|while|switch|catch)\b/g;
  let complexity = 0;

  controlRe.lastIndex = 0;
  for (const _match of code.matchAll(controlRe)) complexity++;

  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    const n1 = code[i + 1];
    const n2 = code[i + 2];
    if (c === '?' && n1 === '?' && n2 === '=') {
      complexity++;
      i += 2;
      continue;
    }
    if ((c === '|' && n1 === '|' && n2 === '=') || (c === '&' && n1 === '&' && n2 === '=')) {
      complexity++;
      i += 2;
      continue;
    }
    if ((c === '?' && n1 === '?') || (c === '|' && n1 === '|') || (c === '&' && n1 === '&')) {
      complexity++;
      i += 1;
      continue;
    }
    if (c === '?' && n1 === '.') {
      i += 1;
      continue;
    }
    if (c === '?') complexity++;
  }

  return complexity;
}

function analyzeFile(filePath: string, content: string): FileMetrics {
  if (content.length === 0) {
    return {
      file: relativePath(filePath),
      lines: 0,
      codeLines: 0,
      commentLines: 0,
      blankLines: 0,
      functionCount: 0,
      complexity: 0,
    };
  }

  const lines = content.split(/\r?\n/);
  let codeLines = 0;
  let commentLines = 0;
  let blankLines = 0;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) {
      blankLines++;
      continue;
    }

    // Shebang is neither source nor a comment; do not inflate codeLines.
    if (i === 0 && line.startsWith('#!')) {
      continue;
    }

    if (inBlockComment) {
      commentLines++;
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }

    if (line.startsWith('//')) {
      commentLines++;
      continue;
    }

    if (line.startsWith('/*')) {
      commentLines++;
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }

    codeLines++;
  }

  return {
    file: relativePath(filePath),
    lines: lines.length,
    codeLines,
    commentLines,
    blankLines,
    functionCount: countFunctions(content),
    complexity: countComplexity(content),
  };
}

async function measurePath(
  rawPath: string,
  cfg: CodeMetricsConfig,
): Promise<{ files: FileMetrics[]; totalFiles: number }> {
  const root = process.cwd();
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const exts = normalizeExtensions(cfg.extensions);
  const allFiles = await collectSourceFilesAsync(resolved, { extensions: exts });
  const files = allFiles.slice(0, cfg.maxFiles);
  const metrics: FileMetrics[] = [];
  for (const p of files) {
    try {
      const content = await readFile(p, 'utf-8');
      metrics.push(analyzeFile(p, content));
    } catch {
      // skip unreadable
    }
  }
  return { files: metrics, totalFiles: allFiles.length };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'code-metrics',
  version: '0.1.0',
  description: 'Computes per-file line counts, function counts, and cyclomatic-complexity-like scores',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        default: ['.ts', '.tsx', '.js', '.jsx'],
        description: 'File extensions to measure.',
      },
      maxFiles: {
        type: 'number',
        minimum: 1,
        maximum: 500,
        default: 50,
        description: 'Maximum files measured in a directory scan.',
      },
    },
  },

  setup(api) {
    state.measureCount = 0;
    state.fileCount = 0;
    state.hookInvocationCount = 0;
    state.errorCount = 0;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['code-metrics']);

    const hook = async (
      input: {
        toolName?: string | undefined;
        toolInput?: unknown;
        toolResult?: { content: string; isError: boolean } | undefined;
      },
    ): Promise<{ decision?: 'block'; reason?: string; additionalContext?: string } | void> => {
      if (!cfg.enabled) return;
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawSource =
        inp['path'] ??
        inp['TargetFile'] ??
        inp['filePath'] ??
        inp['targetFile'] ??
        inp['file_path'] ??
        inp['destination'] ??
        inp['file'];
      const sourcePath = typeof rawSource === 'string' ? rawSource : undefined;
      if (!sourcePath || typeof sourcePath !== 'string') return;
      if (!withinProject(sourcePath)) return;

      const exts = normalizeExtensions(cfg.extensions);
      if (!matchesExtension(sourcePath, exts)) return;

      state.hookInvocationCount += 1;

      const resolved = resolve(process.cwd(), sourcePath);
      let content: string;
      try {
        content = await readFile(resolved, 'utf-8');
      } catch {
        state.errorCount += 1;
        return;
      }

      const metrics = analyzeFile(resolved, content);
      return {
        additionalContext:
          `\n📊 code-metrics: ${relativePath(resolved)} — ${metrics.lines} lines ` +
          `(${metrics.codeLines} code, ${metrics.commentLines} comments, ${metrics.blankLines} blank), ` +
          `${metrics.functionCount} function(s), complexity ${metrics.complexity}.`,
      };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, { background: true });

    // --- measure_code_metrics tool ---
    api.tools.register({
      name: 'measure_code_metrics',
      description:
        'Measure lines, comments, blank lines, function count, and cyclomatic-complexity-like score for a source file or directory.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', default: '.', description: 'File or directory path to measure.' },
        },
      },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute(input: { path?: string }) {
        if (!cfg.enabled) return { ok: false, error: 'code-metrics is disabled' };

        const raw = (input ?? {}) as Record<string, unknown>;
        const rawPath =
          (typeof input.path === 'string' && input.path.trim().length > 0 ? input.path.trim() : undefined) ??
          (typeof raw['directory'] === 'string' ? raw['directory'] : undefined) ??
          (typeof raw['dir'] === 'string' ? raw['dir'] : undefined) ??
          (typeof raw['SearchDirectory'] === 'string' ? raw['SearchDirectory'] : undefined) ??
          (typeof raw['filePath'] === 'string' ? raw['filePath'] : undefined) ??
          (typeof raw['TargetFile'] === 'string' ? raw['TargetFile'] : undefined) ??
          (typeof raw['targetFile'] === 'string' ? raw['targetFile'] : undefined) ??
          (typeof raw['file_path'] === 'string' ? raw['file_path'] : undefined) ??
          (typeof raw['file'] === 'string' ? raw['file'] : undefined) ??
          '.';
        if (!withinProject(rawPath)) {
          return { ok: false, error: 'path is outside the project root' };
        }

        state.measureCount += 1;
        let result: { files: FileMetrics[]; totalFiles: number };
        try {
          result = await measurePath(rawPath, cfg);
        } catch (err) {
          state.errorCount += 1;
          return { ok: false, error: String(err) };
        }
        state.fileCount += result.files.length;

        return {
          ok: true,
          path: relativePath(resolve(process.cwd(), rawPath)),
          files: result.files,
          totalFiles: result.totalFiles,
          capped: result.totalFiles > cfg.maxFiles,
        };
      },
    });

    // --- metrics_status tool ---
    api.tools.register({
      name: 'metrics_status',
      description: 'Reports code-metrics state: config + counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          extensions: cfg.extensions,
          maxFiles: cfg.maxFiles,
          counters: {
            measures: state.measureCount,
            files: state.fileCount,
            hookInvocations: state.hookInvocationCount,
            errors: state.errorCount,
          },
          complexityFormula: COMPLEXITY_FORMULA,
        };
      },
    });

    api.log.info('code-metrics plugin loaded', {
      version: '0.1.0',
      extensions: cfg.extensions,
      maxFiles: cfg.maxFiles,
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      measures: state.measureCount,
      files: state.fileCount,
      hookInvocations: state.hookInvocationCount,
      errors: state.errorCount,
    };
    state.measureCount = 0;
    state.fileCount = 0;
    state.hookInvocationCount = 0;
    state.errorCount = 0;
    api.log.info('code-metrics: teardown complete', { final });
  },

  async health() {
    return {
      ok: state.errorCount === 0,
      message: state.errorCount
        ? `code-metrics: ${state.errorCount} error(s)`
        : `code-metrics: ${state.measureCount} measurement(s), ${state.fileCount} file(s)`,
      counters: {
        measures: state.measureCount,
        files: state.fileCount,
        hookInvocations: state.hookInvocationCount,
        errors: state.errorCount,
      },
    };
  },
};

export default plugin;
