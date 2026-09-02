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

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import {
  BoundedMap,
  collectSourceFilesAsync,
  matchesExtension,
  withinProject,
} from '../runtime/index.js';

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

/**
 * How long to stay quiet about one path after warning about it. Also the
 * retention window for `state.lastHookWarning` — past this point an entry
 * cannot affect a decision, so keeping it is pure memory growth.
 */
const HOOK_WARNING_COOLDOWN_MS = 60_000;

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
  /**
   * Per-path cooldown timestamps, so a bulk edit does not repeat the same
   * warning for one file on every write.
   *
   * Bounded with a TTL matching the cooldown window: an entry older than
   * the cooldown can never change a decision again, but a plain `Map` kept
   * it for the life of the process — one entry per source file ever
   * touched, released only at teardown.
   */
  lastHookWarning: BoundedMap<string, number>;
}

const state: RefactorSuggesterState = {
  scanCount: 0,
  suggestionCount: 0,
  hookInvocationCount: 0,
  warningCount: 0,
  errorCount: 0,
  hookUnregister: null,
  lastHookWarning: new BoundedMap<string, number>({ max: 512, ttlMs: HOOK_WARNING_COOLDOWN_MS }),
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
  const rawLong =
    r['longFunctionLines'] ?? r['long_function_lines'] ?? r['maxLines'] ?? r['max_lines'];
  const rawParams = r['maxParams'] ?? r['max_params'];
  const rawNesting = r['maxNesting'] ?? r['max_nesting'] ?? r['nesting'];
  return {
    longFunctionLines:
      typeof rawLong === 'number' && rawLong >= 1 ? rawLong : DEFAULTS.rules.longFunctionLines,
    maxParams:
      typeof rawParams === 'number' && rawParams >= 1 ? rawParams : DEFAULTS.rules.maxParams,
    maxNesting:
      typeof rawNesting === 'number' && rawNesting >= 1 ? rawNesting : DEFAULTS.rules.maxNesting,
  };
}

