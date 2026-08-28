/**
 * gitignore-guard plugin — repo hygiene for generated files.
 *
 * PostToolUse hook that detects writes of build-artifact-looking files
 * (`dist/`, `coverage/`, `node_modules/`, `*.env`, …) and either
 * *suggests* a `.gitignore` entry (default) or *appends* it for you.
 *
 * Deliberately orthogonal to path-guard: path-guard BLOCKS writes/edits
 * to protected paths (lockfiles, .env, .git, migrations); gitignore-guard
 * never blocks a tool — it keeps generated files out of the repository by
 * growing the project's `.gitignore`. Both hooks can be active at once.
 *
 * What counts as a build artifact is configurable (`artifactPatterns`),
 * with a curated high-precision default list. Patterns use gitignore-style
 * semantics implemented in `matchGitignorePattern`:
 *
 *   - trailing `/`   → directory pattern. Bare name (e.g. `dist/`) matches a
 *                      directory with that name at any depth; an internal slash
 *                      (e.g. `docs/generated/`) anchors it to the root.
 *   - contains `/`   → anchored glob matched against the path relative to
 *                      the project root, e.g. `docs/generated`
 *   - otherwise      → glob matched against the basename at any depth,
 *                      e.g. `*.env` matches `.env` and `config/.env`
 *
 * The hook only ever touches `.gitignore` files inside the project root
 * (containment is checked against the hook's `cwd`). In `append` mode it
 * appends missing pattern lines to the first existing `.gitignore` walking
 * from the root down toward the artifact, creating a root `.gitignore` when
 * none exists. It never rewrites or removes existing lines.
 *
 * Tools registered:
 * - gitignore_guard_status : config + per-session counters.
 * - gitignore_guard_append : append an entry for a path (or an explicit
 *   pattern) on demand — the completion path for a `suggest`-mode notice.
 *
 * Hooks registered:
 * - PostToolUse, matcher `write|edit`. Skips tool errors, paths outside
 *   the project, `.gitignore` writes themselves, paths that already match
 *   an existing `.gitignore` line, and paths matched by `ignorePatterns`.
 *
 * Config (`config.extensions['gitignore-guard']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,             // master switch
 *   "mode": "suggest",           // "suggest" | "append"
 *   "artifactPatterns": [...],   // patterns that flag a file as an artifact
 *   "ignorePatterns": [],        // patterns that never flag (opt-outs)
 *   "maxAppendPerCall": 5        // append cap per hook invocation
 * }
 * ```
 *
 * @public
 */

