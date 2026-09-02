/**
 * api-compatibility-gate plugin — guards public API surface changes.
 *
 * Registers a PostToolUse hook on `write|edit` to entry-point files
 * (`index.ts`, `src/index.ts`, or package `main`/`module`/`exports`
 * targets). For each such edit it reads the previous version from git
 * (`git show HEAD:<path>`), parses exported identifiers with simple
 * regex heuristics, and reports any removed exports as breaking changes.
 *
 * Tools registered:
 * - api_compat_status : Show config + per-session counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit`.
 *
 * Config (`config.extensions['api-compatibility-gate']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "severity": "warn",          // "warn" | "block"
 *   "entryPointPatterns": [      // glob-style patterns
 *     "**&#47;index.ts",
 *     "**&#47;index.js",
 *     "**&#47;src/index.ts"
 *   ],
 *   "trackGitHistory": true      // read pre-edit source from git
 * }
 * ```
 *
 * @public
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface ApiCompatibilityGateState {
  invocationCount: number;
  skippedCount: number;
  checkedCount: number;
  cleanCount: number;
  breakingCount: number;
  errorCount: number;
  lastResult: {
    filePath: string;
    removed: string[];
    added: string[];
    when: string;
  } | null;
  hookUnregister: null | (() => void);
}

const state: ApiCompatibilityGateState = {
  invocationCount: 0,
  skippedCount: 0,
  checkedCount: 0,
  cleanCount: 0,
  breakingCount: 0,
  errorCount: 0,
  lastResult: null,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ApiCompatibilityGateConfig {
  enabled: boolean;
  severity: 'warn' | 'block';
  entryPointPatterns: string[];
  trackGitHistory: boolean;
}

const DEFAULTS: ApiCompatibilityGateConfig = {
  enabled: false,
  severity: 'warn',
  entryPointPatterns: ['**/index.ts', '**/index.js', '**/src/index.ts', 'src/index.ts'],
  trackGitHistory: true,
};

function readConfig(raw: unknown): ApiCompatibilityGateConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    severity: r['severity'] === 'block' ? 'block' : DEFAULTS.severity,
    entryPointPatterns: Array.isArray(r['entryPointPatterns'])
      ? (r['entryPointPatterns'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.entryPointPatterns,
    trackGitHistory: r['trackGitHistory'] !== false,
  };
}

// ---------------------------------------------------------------------------
// Path / pattern matching
// ---------------------------------------------------------------------------

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function patternToRegex(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let regex = '^';
  let i = 0;
  while (i < normalized.length) {
    const c = normalized[i]!;
    if (c === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        regex += '(?:.*/)?';
        i += 3;
      } else {
        regex += '.*';
        i += 2;
      }
    } else if (c === '*') {
      regex += '[^/]*';
      i += 1;
    } else if (c === '?') {
      regex += '[^/]';
      i += 1;
    } else {
      regex += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  regex += '$';
  return new RegExp(regex);
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  const normalized = normalizePath(filePath);
  return patterns.some((p) => patternToRegex(p).test(normalized));
}

function resolveToProjectRoot(filePath: string): string {
  if (isAbsolute(filePath)) return resolve(filePath);
  return resolve(process.cwd(), filePath);
}

function withinProject(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096) return false;
  const resolved = resolveToProjectRoot(filePath);
  const rel = relative(process.cwd(), resolved);
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

function isPackageEntryPoint(filePath: string): boolean {
  const resolved = resolveToProjectRoot(filePath);
  const dir = dirname(resolved);
  const pkgPath = resolve(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      main?: string;
      module?: string;
      exports?: string | Record<string, unknown>;
    };
    const entries: string[] = [];
    if (pkg.main) entries.push(pkg.main);
    if (pkg.module) entries.push(pkg.module);
    if (pkg.exports) {
      if (typeof pkg.exports === 'string') {
        entries.push(pkg.exports);
      } else if (typeof pkg.exports === 'object' && pkg.exports !== null) {
        const dot = pkg.exports['.'];
        if (typeof dot === 'string') entries.push(dot);
        else if (dot && typeof dot === 'object') {
          for (const v of Object.values(dot)) {
            if (typeof v === 'string') entries.push(v);
          }
        }
      }
    }
    for (const entry of entries) {
      const entryResolved = resolve(dir, entry);
      if (entryResolved === resolved) return true;
      // Heuristic: same basename + same parent directory name allows
      // matching a source file (src/index.ts) to a compiled entry
      // (dist/index.js) in the same package.
      if (
        basename(dirname(entryResolved)) === basename(dirname(resolved)) &&
        basename(entryResolved, extname(entryResolved)) === basename(resolved, extname(resolved))
      ) {
        return true;
      }
    }
  } catch {
    // best-effort: malformed package.json is not an error
  }
  return false;
}

