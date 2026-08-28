/**
 * doc-sync-guard plugin — warns when documentation is edited without
 * referencing recently changed public source files.
 *
 * Tracks public source files changed by `write` or `edit`. When a README or
 * docs file is written, checks whether the recently changed source files are
 * mentioned and injects an `additionalContext` warning if any are missing.
 *
 * Tools registered:
 * - doc_sync_status : Show tracked changed files and counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit`.
 *
 * Config (`config.extensions['doc-sync-guard']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "sourceExtensions": [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"],
 *   "docNames": ["README.md", "README", "CONTRIBUTING.md", "CHANGELOG.md"],
 *   "maxTrackedFiles": 20
 * }
 * ```
 *
 * @public
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { releaseHandle, withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface DocSyncGuardState {
  changedFiles: string[];
  sourceWrites: number;
  docWrites: number;
  warningsIssued: number;
  hookUnregister: null | (() => void);
}

const state: DocSyncGuardState = {
  changedFiles: [],
  sourceWrites: 0,
  docWrites: 0,
  warningsIssued: 0,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface DocSyncGuardConfig {
  enabled: boolean;
  sourceExtensions: string[];
  docNames: string[];
  maxTrackedFiles: number;
}

const DEFAULTS: DocSyncGuardConfig = {
  enabled: false,
  sourceExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'],
  docNames: ['README.md', 'README', 'CONTRIBUTING.md', 'CHANGELOG.md'],
  maxTrackedFiles: 20,
};

function readConfig(raw: unknown): DocSyncGuardConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    sourceExtensions: Array.isArray(r['sourceExtensions'])
      ? (r['sourceExtensions'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.sourceExtensions,
    docNames: Array.isArray(r['docNames'])
      ? (r['docNames'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.docNames,
    maxTrackedFiles:
      typeof r['maxTrackedFiles'] === 'number' && r['maxTrackedFiles'] >= 1 && r['maxTrackedFiles'] <= 200
        ? r['maxTrackedFiles']
        : DEFAULTS.maxTrackedFiles,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// withinProject() imported from ../runtime/index.js

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

function isSourceFile(p: string, extensions: string[]): boolean {
  const ext = extname(p).toLowerCase();
  return extensions.includes(ext);
}

function isPublicSource(p: string, extensions: string[]): boolean {
  if (!isSourceFile(p, extensions)) return false;
  const norm = normalizeSlashes(p);
  if (norm.includes('/node_modules/') || norm.startsWith('node_modules/')) return false;
  const base = basename(norm).toLowerCase();
  if (/\.(test|spec)\./.test(base)) return false;
  if (base.startsWith('_')) return false;
  return true;
}

function isDocFile(p: string, docNames: string[]): boolean {
  const norm = normalizeSlashes(p);
  const base = basename(norm);
  const lowerBase = base.toLowerCase();
  if (docNames.some((name) => lowerBase === name.toLowerCase())) return true;
  if (norm.includes('/docs/') || norm.startsWith('docs/')) return true;
  return false;
}

function extractPath(toolInput: unknown): string | undefined {
  const inp = (toolInput ?? {}) as Record<string, unknown>;
  const p = inp['path'];
  return typeof p === 'string' ? p : undefined;
}

function extractDocContent(toolInput: unknown): string | undefined {
  const inp = (toolInput ?? {}) as Record<string, unknown>;
  if (typeof inp['content'] === 'string') return inp['content'];
  if (typeof inp['new_string'] === 'string') return inp['new_string'];
  return undefined;
}

function referenceTokens(p: string): string[] {
  const base = basename(p);
  const withoutExt = base.replace(/\.[^.]+$/, '');
  const tokens = [base];
  if (withoutExt && withoutExt !== base) tokens.push(withoutExt);
  return tokens;
}

function isReferenced(path: string, content: string): boolean {
  const lowerContent = content.toLowerCase();
  for (const token of referenceTokens(path)) {
    if (token.length < 2) continue;
    if (lowerContent.includes(token.toLowerCase())) return true;
  }
  return false;
}

function trackChangedFile(path: string, maxTracked: number): void {
  // Remove existing entry to keep most-recent order.
  state.changedFiles = state.changedFiles.filter((p) => p !== path);
  state.changedFiles.push(path);
  if (state.changedFiles.length > maxTracked) {
    state.changedFiles = state.changedFiles.slice(-maxTracked);
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'doc-sync-guard',
  version: '0.1.0',
  description:
    'PostToolUse hook that tracks changed public source files and warns when README/docs edits omit them',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      sourceExtensions: {
        type: 'array',
        items: { type: 'string' },
        default: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'],
        description: 'Extensions considered public source files.',
      },
      docNames: {
        type: 'array',
        items: { type: 'string' },
        default: ['README.md', 'README', 'CONTRIBUTING.md', 'CHANGELOG.md'],
        description: 'Base file names treated as documentation.',
      },
      maxTrackedFiles: {
        type: 'number',
        minimum: 1,
        maximum: 200,
        default: 20,
        description: 'Maximum number of recently changed source files to remember.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.changedFiles = [];
    state.sourceWrites = 0;
    state.docWrites = 0;
    state.warningsIssued = 0;
    state.hookUnregister = releaseHandle(state.hookUnregister);

    const cfg = readConfig(api.config.extensions?.['doc-sync-guard']);

    const hook = (
      input: {
        toolName?: string | undefined;
        toolInput?: unknown;
        toolResult?: { content: string; isError: boolean } | undefined;
      },
    ): { decision?: 'block'; reason?: string; additionalContext?: string } | void => {
      if (!cfg.enabled) return;

      // Skip if the write/edit itself errored.
      if (input.toolResult?.isError) return;

      const path = extractPath(input.toolInput);
      if (!path || !withinProject(path)) return;

      if (isPublicSource(path, cfg.sourceExtensions)) {
        trackChangedFile(path, cfg.maxTrackedFiles);
        state.sourceWrites += 1;
        return;
      }

      if (isDocFile(path, cfg.docNames)) {
        state.docWrites += 1;
        let content = extractDocContent(input.toolInput);
        if (!content) {
          try {
            if (existsSync(path)) content = readFileSync(path, 'utf-8');
          } catch {
            // best-effort
          }
        }
        if (!content || state.changedFiles.length === 0) return;

        const missing = state.changedFiles.filter((changedPath) => !isReferenced(changedPath, content));
        if (missing.length === 0) return;

        state.warningsIssued += 1;
        const missingList = missing.map((p) => `  - ${p}`).join('\n');
        const message =
          `\n⚠️ doc-sync-guard: ${path} was updated but does not appear to reference ` +
          `recently changed public source file(s):\n${missingList}\n` +
          `Consider mentioning these changes in the documentation.`;
        return { additionalContext: message };
      }
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, { background: true });

    // --- doc_sync_status tool ---
    api.tools.register({
      name: 'doc_sync_status',
      description:
        'Reports doc-sync-guard state: tracked changed files, doc-write count, and warning count.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          maxTrackedFiles: cfg.maxTrackedFiles,
          changedFiles: [...state.changedFiles],
          counters: {
            sourceWrites: state.sourceWrites,
            docWrites: state.docWrites,
            warningsIssued: state.warningsIssued,
          },
        };
      },
    });

    api.log.info('doc-sync-guard plugin loaded', {
      version: '0.1.0',
      maxTrackedFiles: cfg.maxTrackedFiles,
      sourceExtensions: cfg.sourceExtensions,
      docNames: cfg.docNames,
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
      changedFiles: state.changedFiles.length,
      sourceWrites: state.sourceWrites,
      docWrites: state.docWrites,
      warningsIssued: state.warningsIssued,
    };
    state.changedFiles = [];
    state.sourceWrites = 0;
    state.docWrites = 0;
    state.warningsIssued = 0;
    api.log.info('doc-sync-guard: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `doc-sync-guard: ${state.changedFiles.length} tracked file(s), ${state.warningsIssued} warning(s)`,
      counters: {
        changedFiles: state.changedFiles.length,
        sourceWrites: state.sourceWrites,
        docWrites: state.docWrites,
        warningsIssued: state.warningsIssued,
      },
    };
  },
};

export default plugin;