import { access, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Default artifact patterns
// ---------------------------------------------------------------------------

/**
 * Curated default list of build-artifact-looking names. High precision on
 * purpose: this hook fires on every write/edit, so the defaults avoid
 * ambiguous names (e.g. `build/` and `out/` are committed by some repos).
 * Users extend or replace the list via `config.extensions['gitignore-guard']`.
 */
export const DEFAULT_ARTIFACT_PATTERNS: readonly string[] = Object.freeze([
  'dist/',
  'coverage/',
  'node_modules/',
  '.next/',
  '.nuxt/',
  '.output/',
  '.cache/',
  '.parcel-cache/',
  '.turbo/',
  '.vite/',
  '.swc/',
  '.pytest_cache/',
  '.mypy_cache/',
  '__pycache__/',
  '.venv/',
  'venv/',
  'target/',
  '.eslintcache',
  '*.tsbuildinfo',
  '*.pyc',
  '*.env',
  '*.env.*',
]);

// ---------------------------------------------------------------------------
// Matching engine (gitignore-style)
// ---------------------------------------------------------------------------

function toForwardSlashes(p: string): string {
  // Normalize both the host separator and literal backslashes: project-relative
  // paths handed to the matcher can carry Windows-style separators regardless
  // of the host platform (CI runs Linux; tool callers run Windows).
  return p.split(sep).join('/').replaceAll('\\', '/');
}

/** Inner pattern of a single-`*`/`?` glob (no anchors) over path parts. */
function globToSource(glob: string): string {
  return glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
}

/** Convert a single-`*`/`?` glob into an anchored RegExp over path parts. */
function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globToSource(glob)}$`);
}

/**
 * Gitignore-style match of `pattern` against `relPath` (project-relative,
 * forward slashes). See the module doc for the three pattern shapes.
 */
export function matchGitignorePattern(relPath: string, pattern: string): boolean {
  const rel = toForwardSlashes(relPath).replace(/^\//, '');
  let pat = pattern.trim();
  if (pat.length === 0 || pat.startsWith('#')) return false;
  if (pat.startsWith('/')) {
    pat = pat.slice(1);
    if (pat.length === 0) return false;
  }
  const segments = rel.split('/');
  if (pat.endsWith('/')) {
    const dir = pat.slice(0, -1);
    if (dir.length === 0) return false;
    if (dir.includes('/')) {
      // Anchored directory pattern (internal slash): the named directory
      // sits at that exact path from the root — matches it and everything
      // beneath it, but not the same directory name elsewhere.
      return new RegExp(`^${globToSource(dir)}(?:/|$)`).test(rel);
    }
    // Bare directory name: matches a directory with that name at any depth.
    return segments.some((s) => s === dir);
  }
  if (pat.includes('/')) {
    return globToRegExp(toForwardSlashes(pat)).test(rel);
  }
  const base = segments[segments.length - 1] ?? '';
  return globToRegExp(pat).test(base);
}

/** First artifact pattern matching `relPath`, or null when none match. */
export function classifyArtifact(relPath: string, patterns: readonly string[]): string | null {
  for (const p of patterns) {
    if (matchGitignorePattern(relPath, p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// .gitignore helpers
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readGitignoreLines(file: string): Promise<readonly string[]> {
  if (!(await pathExists(file))) return [];
  try {
    const content = await readFile(file, 'utf8');
    return content.split(/\r?\n/);
  } catch {
    return [];
  }
}

/** True when any non-comment line already matches `relPath`. */
function isCoveredByLines(lines: readonly string[], relPath: string): boolean {
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (matchGitignorePattern(relPath, line)) return true;
  }
  return false;
}

/**
 * `.gitignore` paths that apply to a file at `relDir` ('' for the root):
 * root first, then one per directory level down to the file's directory.
 * The walk order matters — the hook appends to the first existing one.
 */
function gitignoreCandidates(relDir: string, root: string): string[] {
  const parts = relDir === '' ? [] : toForwardSlashes(relDir).split('/');
  const out: string[] = [join(root, '.gitignore')];
  let cur = root;
  for (const part of parts) {
    cur = join(cur, part);
    out.push(join(cur, '.gitignore'));
  }
  return out;
}

function relDirOf(rel: string): string {
  const idx = rel.lastIndexOf('/');
  return idx < 0 ? '' : rel.slice(0, idx);
}

/** First existing candidate (root-first), or null when none exists. */
async function firstExistingGitignore(candidates: readonly string[]): Promise<string | null> {
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return null;
}

/**
 * Append missing pattern lines to `target` (creating it when absent).
 * Never rewrites or removes existing lines; caps appends at `limit`.
 * Returns the patterns actually appended (empty when all present).
 */
async function appendPatterns(
  target: string,
  patterns: readonly string[],
  limit: number,
): Promise<{ appended: string[] }> {
  const existing = await readGitignoreLines(target);
  const seen = new Set(
    existing.map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#')),
  );
  const missing = patterns.filter((p) => !seen.has(p)).slice(0, limit);
  if (missing.length === 0) return { appended: [] };
  const current = (await pathExists(target)) ? await readFile(target, 'utf8') : '';
  const base = current.length === 0 ? '' : current.endsWith('\n') ? current : `${current}\n`;
  const next = `${base}${missing.map((p) => `${p}\n`).join('')}`;
  await writeFile(target, next, 'utf8');
  return { appended: missing };
}

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/**
 * Resolve `rawPath` against `cwd` and express it relative to the project
 * root. Returns null when the path escapes the project (relative path with
 * `..`, an absolute path outside the root, or an empty result).
 */
function projectRelativePath(
  rawPath: string,
  cwd: string | undefined,
): { abs: string; rel: string; root: string } | null {
  const root = cwd ?? process.cwd();
  const abs = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
  const rel = toForwardSlashes(relative(root, abs));
  if (rel.startsWith('..') || isAbsolute(rel) || rel === '') return null;
  return { abs, rel, root };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GitignoreGuardConfig {
  enabled: boolean;
  mode: 'suggest' | 'append';
  artifactPatterns: readonly string[];
  ignorePatterns: readonly string[];
  maxAppendPerCall: number;
}

export const DEFAULTS: GitignoreGuardConfig = {
  enabled: true,
  mode: 'suggest',
  artifactPatterns: DEFAULT_ARTIFACT_PATTERNS,
  ignorePatterns: [],
  maxAppendPerCall: 5,
};

/** Trim entries; drop blanks and `#` comments. */
function normalizePatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t.length === 0 || t.startsWith('#')) continue;
    out.push(t);
  }
  return out;
}