function readConfig(raw: unknown): RefactorSuggesterConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawExts = r['extensions'] ?? r['file_extensions'] ?? r['fileExtensions'];
  const rawMax = r['maxSuggestions'] ?? r['max_suggestions'] ?? r['limit'];
  return {
    enabled: r['enabled'] === true,
    extensions: Array.isArray(rawExts)
      ? (rawExts as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.extensions,
    maxSuggestions:
      typeof rawMax === 'number' && rawMax >= 1 && rawMax <= 500 ? rawMax : DEFAULTS.maxSuggestions,
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

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function relativePath(p: string): string {
  return toPosix(relative(process.cwd(), p));
}

// ---------------------------------------------------------------------------
// Smell detection
// ---------------------------------------------------------------------------

function splitTopLevelParams(paramsRaw: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < paramsRaw.length; i++) {
    const ch = paramsRaw[i]!;
    if (ch === '(' || ch === '{' || ch === '[' || ch === '<') {
      depth++;
      current += ch;
    } else if (ch === ')' || ch === '}' || ch === ']' || ch === '>') {
      if (depth > 0) depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      if (current.trim().length > 0) result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) result.push(current.trim());
  return result;
}

function leadingIndentLevel(line: string): number {
  const leading = line.match(/^(\s*)/)?.[1] ?? '';
  const tabs = leading.split('\t').length - 1;
  const spaces = leading.replace(/\t/g, '').length;
  return tabs + Math.floor(spaces / 2);
}

function detectSmells(
  filePath: string,
  content: string,
  rules: RefactorRules,
): RefactorSuggestion[] {
  const suggestions: RefactorSuggestion[] = [];
  const lines = content.split(/\r?\n/);
  const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ' ');

  // Long functions and many parameters.
  const CONTROL_KEYWORDS = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'with',
    'typeof',
    'instanceof',
  ]);
  const functionLikeRe =
    /(?:export\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)\s*\{/g;
  functionLikeRe.lastIndex = 0;
  for (const match of stripped.matchAll(functionLikeRe)) {
    const name = match[1]!;
    if (CONTROL_KEYWORDS.has(name)) continue;
    const paramsRaw = match[2]!;
    const params = splitTopLevelParams(paramsRaw);
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

async function scanPath(
  rawPath: string,
  cfg: RefactorSuggesterConfig,
): Promise<{
  suggestions: RefactorSuggestion[];
  scannedFiles: number;
  /** Files discovered by the walk, whether or not they were opened. */
  discoveredFiles: number;
  /** True when `maxSuggestions` stopped the walk before every file was read. */
  truncated: boolean;
}> {
  const root = process.cwd();
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const exts = normalizeExtensions(cfg.extensions);
  const files = await collectSourceFilesAsync(resolved, { extensions: exts });
  const suggestions: RefactorSuggestion[] = [];
  // Count what was actually opened. Reporting the discovered total as
  // `scannedFiles` claimed credit for files the walk never reached once
  // the suggestions cap cut it short.
  let scannedFiles = 0;
  let truncated = false;
  for (const p of files) {
    try {
      const content = await readFile(p, 'utf-8');
      scannedFiles += 1;
      suggestions.push(...detectSmells(p, content, cfg.rules));
      if (suggestions.length >= cfg.maxSuggestions) {
        truncated = scannedFiles < files.length;
        break;
      }
    } catch {
      // skip unreadable
    }
  }
  return {
    suggestions: suggestions.slice(0, cfg.maxSuggestions),
    scannedFiles,
    discoveredFiles: files.length,
    truncated,
  };
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

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{
      decision?: 'block';
      reason?: string;
      additionalContext?: string;
      contextAs?: 'inline' | 'separate';
    } | void> => {
      if (!cfg.enabled) return;
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawPath =
        inp['path'] ??
        inp['filePath'] ??
        inp['file_path'] ??
        inp['TargetFile'] ??
        inp['targetFile'] ??
        inp['file'];
      const sourcePath = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : undefined;
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
      if (lastWarning !== undefined && now - lastWarning < HOOK_WARNING_COOLDOWN_MS) return;

      const resolved = resolve(process.cwd(), sourcePath);
      let content: string;
      try {
        content = await readFile(resolved, 'utf-8');
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

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, {
      background: true,
    });

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

        const raw = (input ?? {}) as Record<string, unknown>;
        const rawPath =
          (typeof input.path === 'string' && input.path.trim().length > 0
            ? input.path.trim()
            : undefined) ??
          (typeof raw['directory'] === 'string' ? raw['directory'] : undefined) ??
          (typeof raw['dir'] === 'string' ? raw['dir'] : undefined) ??
          (typeof raw['SearchDirectory'] === 'string' ? raw['SearchDirectory'] : undefined) ??
          (typeof raw['TargetFile'] === 'string' ? raw['TargetFile'] : undefined) ??
          (typeof raw['filePath'] === 'string' ? raw['filePath'] : undefined) ??
          (typeof raw['targetFile'] === 'string' ? raw['targetFile'] : undefined) ??
          '.';
        if (!withinProject(rawPath)) {
          return { ok: false, error: 'path is outside the project root' };
        }

        state.scanCount += 1;
        let result: Awaited<ReturnType<typeof scanPath>>;
        try {
          result = await scanPath(rawPath, cfg);
        } catch (err) {
          state.errorCount += 1;
          return { ok: false, error: String(err) };
        }
        state.suggestionCount += result.suggestions.length;

        return {
          ok: true,
          path: relativePath(resolve(process.cwd(), rawPath)),
          scannedFiles: result.scannedFiles,
          discoveredFiles: result.discoveredFiles,
          // Say so when the cap stopped the walk early: a partial scan
          // that reports few findings must not read as a clean result.
          truncated: result.truncated,
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
