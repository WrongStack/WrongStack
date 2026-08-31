/**
 * auto-i18n-extractor plugin — detects hardcoded user-facing strings in UI
 * source files and suggests translation keys.
 *
 * Tools registered:
 * - i18n_extract : Scan a file/directory path for extractable strings.
 * - i18n_status  : Show config + per-session counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit` for `.tsx`, `.jsx`, `.vue` files.
 *   Scans the written file and injects a short additionalContext with
 *   suggested i18n keys when user-facing string literals are found.
 *
 * Config (`config.extensions['auto-i18n-extractor']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "fileExtensions": [".tsx", ".jsx", ".vue"],
 *   "minLength": 2,
 *   "maxContextStrings": 10,
 *   "excludeAttributes": [
 *     "className", "class", "testId", "data-testid",
 *     "aria-label", "aria-labelledby", "key", "id", "name", "htmlFor"
 *   ]
 * }
 * ```
 *
 * @public
 */

import { readFileSync } from 'node:fs';
import type { Plugin } from '@wrongstack/core/types';
import { withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface AutoI18nState {
  filesScanned: number;
  stringsFound: number;
  extractions: number;
  skipped: number;
  readErrors: number;
  hookUnregister: null | (() => void);
  lastResult: {
    path: string;
    stringsFound: number;
    when: string;
  } | null;
}

const state: AutoI18nState = {
  filesScanned: 0,
  stringsFound: 0,
  extractions: 0,
  skipped: 0,
  readErrors: 0,
  hookUnregister: null,
  lastResult: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface AutoI18nConfig {
  enabled: boolean;
  fileExtensions: string[];
  minLength: number;
  maxContextStrings: number;
  excludeAttributes: string[];
}

const DEFAULTS: AutoI18nConfig = {
  enabled: false,
  fileExtensions: ['.tsx', '.jsx', '.vue'],
  minLength: 2,
  maxContextStrings: 10,
  excludeAttributes: [
    'className',
    'class',
    'testId',
    'data-testid',
    'aria-label',
    'aria-labelledby',
    'key',
    'id',
    'name',
    'htmlFor',
  ],
};

function readConfig(raw: unknown): AutoI18nConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;

  const clamp = (n: unknown, min: number, max: number, fallback: number): number =>
    typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;

  const rawExts = r['fileExtensions'] ?? r['file_extensions'] ?? r['extensions'];
  const rawMin = r['minLength'] ?? r['min_length'] ?? r['min'];
  const rawMax = r['maxContextStrings'] ?? r['max_context_strings'] ?? r['maxStrings'] ?? r['limit'];
  const rawExcl = r['excludeAttributes'] ?? r['exclude_attributes'];

  return {
    enabled: r['enabled'] !== false,
    fileExtensions: Array.isArray(rawExts)
      ? (rawExts as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.fileExtensions,
    minLength: clamp(rawMin, 1, 500, DEFAULTS.minLength),
    maxContextStrings: clamp(rawMax, 1, 100, DEFAULTS.maxContextStrings),
    excludeAttributes: Array.isArray(rawExcl)
      ? (rawExcl as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.excludeAttributes,
  };
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

// withinProject() imported from ../runtime/index.js

function fileExtension(p: string): string {
  const dot = p.lastIndexOf('.');
  return dot > 0 ? p.slice(dot).toLowerCase() : '';
}

// ---------------------------------------------------------------------------
// Extraction heuristics
// ---------------------------------------------------------------------------

interface ExtractedString {
  value: string;
  line: number;
  keySuggestion: string;
}

function generateKey(value: string): string {
  const base = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (base) return `t.${base}`;
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return `t.str_${hash.toString(36)}`;
}

function looksLikeUserText(value: string, minLength: number): boolean {
  if (value.length < minLength) return false;
  if (/^\s*$/.test(value)) return false;
  // Only digits, punctuation, whitespace, underscores.
  if (/^[0-9\s\W_]+$/.test(value)) return false;
  // URL/path-like, color hex, short identifiers, import paths.
  if (/^(https?:|ftp:|www\.|\/|\.\/|@|#[0-9a-f]{3,8}$|\.?(jsx?|tsx?|vue|css|scss|json|png|svg|jpg)$)/i.test(value)) {
    return false;
  }
  return true;
}

function isExcludedContext(line: string, quoteIndex: number, excludeAttributes: string[]): boolean {
  const before = line.slice(0, quoteIndex);
  for (const attr of excludeAttributes) {
    // Match attr=, attr={, attr={" or attr={' immediately before the string.
    const re = new RegExp(`\\b${attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:\\{\\s*)?["']?$`);
    if (re.test(before)) return true;
  }
  return false;
}

function extractStrings(content: string, cfg: AutoI18nConfig): ExtractedString[] {
  const results: ExtractedString[] = [];
  const lines = content.split(/\r?\n/);
  const stringRegex = /(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*(?:import\b|export\b.*?from\b|const\s+.*=\s*require\()/.test(line)) continue;
    stringRegex.lastIndex = 0;
    for (const match of line.matchAll(stringRegex)) {
      const value = match[2] ?? '';
      const quoteIndex = match.index + (match[1]?.length ?? 1);
      if (!looksLikeUserText(value, cfg.minLength)) continue;
      if (isExcludedContext(line, quoteIndex, cfg.excludeAttributes)) continue;
      results.push({ value, line: i + 1, keySuggestion: generateKey(value) });
    }
  }

  return results;
}

function readSourceFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'auto-i18n-extractor',
  version: '0.1.0',
  description:
    'Detects hardcoded user-facing strings in UI source files and suggests translation keys',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      fileExtensions: {
        type: 'array',
        items: { type: 'string' },
        default: ['.tsx', '.jsx', '.vue'],
        description: 'Only scan files with these extensions.',
      },
      minLength: {
        type: 'number',
        minimum: 1,
        maximum: 500,
        default: 2,
        description: 'Minimum string length to consider user-facing.',
      },
      maxContextStrings: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 10,
        description: 'Maximum strings included in a hook additionalContext.',
      },
      excludeAttributes: {
        type: 'array',
        items: { type: 'string' },
        default: [
          'className',
          'class',
          'testId',
          'data-testid',
          'aria-label',
          'aria-labelledby',
          'key',
          'id',
          'name',
          'htmlFor',
        ],
        description: 'Attribute names whose string values are never user-facing.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.filesScanned = 0;
    state.stringsFound = 0;
    state.extractions = 0;
    state.skipped = 0;
    state.readErrors = 0;
    state.lastResult = null;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['auto-i18n-extractor']);

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
      const rawPath =
        inp['path'] ??
        inp['TargetFile'] ??
        inp['filePath'] ??
        inp['targetFile'] ??
        inp['file_path'] ??
        inp['file'];
      const sourcePath = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : undefined;
      if (!sourcePath || typeof sourcePath !== 'string') return;
      if (!withinProject(sourcePath)) return;

      const ext = fileExtension(sourcePath);
      if (!cfg.fileExtensions.includes(ext)) {
        state.skipped += 1;
        return;
      }

      state.filesScanned += 1;
      const content = readSourceFile(sourcePath);
      if (content === null) {
        state.readErrors += 1;
        return;
      }

      const extracted = extractStrings(content, cfg);
      if (extracted.length === 0) return;

      state.stringsFound += extracted.length;
      state.extractions += 1;
      state.lastResult = {
        path: sourcePath,
        stringsFound: extracted.length,
        when: new Date().toISOString(),
      };

      const shown = extracted.slice(0, cfg.maxContextStrings);
      const lines = shown.map((s) => `  - "${s.value}" → ${s.keySuggestion} (line ${s.line})`);
      const more = extracted.length > shown.length ? `\n  … and ${extracted.length - shown.length} more` : '';
      const context =
        `\n🌍 auto-i18n-extractor: found ${extracted.length} user-facing string(s) in ${sourcePath}.` +
        ` Consider extracting to i18n keys:\n${lines.join('\n')}${more}`;

      return { additionalContext: context };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, { background: true });

    // --- i18n_extract tool ---
    api.tools.register({
      name: 'i18n_extract',
      description:
        'Scan a UI source file (.tsx/.jsx/.vue) for hardcoded user-facing string literals and return suggested i18n keys.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative or absolute path to the source file to scan.',
          },
        },
        required: ['path'],
      },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute(input: { path: string }) {
        if (!cfg.enabled) return { ok: false, error: 'auto-i18n-extractor is disabled' };
        const raw = input as Record<string, unknown>;
        const rawPath =
          (typeof input.path === 'string' && input.path.trim().length > 0 ? input.path.trim() : undefined) ??
          (typeof raw['TargetFile'] === 'string' && raw['TargetFile'].trim().length > 0 ? raw['TargetFile'].trim() : undefined) ??
          (typeof raw['targetFile'] === 'string' && raw['targetFile'].trim().length > 0 ? raw['targetFile'].trim() : undefined) ??
          (typeof raw['filePath'] === 'string' && raw['filePath'].trim().length > 0 ? raw['filePath'].trim() : undefined) ??
          (typeof raw['file_path'] === 'string' && raw['file_path'].trim().length > 0 ? raw['file_path'].trim() : undefined) ??
          (typeof raw['file'] === 'string' && raw['file'].trim().length > 0 ? raw['file'].trim() : undefined);
        const filePath = typeof rawPath === 'string' ? rawPath.trim() : '';
        if (!filePath) {
          return { ok: false, error: 'path is required' };
        }
        if (!withinProject(filePath)) {
          return { ok: false, error: 'path must be inside the project' };
        }

        const ext = fileExtension(filePath);
        if (!cfg.fileExtensions.includes(ext)) {
          return {
            ok: false,
            error: `unsupported extension "${ext}"; allowed: ${cfg.fileExtensions.join(', ')}`,
          };
        }

        state.filesScanned += 1;
        const content = readSourceFile(filePath);
        if (content === null) {
          state.readErrors += 1;
          return { ok: false, error: `could not read ${filePath}` };
        }

        const extracted = extractStrings(content, cfg);
        state.stringsFound += extracted.length;
        if (extracted.length > 0) {
          state.extractions += 1;
          state.lastResult = {
            path: filePath,
            stringsFound: extracted.length,
            when: new Date().toISOString(),
          };
        }

        return {
          ok: true,
          path: filePath,
          stringsFound: extracted.length,
          strings: extracted,
        };
      },
    });

    // --- i18n_status tool ---
    api.tools.register({
      name: 'i18n_status',
      description:
        'Reports auto-i18n-extractor state: enabled, extensions, counters, and last extraction.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          fileExtensions: cfg.fileExtensions,
          minLength: cfg.minLength,
          maxContextStrings: cfg.maxContextStrings,
          excludeAttributes: cfg.excludeAttributes,
          counters: {
            filesScanned: state.filesScanned,
            stringsFound: state.stringsFound,
            extractions: state.extractions,
            skipped: state.skipped,
            readErrors: state.readErrors,
          },
          lastResult: state.lastResult,
        };
      },
    });

    api.log.info('auto-i18n-extractor plugin loaded', {
      version: '0.1.0',
      fileExtensions: cfg.fileExtensions,
      minLength: cfg.minLength,
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
      filesScanned: state.filesScanned,
      stringsFound: state.stringsFound,
      extractions: state.extractions,
      skipped: state.skipped,
      readErrors: state.readErrors,
    };
    state.filesScanned = 0;
    state.stringsFound = 0;
    state.extractions = 0;
    state.skipped = 0;
    state.readErrors = 0;
    state.lastResult = null;
    api.log.info('auto-i18n-extractor: teardown complete', { final });
  },

  async health() {
    return {
      ok: state.readErrors === 0,
      message: state.lastResult
        ? `auto-i18n-extractor: ${state.filesScanned} file(s) scanned, ${state.stringsFound} string(s) found, last ${state.lastResult.path} (${state.lastResult.stringsFound})`
        : `auto-i18n-extractor: ${state.filesScanned} file(s) scanned, ${state.stringsFound} string(s) found`,
      counters: {
        filesScanned: state.filesScanned,
        stringsFound: state.stringsFound,
        extractions: state.extractions,
        skipped: state.skipped,
        readErrors: state.readErrors,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;