function isEntryPoint(filePath: string, patterns: string[]): boolean {
  if (!withinProject(filePath)) return false;
  if (matchesAnyPattern(filePath, patterns)) return true;
  return isPackageEntryPoint(filePath);
}

// ---------------------------------------------------------------------------
// Export extraction (simple regex heuristics, no full parser)
// ---------------------------------------------------------------------------

function extractExports(source: string): Set<string> {
  const exports = new Set<string>();

  // export const/function/class/interface/type/enum name
  const declRegex =
    /export\s+(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  for (const match of source.matchAll(declRegex)) {
    exports.add(match[1]!);
  }

  // export { a, b as c }
  const namedRegex = /export\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(namedRegex)) {
    const clauses = match[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const clause of clauses) {
      const parts = clause.split(/\s+as\s+/);
      const exportedName = parts.length > 1 ? parts[parts.length - 1]!.trim() : parts[0]!.trim();
      if (exportedName) exports.add(exportedName);
    }
  }

  // export * from './module'
  const starRegex = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(starRegex)) {
    exports.add(`* from '${match[1]}'`);
  }

  // export default
  if (/\bexport\s+default\b/.test(source)) {
    exports.add('default');
  }

  // CommonJS: module.exports = { a, b: c }
  const cjsRegex = /module\.exports\s*=\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(cjsRegex)) {
    const clauses = match[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const clause of clauses) {
      const key = clause.split(':')[0]!.trim().replace(/['"]/g, '');
      if (key) exports.add(key);
    }
  }

  // CommonJS: module.exports.foo = ...
  const cjsPropRegex = /module\.exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
  for (const match of source.matchAll(cjsPropRegex)) {
    exports.add(match[1]!);
  }

  return exports;
}

// ---------------------------------------------------------------------------
// Git / filesystem helpers
// ---------------------------------------------------------------------------

function readGitVersion(filePath: string): Promise<string | null> {
  const resolved = resolveToProjectRoot(filePath);
  const relPath = normalizePath(relative(process.cwd(), resolved));
  return new Promise((resolveVersion) => {
    execFile(
      'git',
      ['show', `HEAD:${relPath}`],
      {
        encoding: 'utf8',
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 5 * 1024 * 1024,
      },
      (error, stdout) => resolveVersion(error ? null : stdout),
    );
  });
}

async function readCurrentFile(filePath: string): Promise<string | null> {
  try {
    const resolved = resolveToProjectRoot(filePath);
    return await readFile(resolved, 'utf8');
  } catch {
    return null;
  }
}

interface ComparisonResult {
  removed: string[];
  added: string[];
}

function compareExports(before: string, after: string): ComparisonResult {
  const beforeExports = extractExports(before);
  const afterExports = extractExports(after);
  const removed = [...beforeExports].filter((e) => !afterExports.has(e)).sort();
  const added = [...afterExports].filter((e) => !beforeExports.has(e)).sort();
  return { removed, added };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'api-compatibility-gate',
  version: '0.1.0',
  description:
    'PostToolUse hook that detects breaking API changes (removed exports) in entry-point files after writes or edits',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      severity: {
        type: 'string',
        enum: ['warn', 'block'],
        default: 'warn',
        description: 'warn = inject context; block = refuse the mutating tool.',
      },
      entryPointPatterns: {
        type: 'array',
        items: { type: 'string' },
        default: DEFAULTS.entryPointPatterns,
        description: 'Glob-style patterns for entry-point files to guard.',
      },
      trackGitHistory: {
        type: 'boolean',
        default: true,
        description: 'Read the pre-edit version from git HEAD to compute removed exports.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 audit pattern).
    state.invocationCount = 0;
    state.skippedCount = 0;
    state.checkedCount = 0;
    state.cleanCount = 0;
    state.breakingCount = 0;
    state.errorCount = 0;
    state.lastResult = null;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['api-compatibility-gate']);

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{ decision?: 'block'; reason?: string; additionalContext?: string } | void> => {
      if (!cfg.enabled) return;

      // Skip if the write/edit itself errored.
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const filePath = inp['path'] as string | undefined;
      if (!filePath || typeof filePath !== 'string') return;

      state.invocationCount += 1;

      if (!isEntryPoint(filePath, cfg.entryPointPatterns)) {
        state.skippedCount += 1;
        return;
      }

      if (!cfg.trackGitHistory) {
        state.skippedCount += 1;
        return;
      }

      const before = await readGitVersion(filePath);
      if (before === null) {
        state.skippedCount += 1;
        return;
      }

      const after = await readCurrentFile(filePath);
      if (after === null) {
        state.errorCount += 1;
        return;
      }

      state.checkedCount += 1;
      const { removed, added } = compareExports(before, after);

      state.lastResult = {
        filePath,
        removed,
        added,
        when: new Date().toISOString(),
      };

      if (removed.length === 0) {
        state.cleanCount += 1;
        return;
      }

      state.breakingCount += 1;
      const addedLine = added.length > 0 ? `Added exports: ${added.join(', ')}\n` : '';
      const message =
        `\n⚠️ api-compatibility-gate: ${filePath} removed exported identifiers: ${removed.join(', ')}\n` +
        addedLine +
        `These removals are breaking changes. Restore them or bump the major version.`;

      if (cfg.severity === 'block') {
        return {
          decision: 'block' as const,
          reason: message,
          additionalContext: message,
        };
      }

      return { additionalContext: message };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, {
      background: true,
    });

    // --- api_compat_status tool ---
    api.tools.register({
      name: 'api_compat_status',
      description:
        'Reports api-compatibility-gate state: severity, entry-point patterns, and per-session counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          severity: cfg.severity,
          entryPointPatterns: cfg.entryPointPatterns,
          trackGitHistory: cfg.trackGitHistory,
          counters: {
            invocations: state.invocationCount,
            skipped: state.skippedCount,
            checked: state.checkedCount,
            clean: state.cleanCount,
            breaking: state.breakingCount,
            errors: state.errorCount,
          },
          lastResult: state.lastResult,
        };
      },
    });

    api.log.info('api-compatibility-gate plugin loaded', {
      version: '0.1.0',
      severity: cfg.severity,
      entryPointPatterns: cfg.entryPointPatterns,
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
      invocations: state.invocationCount,
      checked: state.checkedCount,
      clean: state.cleanCount,
      breaking: state.breakingCount,
      errors: state.errorCount,
    };
    state.invocationCount = 0;
    state.skippedCount = 0;
    state.checkedCount = 0;
    state.cleanCount = 0;
    state.breakingCount = 0;
    state.errorCount = 0;
    state.lastResult = null;
    api.log.info('api-compatibility-gate: teardown complete', { final });
  },

  async health() {
    return {
      ok: state.errorCount === 0,
      message: state.lastResult
        ? `api-compatibility-gate: ${state.checkedCount} checked, last ${state.lastResult.removed.length > 0 ? 'BREAKING' : 'clean'} (${state.lastResult.removed.length} removed)`
        : `api-compatibility-gate: ${state.invocationCount} invocation(s), ${state.checkedCount} checked`,
      counters: {
        invocations: state.invocationCount,
        skipped: state.skippedCount,
        checked: state.checkedCount,
        clean: state.cleanCount,
        breaking: state.breakingCount,
        errors: state.errorCount,
      },
    };
  },
};

export default plugin;