/** Read and validate config; every bad field falls back to its default. */
export function readConfig(raw: unknown): GitignoreGuardConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULTS, artifactPatterns: [...DEFAULTS.artifactPatterns] };
  }
  const r = raw as Record<string, unknown>;
  const artifact = normalizePatterns(r['artifactPatterns']);
  return {
    enabled: r['enabled'] !== false,
    mode: r['mode'] === 'append' ? 'append' : 'suggest',
    artifactPatterns: artifact.length > 0 ? artifact : [...DEFAULTS.artifactPatterns],
    ignorePatterns: normalizePatterns(r['ignorePatterns']),
    maxAppendPerCall:
      typeof r['maxAppendPerCall'] === 'number' &&
      Number.isInteger(r['maxAppendPerCall']) &&
      r['maxAppendPerCall'] > 0
        ? Math.min(r['maxAppendPerCall'], 50)
        : DEFAULTS.maxAppendPerCall,
  };
}

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

const state = {
  invocationCount: 0,
  /** Artifacts detected after ignore/coverage checks passed. */
  matchedCount: 0,
  /** Suggest-mode notices injected into the tool result. */
  suggestCount: 0,
  /** Lines appended to a .gitignore (hook or append tool). */
  appendCount: 0,
  /** Paths skipped because an existing .gitignore line already covers them. */
  coveredSkipCount: 0,
  errorCount: 0,
  /** Hook handle for teardown. */
  hookUnregister: null as null | (() => void),
  /** Last detection — surfaced by health() + status tool. */
  lastResult: null as null | {
    path: string;
    tool: string;
    pattern: string;
    mode: string;
    when: string;
  },
};

