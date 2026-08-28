/**
 * smart-rename plugin — whole-word identifier rename inside a single source
 * file using regex replacement.
 *
 * Tool registered:
 * - smart_rename : Replace whole-word occurrences of oldName with newName.
 *
 * No hooks are registered.
 *
 * Config (`config.extensions['smart-rename']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "extensions": [".ts", ".tsx", ".js", ".jsx"]
 * }
 * ```
 *
 * @public
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface SmartRenameState {
  renameCount: number;
  replacementCount: number;
  errorCount: number;
}

const state: SmartRenameState = {
  renameCount: 0,
  replacementCount: 0,
  errorCount: 0,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SmartRenameConfig {
  enabled: boolean;
  extensions: string[];
}

const DEFAULTS: SmartRenameConfig = {
  enabled: true,
  extensions: ['.ts', '.tsx', '.js', '.jsx'],
};

function readConfig(raw: unknown): SmartRenameConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    extensions: Array.isArray(r['extensions'])
      ? (r['extensions'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.extensions,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function withinProject(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false;
  const root = process.cwd();
  const resolved = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, resolved);
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function relativePath(p: string): string {
  return toPosix(relative(process.cwd(), p));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Rename logic
// ---------------------------------------------------------------------------

/**
 * A JavaScript/TypeScript identifier. `$` and `_` are legal anywhere,
 * including as the first character.
 */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** True when `name` is something this tool may safely substitute. */
export function isIdentifier(name: string): boolean {
  return IDENTIFIER_RE.test(name);
}

/**
 * Whole-word identifier replacement.
 *
 * The boundaries are written explicitly instead of with `\b`. `\b` is
 * defined against `[A-Za-z0-9_]`, which does NOT include `$` — so for a
 * `$`-prefixed identifier (legal, and common in jQuery-style and generated
 * code) the leading `\b` required a word character immediately before the
 * `$`, which almost never holds. Such renames matched nothing at all and
 * the tool reported success with zero replacements: a silent no-op on a
 * mutating operation. Lookarounds over the real identifier character class
 * behave correctly for `$` and `_` alike.
 */
function renameInContent(
  content: string,
  oldName: string,
  newName: string,
): { preview: string; replacements: number } {
  const re = new RegExp(
    `(?<![A-Za-z0-9_$])${escapeRegex(oldName)}(?![A-Za-z0-9_$])`,
    'g',
  );
  let replacements = 0;
  const preview = content.replace(re, () => {
    replacements++;
    return newName;
  });
  return { preview, replacements };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'smart-rename',
  version: '0.1.0',
  description: 'Whole-word identifier rename inside a single source file',
  apiVersion: API_VERSION,
  capabilities: { tools: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        default: ['.ts', '.tsx', '.js', '.jsx'],
        description: 'File extensions allowed for renaming.',
      },
    },
  },

  setup(api) {
    state.renameCount = 0;
    state.replacementCount = 0;
    state.errorCount = 0;

    const cfg = readConfig(api.config.extensions?.['smart-rename']);

    // --- smart_rename tool ---
    api.tools.register({
      name: 'smart_rename',
      description:
        'Replace whole-word occurrences of an identifier in a source file. Returns a preview by default; set apply:true to write the result back to disk.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Source file path (relative to project root).' },
          oldName: { type: 'string', description: 'Identifier to replace.' },
          newName: { type: 'string', description: 'New identifier.' },
          apply: { type: 'boolean', default: false, description: 'When true, write the preview back to disk.' },
        },
        required: ['path', 'oldName', 'newName'],
      },
      // Rewrites source files on `apply: true`. `auto` + no declared
      // capability meant no confirmation prompt and no read-only-mode block —
      // `readonly-permission-policy` keys on `capabilities`, not `mutating`.
      permission: 'confirm',
      category: 'Development',
      mutating: true,
      capabilities: ['fs.write'],
      async execute(input: { path?: string; oldName?: string; newName?: string; apply?: boolean }) {
        if (!cfg.enabled) return { ok: false, error: 'smart-rename is disabled' };

        const rawPath = input.path;
        const oldName = input.oldName;
        const newName = input.newName;

        if (!rawPath || typeof rawPath !== 'string') {
          return { ok: false, error: 'path is required' };
        }
        if (!oldName || typeof oldName !== 'string' || oldName.length === 0) {
          return { ok: false, error: 'oldName is required' };
        }
        if (!newName || typeof newName !== 'string' || newName.length === 0) {
          return { ok: false, error: 'newName is required' };
        }
        // Both names must be plain identifiers. `newName` is substituted
        // directly into source, so accepting arbitrary text would let a
        // "rename" splice statements into the file — and `oldName` is used
        // to build the match, where non-identifier text makes the word
        // boundaries meaningless.
        if (!isIdentifier(oldName)) {
          return { ok: false, error: `oldName "${oldName}" is not a valid identifier` };
        }
        if (!isIdentifier(newName)) {
          return { ok: false, error: `newName "${newName}" is not a valid identifier` };
        }
        if (!withinProject(rawPath)) {
          return { ok: false, error: 'path is outside the project root' };
        }

        const ext = extname(rawPath).toLowerCase();
        if (!cfg.extensions.includes(ext)) {
          return { ok: false, error: `extension ${ext} is not allowed for rename` };
        }

        const resolved = resolve(process.cwd(), rawPath);
        let content: string;
        try {
          content = readFileSync(resolved, 'utf-8');
        } catch (err) {
          state.errorCount += 1;
          return { ok: false, error: String(err) };
        }

        const { preview, replacements } = renameInContent(content, oldName, newName);
        state.renameCount += 1;
        state.replacementCount += replacements;

        if (input.apply) {
          try {
            writeFileSync(resolved, preview, 'utf-8');
          } catch (err) {
            state.errorCount += 1;
            return { ok: false, error: String(err) };
          }
        }

        return {
          ok: true,
          path: relativePath(resolved),
          replacements,
          preview,
          applied: Boolean(input.apply),
        };
      },
    });

    api.log.info('smart-rename plugin loaded', {
      version: '0.1.0',
      extensions: cfg.extensions,
    });
  },

  teardown(api) {
    const final = {
      renames: state.renameCount,
      replacements: state.replacementCount,
      errors: state.errorCount,
    };
    state.renameCount = 0;
    state.replacementCount = 0;
    state.errorCount = 0;
    api.log.info('smart-rename: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `smart-rename: ${state.renameCount} rename(s), ${state.replacementCount} replacement(s)${state.errorCount ? ` (${state.errorCount} error(s))` : ''}`,
      counters: {
        renames: state.renameCount,
        replacements: state.replacementCount,
        errors: state.errorCount,
      },
    };
  },
};

export default plugin;
