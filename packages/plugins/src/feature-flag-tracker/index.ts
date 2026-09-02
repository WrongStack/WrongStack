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

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { collectSourceFilesAsync, matchesExtension, withinProject } from '../runtime/index.js';

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
  String.raw`isFeatureEnabled\(['"\`]([^'"\`]+)['"\`]\)`,
  String.raw`featureFlags?(?:\.|\?\.)([A-Za-z_$][A-Za-z0-9_$]*)`,
  String.raw`useFeatureFlag\(['"\`]([^'"\`]+)['"\`]\)`,
  String.raw`flags(?:\.|\?\.)([A-Za-z_$][A-Za-z0-9_$]*)`,
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
  const rawExts = r['extensions'] ?? r['file_extensions'] ?? r['fileExtensions'];
  const rawPatterns = r['patterns'] ?? r['custom_patterns'] ?? r['customPatterns'];
  const rawMax = r['maxFindings'] ?? r['max_findings'] ?? r['limit'];
  return {
    enabled: r['enabled'] !== false,
    extensions: Array.isArray(rawExts)
      ? (rawExts as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.extensions,
    patterns: Array.isArray(rawPatterns)
      ? (rawPatterns as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.patterns,
    maxFindings:
      typeof rawMax === 'number' && rawMax >= 1 && rawMax <= 500 ? rawMax : DEFAULTS.maxFindings,
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
// Flag detection
// ---------------------------------------------------------------------------

/**
 * Compile the built-in and user-supplied flag patterns.
 *
 * Invalid patterns are skipped rather than thrown. `patterns` comes from
 * user config, so a single typo ("flags.(" ) used to throw out of
 * `compilePatterns` and take the entire scan down — including the
 * built-in patterns, which are fine. Sibling plugins that accept regex
 * config (`prompt-firewall`, `semantic-search-indexer`) already skip;
 * this brings the third into line.
 */
function compilePatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const src of [...DEFAULT_PATTERNS, ...patterns]) {
    try {
      out.push(new RegExp(src, 'g'));
    } catch {
      // skip invalid pattern
    }
  }
  return out;
}

const RESERVED_FLAG_NAMES = new Set([
  'includes',
  'length',
  'has',
  'get',
  'set',
  'size',
  'slice',
  'split',
  'filter',
  'map',
  'forEach',
  'join',
  'push',
  'pop',
  'indexOf',
  'values',
  'keys',
  'entries',
  'toString',
  'trim',
  'toLowerCase',
  'toUpperCase',
  'match',
  'replace',
  'name',
  'type',
]);

function scanFile(
  filePath: string,
  content: string,
  patterns: RegExp[],
  maxFindings: number,
): FeatureFlagUsage[] {
  const usages: FeatureFlagUsage[] = [];
  const lines = content.split(/\r?\n/);

  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of content.matchAll(re)) {
      const flag = m[1] ?? m[0]!;
      if (RESERVED_FLAG_NAMES.has(flag)) continue;
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

async function scanPath(
  rawPath: string,
  cfg: FeatureFlagTrackerConfig,
): Promise<{
  usages: FeatureFlagUsage[];
  scannedFiles: number;
  /** Files discovered by the walk, whether or not they were opened. */
  discoveredFiles: number;
  /** True when `maxFindings` stopped the walk before every file was read. */
  truncated: boolean;
}> {
  const root = process.cwd();
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const exts = normalizeExtensions(cfg.extensions);
  const files = await collectSourceFilesAsync(resolved, { extensions: exts });
  const patterns = compilePatterns(cfg.patterns);
  const usages: FeatureFlagUsage[] = [];
  // Count what was actually opened. Reporting the discovered total as
  // `scannedFiles` claimed credit for files the walk never reached once
  // the findings cap cut it short.
  let scannedFiles = 0;
  let truncated = false;
  for (const p of files) {
    try {
      const content = await readFile(p, 'utf-8');
      scannedFiles += 1;
      usages.push(...scanFile(p, content, patterns, cfg.maxFindings));
      if (usages.length >= cfg.maxFindings) {
        truncated = scannedFiles < files.length;
        break;
      }
    } catch {
      // skip unreadable
    }
  }
  return {
    usages: usages.slice(0, cfg.maxFindings),
    scannedFiles,
    discoveredFiles: files.length,
    truncated,
  };
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

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{ decision?: 'block'; reason?: string; additionalContext?: string } | void> => {
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

      const resolved = resolve(process.cwd(), sourcePath);
      let content: string;
      try {
        content = await readFile(resolved, 'utf-8');
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

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, {
      background: true,
    });

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

        const raw = (input ?? {}) as Record<string, unknown>;
        const rawPath =
          (typeof input.path === 'string' && input.path.trim().length > 0
            ? input.path.trim()
            : undefined) ??
          (typeof raw['directory'] === 'string' ? raw['directory'] : undefined) ??
          (typeof raw['SearchDirectory'] === 'string' ? raw['SearchDirectory'] : undefined) ??
          (typeof raw['dir'] === 'string' ? raw['dir'] : undefined) ??
          (typeof raw['TargetFile'] === 'string' ? raw['TargetFile'] : undefined) ??
          (typeof raw['targetFile'] === 'string' ? raw['targetFile'] : undefined) ??
          (typeof raw['filePath'] === 'string' ? raw['filePath'] : undefined) ??
          (typeof raw['file_path'] === 'string' ? raw['file_path'] : undefined) ??
          (typeof raw['file'] === 'string' ? raw['file'] : undefined) ??
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
        state.flagCount += result.usages.length;

        return {
          ok: true,
          path: relativePath(resolve(process.cwd(), rawPath)),
          scannedFiles: result.scannedFiles,
          discoveredFiles: result.discoveredFiles,
          // Say so when the cap stopped the walk early: a partial scan
          // that reports few findings must not read as a clean result.
          truncated: result.truncated,
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
