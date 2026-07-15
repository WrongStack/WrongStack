/**
 * feature-flag-tracker plugin — scans source files for feature-flag-like
 * expressions and reports where they are used.
 *
 * Tools registered:
 * - scan_feature_flags : Scan a path for feature flag usages.
 * - feature_flag_status : Report config + counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit` to source files, noting any feature
 *   flags used in the changed file.
 *
 * Config (`config.extensions['feature-flag-tracker']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "extensions": [".ts", ".tsx", ".js", ".jsx"],
 *   "patterns": ["extra-regex"],
 *   "maxFindings": 50
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

export interface FeatureFlagUsage {
  flag: string;
  file: string;
  line: number;
  context: string;
  pattern: string;
}

interface FeatureFlagTrackerState {
  scanCount: number;
  flagCount: number;
  hookInvocationCount: number;
  warningCount: number;
  errorCount: number;
  hookUnregister: null | (() => void);
}

const state: FeatureFlagTrackerState = {
  scanCount: 0,
  flagCount: 0,
  hookInvocationCount: 0,
  warningCount: 0,
  errorCount: 0,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface FeatureFlagTrackerConfig {
  enabled: boolean;
  extensions: string[];
  patterns: string[];
  maxFindings: number;
}

const DEFAULT_PATTERNS: string[] = [
  String.raw`isFeatureEnabled\(['"]([^'"]+)['"]\)`,
  String.raw`featureFlags?\.([A-Za-z_$][A-Za-z0-9_$]*)`,
  String.raw`useFeatureFlag\(['"]([^'"]+)['"]\)`,
  String.raw`flags\.([A-Za-z_$][A-Za-z0-9_$]*)`,
];

const DEFAULTS: FeatureFlagTrackerConfig = {
  enabled: false,
  extensions: ['.ts', '.tsx', '.js', '.jsx'],
  patterns: [],
  maxFindings: 50,
};

function readConfig(raw: unknown): FeatureFlagTrackerConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    extensions: Array.isArray(r['extensions'])
      ? (r['extensions'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.extensions,
    patterns: Array.isArray(r['patterns'])
      ? (r['patterns'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.patterns,
    maxFindings:
      typeof r['maxFindings'] === 'number' && r['maxFindings'] >= 1 && r['maxFindings'] <= 500
        ? r['maxFindings']
        : DEFAULTS.maxFindings,
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
// Flag detection
// ---------------------------------------------------------------------------

function compilePatterns(patterns: string[]): RegExp[] {
  const sources = [...DEFAULT_PATTERNS, ...patterns];
  return sources.map((src) => new RegExp(src, 'g'));
}

function scanFile(filePath: string, content: string, patterns: RegExp[], maxFindings: number): FeatureFlagUsage[] {
  const usages: FeatureFlagUsage[] = [];
  const lines = content.split(/\r?\n/);

  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of content.matchAll(re)) {
      const flag = m[1] ?? m[0]!;
      const lineNo = content.slice(0, m.index).split(/\r?\n/).length;
      const context = (lines[lineNo - 1] ?? '').trim();
      usages.push({
        flag,
        file: relativePath(filePath),
        line: lineNo,
        context,
        pattern: re.source,
      });
      if (usages.length >= maxFindings) break;
    }
    if (usages.length >= maxFindings) break;
  }

  return usages.slice(0, maxFindings);
}

function scanPath(rawPath: string, cfg: FeatureFlagTrackerConfig): { usages: FeatureFlagUsage[]; scannedFiles: number } {
  const root = process.cwd();
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const exts = normalizeExtensions(cfg.extensions);
  const files = collectSourceFiles(resolved, exts);
  const patterns = compilePatterns(cfg.patterns);
  const usages: FeatureFlagUsage[] = [];
  for (const p of files) {
    try {
      const content = readFileSync(p, 'utf-8');
      usages.push(...scanFile(p, content, patterns, cfg.maxFindings));
      if (usages.length >= cfg.maxFindings) break;
    } catch {
      // skip unreadable
    }
  }
  return { usages: usages.slice(0, cfg.maxFindings), scannedFiles: files.length };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'feature-flag-tracker',
  version: '0.1.0',
  description: 'Scans source files for feature-flag-like expressions and reports usages',
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
        description: 'File extensions to scan.',
      },
      patterns: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description: 'Extra regex patterns (merged with built-in defaults).',
      },
      maxFindings: {
        type: 'number',
        minimum: 1,
        maximum: 500,
        default: 50,
        description: 'Maximum flag usages reported per scan.',
      },
    },
  },

  setup(api) {
    state.scanCount = 0;
    state.flagCount = 0;
    state.hookInvocationCount = 0;
    state.warningCount = 0;
    state.errorCount = 0;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['feature-flag-tracker']);

    const hook = (
      input: {
        toolName?: string | undefined;
        toolInput?: unknown;
        toolResult?: { content: string; isError: boolean } | undefined;
      },
    ): { decision?: 'block'; reason?: string; additionalContext?: string } | void => {
      if (!cfg.enabled) return;
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const sourcePath = inp['path'] as string | undefined;
      if (!sourcePath || typeof sourcePath !== 'string') return;
      if (!withinProject(sourcePath)) return;

      const exts = normalizeExtensions(cfg.extensions);
      if (!matchesExtension(sourcePath, exts)) return;

      state.hookInvocationCount += 1;

      const resolved = resolve(process.cwd(), sourcePath);
      let content: string;
      try {
        content = readFileSync(resolved, 'utf-8');
      } catch {
        state.errorCount += 1;
        return;
      }

      const patterns = compilePatterns(cfg.patterns);
      const usages = scanFile(resolved, content, patterns, cfg.maxFindings);
      if (usages.length === 0) return;

      state.warningCount += usages.length;
      const flags = [...new Set(usages.map((u) => u.flag))].join(', ');
      return {
        additionalContext:
          `\n🚩 feature-flag-tracker: ${sourcePath} references feature flag(s): ${flags}.\n` +
          `Make sure flag behavior is intentional and consider updating flag inventory/docs.`,
      };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, { background: true });

    // --- scan_feature_flags tool ---
    api.tools.register({
      name: 'scan_feature_flags',
      description:
        'Scan source files for feature-flag-like expressions (isFeatureEnabled, featureFlags.*, useFeatureFlag, flags.*, plus custom patterns).',
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
        if (!cfg.enabled) return { ok: false, error: 'feature-flag-tracker is disabled' };

        const rawPath = typeof input.path === 'string' ? input.path : '.';
        if (!withinProject(rawPath)) {
          return { ok: false, error: 'path is outside the project root' };
        }

        state.scanCount += 1;
        let result: { usages: FeatureFlagUsage[]; scannedFiles: number };
        try {
          result = scanPath(rawPath, cfg);
        } catch (err) {
          state.errorCount += 1;
          return { ok: false, error: String(err) };
        }
        state.flagCount += result.usages.length;

        return {
          ok: true,
          path: relativePath(resolve(process.cwd(), rawPath)),
          scannedFiles: result.scannedFiles,
          usages: result.usages,
        };
      },
    });

    // --- feature_flag_status tool ---
    api.tools.register({
      name: 'feature_flag_status',
      description: 'Reports feature-flag-tracker state: config + counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          extensions: cfg.extensions,
          patterns: cfg.patterns,
          maxFindings: cfg.maxFindings,
          counters: {
            scans: state.scanCount,
            flags: state.flagCount,
            hookInvocations: state.hookInvocationCount,
            warnings: state.warningCount,
            errors: state.errorCount,
          },
        };
      },
    });

    api.log.info('feature-flag-tracker plugin loaded', {
      version: '0.1.0',
      extensions: cfg.extensions,
      customPatterns: cfg.patterns.length,
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
      flags: state.flagCount,
      hookInvocations: state.hookInvocationCount,
      warnings: state.warningCount,
      errors: state.errorCount,
    };
    state.scanCount = 0;
    state.flagCount = 0;
    state.hookInvocationCount = 0;
    state.warningCount = 0;
    state.errorCount = 0;
    api.log.info('feature-flag-tracker: teardown complete', { final });
  },

  async health() {
    return {
      ok: state.errorCount === 0,
      message: state.errorCount
        ? `feature-flag-tracker: ${state.errorCount} error(s)`
        : `feature-flag-tracker: ${state.scanCount} scan(s), ${state.flagCount} flag usage(s)`,
      counters: {
        scans: state.scanCount,
        flags: state.flagCount,
        hookInvocations: state.hookInvocationCount,
        warnings: state.warningCount,
        errors: state.errorCount,
      },
    };
  },
};

export default plugin;
