/**
 * refactor-suggester plugin — regex-based smell detector that suggests
 * refactoring opportunities in source files.
 *
 * Tools registered:
 * - suggest_refactors : Scan a file or directory for smells.
 * - refactor_status : Report config + counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit` to source files, injecting
 *   suggestions for the changed file.
 *
 * Config (`config.extensions['refactor-suggester']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "extensions": [".ts", ".tsx", ".js", ".jsx"],
 *   "maxSuggestions": 20,
 *   "rules": { "longFunctionLines": 50, "maxParams": 5, "maxNesting": 3 }
 * }
 * ```
 *
 * @public
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core';
import { withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

export type SmellType =
  | 'long-function'
  | 'deep-nesting'
  | 'many-parameters'
  | 'magic-number'
  | 'console-log';

export interface RefactorSuggestion {
  file: string;
  line: number;
  type: SmellType;
  message: string;
}

interface RefactorSuggesterState {
  scanCount: number;
  suggestionCount: number;
  hookInvocationCount: number;
  warningCount: number;
  errorCount: number;
  hookUnregister: null | (() => void);
  lastHookWarning: Map<string, number>;
}

const state: RefactorSuggesterState = {
  scanCount: 0,
  suggestionCount: 0,
  hookInvocationCount: 0,
  warningCount: 0,
  errorCount: 0,
  hookUnregister: null,
  lastHookWarning: new Map(),
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface RefactorRules {
  longFunctionLines: number;
  maxParams: number;
  maxNesting: number;
}

interface RefactorSuggesterConfig {
  enabled: boolean;
  extensions: string[];
  maxSuggestions: number;
  rules: RefactorRules;
}

const DEFAULTS: RefactorSuggesterConfig = {
  enabled: false,
  extensions: ['.ts', '.tsx', '.js', '.jsx'],
  maxSuggestions: 5,
  rules: { longFunctionLines: 50, maxParams: 5, maxNesting: 3 },
};

function readRules(raw: unknown): RefactorRules {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS.rules };
  const r = raw as Record<string, unknown>;
  return {
    longFunctionLines:
      typeof r['longFunctionLines'] === 'number' && r['longFunctionLines'] >= 1
        ? r['longFunctionLines']
        : DEFAULTS.rules.longFunctionLines,
    maxParams:
      typeof r['maxParams'] === 'number' && r['maxParams'] >= 1 ? r['maxParams'] : DEFAULTS.rules.maxParams,
    maxNesting:
      typeof r['maxNesting'] === 'number' && r['maxNesting'] >= 1 ? r['maxNesting'] : DEFAULTS.rules.maxNesting,
  };
}

function readConfig(raw: unknown): RefactorSuggesterConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] === true,
    extensions: Array.isArray(r['extensions'])
      ? (r['extensions'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.extensions,
    maxSuggestions:
      typeof r['maxSuggestions'] === 'number' && r['maxSuggestions'] >= 1 && r['maxSuggestions'] <= 500
        ? r['maxSuggestions']
        : DEFAULTS.maxSuggestions,
    rules: readRules(r['rules']),
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// withinProject() imported from ../runtime/index.js

function normalizeExtensions(exts: string[]): string[] {
  return exts.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`));
}

function matchesExtension(p: string, exts: string[]): boolean {
  return exts.includes(extname(p).toLowerCase());
}

function collectSourceFiles(root: string, exts: string[]): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;
  const s = statSync(root);
  if (s.isFile()) {
    if (matchesExtension(root, exts)) files.push(root);
    return files;
  }
  if (!s.isDirectory()) return files;

  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === 'coverage') continue;
      const full = resolve(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && matchesExtension(full, exts)) {
        files.push(full);
      }
    }
  }

  walk(root);
  return files;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function relativePath(p: string): string {
  return toPosix(relative(process.cwd(), p));
}

// ---------------------------------------------------------------------------
// Smell detection
// ---------------------------------------------------------------------------

function leadingIndentLevel(line: string): number {
  const leading = line.match(/^(\s*)/)?.[1] ?? '';
  const tabs = leading.split('\t').length - 1;
  const spaces = leading.replace(/\t/g, '').length;
  return tabs + Math.floor(spaces / 2);
}

function detectSmells(filePath: string, content: string, rules: RefactorRules): RefactorSuggestion[] {
  const suggestions: RefactorSuggestion[] = [];
  const lines = content.split(/\r?\n/);
  const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ' ');

  // Long functions and many parameters.
  const functionLikeRe =
    /(?:export\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)\s*\{/g;
  functionLikeRe.lastIndex = 0;
  for (const match of stripped.matchAll(functionLikeRe)) {
    const name = match[1]!;
    const paramsRaw = match[2]!;
    const params = paramsRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (params.length > rules.maxParams) {
      suggestions.push({
        file: relativePath(filePath),
        line: content.slice(0, match.index).split(/\r?\n/).length,
        type: 'many-parameters',
        message: `${name} has ${params.length} parameters (limit ${rules.maxParams})`,
      });
    }

    const bodyStart = match.index + match[0].length;
    let depth = 1;
    let lineEnd = bodyStart;
    for (let i = bodyStart; i < stripped.length && depth > 0; i++) {
      const ch = stripped[i];
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      lineEnd = i;
    }
    const bodyLines = stripped.slice(bodyStart, lineEnd + 1).split(/\r?\n/).length;
    if (bodyLines > rules.longFunctionLines) {
      suggestions.push({
        file: relativePath(filePath),
        line: content.slice(0, match.index).split(/\r?\n/).length,
        type: 'long-function',
        message: `${name} spans ~${bodyLines} lines (limit ${rules.longFunctionLines})`,
      });
    }
  }

  // Deep nesting and console logging.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const strippedLine = line.replace(/\/\/.*$/, '');

    const level = leadingIndentLevel(line);
    if (level > rules.maxNesting) {
      suggestions.push({
        file: relativePath(filePath),
        line: lineNo,
        type: 'deep-nesting',
        message: `indentation level ${level} exceeds ${rules.maxNesting}`,
      });
    }

    if (/\bconsole\.(log|warn|error)\b/.test(strippedLine)) {
      suggestions.push({
        file: relativePath(filePath),
        line: lineNo,
        type: 'console-log',
        message: 'console.log/warn/error usage detected',
      });
    }
  }

  // Magic numbers.
  const magicRe = /\b-?\d+(?:\.\d+)?\b/g;
  const allowed = new Set(['0', '1', '-1', '2']);
  magicRe.lastIndex = 0;
  for (const magicNumberMatch of content.matchAll(magicRe)) {
    const match = magicNumberMatch[0]!;
    if (allowed.has(match)) continue;
    // Skip array indices like [42].
    const before = content[magicNumberMatch.index - 1];
    const after = content[magicNumberMatch.index + match.length];
    if (before === '[' && after === ']') continue;
    suggestions.push({
      file: relativePath(filePath),
      line: content.slice(0, magicNumberMatch.index).split(/\r?\n/).length,
      type: 'magic-number',
      message: `magic number ${match} should be a named constant`,
    });
  }

  return suggestions;
}

function scanPath(rawPath: string, cfg: RefactorSuggesterConfig): { suggestions: RefactorSuggestion[]; scannedFiles: number } {
  const root = process.cwd();
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const exts = normalizeExtensions(cfg.extensions);
  const files = collectSourceFiles(resolved, exts);
  const suggestions: RefactorSuggestion[] = [];
  for (const p of files) {
    try {
      const content = readFileSync(p, 'utf-8');
      suggestions.push(...detectSmells(p, content, cfg.rules));
      if (suggestions.length >= cfg.maxSuggestions) break;
    } catch {
      // skip unreadable
    }
  }
  return { suggestions: suggestions.slice(0, cfg.maxSuggestions), scannedFiles: files.length };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'refactor-suggester',
  version: '0.1.0',
  description: 'Suggests refactoring opportunities using regex-based smell detection',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: false, description: 'Master switch.' },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        default: ['.ts', '.tsx', '.js', '.jsx'],
        description: 'File extensions to scan.',
      },
      maxSuggestions: {
        type: 'number',
        minimum: 1,
        maximum: 500,
        default: 20,
        description: 'Maximum suggestions returned per scan.',
      },
      rules: {
        type: 'object',
        properties: {
          longFunctionLines: { type: 'number', minimum: 1, default: 50 },
          maxParams: { type: 'number', minimum: 1, default: 5 },
          maxNesting: { type: 'number', minimum: 1, default: 3 },
        },
      },
    },
  },

  setup(api) {
    state.scanCount = 0;
    state.suggestionCount = 0;
    state.hookInvocationCount = 0;
    state.warningCount = 0;
    state.errorCount = 0;
    state.lastHookWarning.clear();
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['refactor-suggester']);

    const hook = (
      input: {
        toolName?: string | undefined;
        toolInput?: unknown;
        toolResult?: { content: string; isError: boolean } | undefined;
      },
    ): { decision?: 'block'; reason?: string; additionalContext?: string; contextAs?: 'inline' | 'separate' } | void => {
      if (!cfg.enabled) return;
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const sourcePath = inp['path'] as string | undefined;
      if (!sourcePath || typeof sourcePath !== 'string') return;
      if (!withinProject(sourcePath)) return;

      const exts = normalizeExtensions(cfg.extensions);
      if (!matchesExtension(sourcePath, exts)) return;

      state.hookInvocationCount += 1;

      // Throttle repeated warnings for the same file within one minute.
      // Bulk tools like `replace` can touch many files in quick succession;
      // we still report the total count, but we don't repeat the same message
      // for the same file on every edit.
      const now = Date.now();
      const lastWarning = state.lastHookWarning.get(sourcePath);
      if (lastWarning !== undefined && now - lastWarning < 60_000) return;

      const resolved = resolve(process.cwd(), sourcePath);
      let content: string;
      try {
        content = readFileSync(resolved, 'utf-8');
      } catch {
        state.errorCount += 1;
        return;
      }

      const suggestions = detectSmells(resolved, content, cfg.rules);
      if (suggestions.length === 0) return;

      state.warningCount += suggestions.length;
      state.lastHookWarning.set(sourcePath, now);
      return {
        additionalContext:
          `🔧 refactor-suggester: ${suggestions.length} suggestion(s) for ${sourcePath}. ` +
          `Run suggest_refactors for the full list.`,
        contextAs: 'separate',
      };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, { background: true });

    // --- suggest_refactors tool ---
    api.tools.register({
      name: 'suggest_refactors',
      description:
        'Scan source files for refactoring smells: long functions, deep nesting, many parameters, magic numbers, and console logging.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', default: '.', description: 'File or directory path to scan.' },
        },
      },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute(input: { path?: string }) {
        if (!cfg.enabled) return { ok: false, error: 'refactor-suggester is disabled' };

        const rawPath = typeof input.path === 'string' ? input.path : '.';
        if (!withinProject(rawPath)) {
          return { ok: false, error: 'path is outside the project root' };
        }

        state.scanCount += 1;
        let result: { suggestions: RefactorSuggestion[]; scannedFiles: number };
        try {
          result = scanPath(rawPath, cfg);
        } catch (err) {
          state.errorCount += 1;
          return { ok: false, error: String(err) };
        }
        state.suggestionCount += result.suggestions.length;

        return {
          ok: true,
          path: relativePath(resolve(process.cwd(), rawPath)),
          scannedFiles: result.scannedFiles,
          suggestions: result.suggestions,
          rules: cfg.rules,
        };
      },
    });

    // --- refactor_status tool ---
    api.tools.register({
      name: 'refactor_status',
      description: 'Reports refactor-suggester state: config + counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          extensions: cfg.extensions,
          maxSuggestions: cfg.maxSuggestions,
          rules: cfg.rules,
          counters: {
            scans: state.scanCount,
            suggestions: state.suggestionCount,
            hookInvocations: state.hookInvocationCount,
            warnings: state.warningCount,
            errors: state.errorCount,
          },
        };
      },
    });

    api.log.info('refactor-suggester plugin loaded', {
      version: '0.1.0',
      rules: cfg.rules,
      extensions: cfg.extensions,
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
      scans: state.scanCount,
      suggestions: state.suggestionCount,
      hookInvocations: state.hookInvocationCount,
      warnings: state.warningCount,
      errors: state.errorCount,
    };
    state.scanCount = 0;
    state.suggestionCount = 0;
    state.hookInvocationCount = 0;
    state.warningCount = 0;
    state.errorCount = 0;
    state.lastHookWarning.clear();
    api.log.info('refactor-suggester: teardown complete', { final });
  },

  async health() {
    return {
      ok: state.errorCount === 0,
      message: state.errorCount
        ? `refactor-suggester: ${state.errorCount} error(s)`
        : `refactor-suggester: ${state.scanCount} scan(s), ${state.suggestionCount} suggestion(s)`,
      counters: {
        scans: state.scanCount,
        suggestions: state.suggestionCount,
        hookInvocations: state.hookInvocationCount,
        warnings: state.warningCount,
        errors: state.errorCount,
      },
    };
  },
};

export default plugin;