function clearRegistrations(): void {
  if (state.hookUnregister) {
    try {
      state.hookUnregister();
    } catch {
      // best-effort
    }
    state.hookUnregister = null;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'gitignore-guard',
  version: '0.1.0',
  description:
    'PostToolUse hook that suggests or appends .gitignore entries for build-artifact-looking files after every write or edit',
  apiVersion: API_VERSION,
  capabilities: { hooks: true, tools: true },
  configFields: {
    enabled: { lifecycle: 'hot' },
    mode: { lifecycle: 'hot' },
    artifactPatterns: { lifecycle: 'hot' },
    ignorePatterns: { lifecycle: 'hot' },
    maxAppendPerCall: { lifecycle: 'hot' },
  },
  defaultConfig: {
    enabled: DEFAULTS.enabled,
    mode: DEFAULTS.mode,
    artifactPatterns: [...DEFAULTS.artifactPatterns],
    ignorePatterns: [],
    maxAppendPerCall: DEFAULTS.maxAppendPerCall,
  },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: true,
        description: 'Master switch. When false, the hook is a no-op.',
      },
      mode: {
        type: 'string',
        enum: ['suggest', 'append'],
        default: 'suggest',
        description:
          '"suggest" injects a notice into the tool result; "append" writes the missing pattern to a .gitignore automatically.',
      },
      artifactPatterns: {
        type: 'array',
        items: { type: 'string' },
        default: [...DEFAULTS.artifactPatterns],
        description:
          'Gitignore-style patterns that flag a written file as a build artifact. Empty array falls back to the curated defaults.',
      },
      ignorePatterns: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description:
          'Gitignore-style patterns that never flag a file, even when artifactPatterns matches. Use for intentionally-committed generated files.',
      },
      maxAppendPerCall: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 5,
        description: 'Maximum number of lines appended per hook invocation.',
      },
    },
  },

  async setup(api) {
    // Idempotent re-init (H1 pattern): unregister any previous hook before
    // resetting counters so a plugin reload cannot stack duplicate callbacks.
    clearRegistrations();
    state.invocationCount = 0;
    state.matchedCount = 0;
    state.suggestCount = 0;
    state.appendCount = 0;
    state.coveredSkipCount = 0;
    state.errorCount = 0;
    state.lastResult = null;

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
      cwd?: string | undefined;
    }): Promise<{ additionalContext?: string | undefined } | void> => {
      // Config is read per invocation so every field is hot-reloadable.
      const cfg = readConfig(api.config.extensions?.['gitignore-guard']);
      if (!cfg.enabled) return;

      // Skip if the tool errored — the file may not have been written.
      if (input.toolResult?.isError) return;

      const toolName = input.toolName ?? '';
      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawPath = inp['path'];
      if (typeof rawPath !== 'string' || rawPath.trim().length === 0) return;
      // Never flag .gitignore writes themselves (avoids feedback loops).
      if (basename(rawPath) === '.gitignore') return;

      const resolved = projectRelativePath(rawPath, input.cwd);
      if (!resolved) return;

      state.invocationCount += 1;

      const matched = classifyArtifact(resolved.rel, cfg.artifactPatterns);
      if (!matched) return;
      if (classifyArtifact(resolved.rel, cfg.ignorePatterns)) return;
      state.matchedCount += 1;

      // Already ignored by an existing .gitignore line (root down to the
      // file's dir)? Then there is nothing to suggest or append.
      const candidates = gitignoreCandidates(relDirOf(resolved.rel), resolved.root);
      for (const candidate of candidates) {
        const lines = await readGitignoreLines(candidate);
        if (isCoveredByLines(lines, resolved.rel)) {
          state.coveredSkipCount += 1;
          return;
        }
      }

      state.lastResult = {
        path: resolved.rel,
        tool: toolName,
        pattern: matched,
        mode: cfg.mode,
        when: new Date().toISOString(),
      };

      if (cfg.mode === 'append') {
        const nearest = await firstExistingGitignore(candidates);
        const target = nearest ?? join(resolved.root, '.gitignore');
        const { appended } = await appendPatterns(target, [matched], cfg.maxAppendPerCall);
        if (appended.length === 0) {
          state.coveredSkipCount += 1;
          return;
        }
        state.appendCount += 1;
        api.metrics.counter('append');
        api.log.info(`gitignore-guard: appended '${matched}' to ${target}`, {
          path: resolved.rel,
          tool: toolName,
        });
        return {
          additionalContext:
            `\n📦 gitignore-guard: '${resolved.rel}' looks like a build artifact (pattern '${matched}'). ` +
            `Appended '${matched}' to ${target}.`,
        };
      }

      state.suggestCount += 1;
      api.metrics.counter('suggest');
      api.log.info(`gitignore-guard: suggested '${matched}' for ${resolved.rel}`, {
        path: resolved.rel,
        tool: toolName,
      });
      return {
        additionalContext:
          `\n📦 gitignore-guard: '${resolved.rel}' looks like a build artifact (pattern '${matched}'). ` +
          `Add '${matched}' to .gitignore — call the gitignore_guard_append tool with ` +
          `path: "${resolved.rel}" to append it now, or set config mode to "append" to do this automatically.`,
      };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, {
      name: 'gitignore-guard',
    });

    // --- gitignore_guard_status tool ---
    api.tools.register({
      name: 'gitignore_guard_status',
      description:
        'Reports gitignore-guard state: mode, active pattern lists, and per-session suggest/append/skip counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Code Quality',
      mutating: false,
      async execute() {
        const cfg = readConfig(api.config.extensions?.['gitignore-guard']);
        return {
          ok: true,
          enabled: cfg.enabled,
          mode: cfg.mode,
          artifactPatterns: cfg.artifactPatterns,
          ignorePatterns: cfg.ignorePatterns,
          maxAppendPerCall: cfg.maxAppendPerCall,
          counters: {
            invocations: state.invocationCount,
            matched: state.matchedCount,
            suggests: state.suggestCount,
            appends: state.appendCount,
            coveredSkips: state.coveredSkipCount,
            errors: state.errorCount,
          },
          lastResult: state.lastResult,
        };
      },
    });

    // --- gitignore_guard_append tool ---
    api.tools.register({
      name: 'gitignore_guard_append',
      description:
        'Appends a .gitignore entry for a build-artifact-looking path (or an explicit pattern). Use after gitignore-guard suggests an entry, or to ignore a generated file proactively.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Path of the artifact file or directory, relative to the project root or absolute.',
          },
          pattern: {
            type: 'string',
            description:
              'Optional explicit gitignore pattern to append. When omitted, the pattern is derived from the path via artifactPatterns.',
          },
        },
        required: ['path'],
      },
      permission: 'auto',
      category: 'Code Quality',
      mutating: true,
      async execute(input: { path?: unknown; pattern?: unknown }) {
        const rawPath = typeof input?.path === 'string' ? input.path : '';
        if (rawPath.length === 0) return { ok: false, reason: 'path is required' };

        const resolved = projectRelativePath(rawPath, process.cwd());
        if (!resolved) {
          return { ok: false, reason: `path outside project root: ${rawPath}` };
        }

        const cfg = readConfig(api.config.extensions?.['gitignore-guard']);
        const explicit =
          typeof input?.pattern === 'string' && input.pattern.trim().length > 0
            ? input.pattern.trim()
            : null;
        const pattern = explicit ?? classifyArtifact(resolved.rel, cfg.artifactPatterns);
        if (!pattern) {
          return {
            ok: false,
            reason: `'${resolved.rel}' does not match any configured artifact pattern; pass an explicit pattern`,
          };
        }

        const candidates = gitignoreCandidates(relDirOf(resolved.rel), resolved.root);
        const nearest = await firstExistingGitignore(candidates);
        const target = nearest ?? join(resolved.root, '.gitignore');
        const { appended } = await appendPatterns(target, [pattern], cfg.maxAppendPerCall);
        if (appended.length === 0) {
          state.coveredSkipCount += 1;
          return { ok: true, alreadyCovered: true, gitignore: target, appended: [] };
        }
        state.appendCount += 1;
        api.log.info(`gitignore-guard: manual append '${pattern}' to ${target}`, {
          path: resolved.rel,
        });
        return { ok: true, alreadyCovered: false, gitignore: target, appended };
      },
    });

    api.log.info('gitignore-guard plugin loaded', {
      version: '0.1.0',
      mode: readConfig(api.config.extensions?.['gitignore-guard']).mode,
    });
  },

  teardown(api) {
    clearRegistrations();
    const final = {
      invocations: state.invocationCount,
      matched: state.matchedCount,
      suggests: state.suggestCount,
      appends: state.appendCount,
      coveredSkips: state.coveredSkipCount,
      errors: state.errorCount,
    };
    state.invocationCount = 0;
    state.matchedCount = 0;
    state.suggestCount = 0;
    state.appendCount = 0;
    state.coveredSkipCount = 0;
    state.errorCount = 0;
    state.lastResult = null;
    api.log.info('gitignore-guard: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastResult === null
          ? `gitignore-guard: ${state.invocationCount} invocation(s), ${state.suggestCount} suggested, ${state.appendCount} appended, ${state.coveredSkipCount} already-covered`
          : `gitignore-guard: last '${state.lastResult.pattern}' for ${state.lastResult.path} (${state.lastResult.tool}, ${state.lastResult.mode} mode) at ${state.lastResult.when}`,
      counters: {
        invocations: state.invocationCount,
        matched: state.matchedCount,
        suggests: state.suggestCount,
        appends: state.appendCount,
        coveredSkips: state.coveredSkipCount,
        errors: state.errorCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;
