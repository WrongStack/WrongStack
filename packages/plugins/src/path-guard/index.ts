/**
 * path-guard plugin — blocks (or warns about) writes, edits, and
 * destructive shell commands that touch protected paths.
 *
 * `branch-guard` protects git *branches*; this plugin protects
 * *files and directories*. A `PreToolUse` hook on `write|edit|bash`
 * matches the target path against a configurable glob list:
 *
 *  - `write` / `edit` → the `path` / `file_path` input field
 *  - `bash`           → destructive commands only (`rm`, `rmdir`,
 *    `mv`, `del`, output redirection `>` / `>>`, `truncate`) whose
 *    arguments mention a protected path
 *
 * Default protected set: lockfiles, `.env*` secrets, `.git/`
 * internals, and production migration folders — files an agent
 * should virtually never rewrite by hand.
 *
 * Config (`config.extensions['path-guard']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "mode": "block",                     // "block" | "warn"
 *   "protect": ["pnpm-lock.yaml", ".env*", ".git/**", "**&#47;migrations/**"],
 *   "allow": []                          // globs that override protect
 * }
 * ```
 *
 * Toggle off with `{ "name": "path-guard", "enabled": false }` in
 * `config.plugins`, or `"enabled": false` in the options above.
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface PathGuardState {
  invocations: number;
  blocks: number;
  warns: number;
  lastBlock: { path: string; tool: string; when: string } | null;
  hookUnregister: null | (() => void);
}

const state: PathGuardState = {
  invocations: 0,
  blocks: 0,
  warns: 0,
  lastBlock: null,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface PathGuardConfig {
  enabled: boolean;
  mode: 'block' | 'warn';
  protect: string[];
  allow: string[];
}

const DEFAULT_PROTECT = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  '.env',
  '.env.*',
  '.git/**',
  '**/migrations/**',
];

const DEFAULTS: PathGuardConfig = {
  enabled: true,
  mode: 'block',
  protect: DEFAULT_PROTECT,
  allow: [],
};

function readConfig(raw: unknown): PathGuardConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS, protect: [...DEFAULT_PROTECT] };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    mode: r['mode'] === 'warn' ? 'warn' : 'block',
    protect: Array.isArray(r['protect'])
      ? r['protect'].filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [...DEFAULT_PROTECT],
    allow: Array.isArray(r['allow'])
      ? r['allow'].filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [],
  };
}

// ---------------------------------------------------------------------------
// Glob matching (dependency-free, deliberately simple)
// ---------------------------------------------------------------------------

/**
 * Compile a glob pattern to a RegExp. Supports `**` (any depth),
 * `*` (within one segment), and `?` (single char). Matching is done
 * against forward-slash-normalized relative-ish paths, and a pattern
 * without a slash matches the basename anywhere in the tree
 * (`.env` matches `sub/dir/.env`).
 */
export function compilePathGlob(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  let source = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // `**/` or trailing `**` — any depth including nothing.
        source += '(?:.*)';
        i += 1;
        if (normalized[i + 1] === '/') i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else if (ch !== undefined && /[.+^${}()|[\]\\]/.test(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  // Anchored at a segment boundary so `.env` also matches `sub/dir/.env`
  // and `a/b` matches `repo/a/b` but never `xa/b`.
  return new RegExp(`(?:^|/)${source}$`, 'i');
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchesAny(path: string, patterns: RegExp[]): boolean {
  const normalized = normalizePath(path);
  return patterns.some((re) => re.test(normalized));
}

/**
 * Extract candidate target paths from a shell command, but only when
 * the command looks destructive. Non-destructive commands (cat, ls,
 * grep …) never trigger the guard, even if they mention a protected
 * path.
 */
export function destructiveTargets(command: string): string[] {
  const targets: string[] = [];
  // rm/rmdir/del/unlink/truncate/mv/shred <args...>
  const destructive =
    /(?:^|[;&|]\s*)(?:sudo\s+)?(rm|rmdir|del|unlink|truncate|shred|mv)\s+([^;&|]+)/gi;
  let m: RegExpExecArray | null = destructive.exec(command);
  while (m !== null) {
    const args = (m[2] ?? '').split(/\s+/).filter((a) => a.length > 0 && !a.startsWith('-'));
    // For `mv src dst` both sides are candidates (overwrite either way).
    targets.push(...args);
    m = destructive.exec(command);
  }
  // Output redirection: `... > file` / `... >> file`
  const redirect = />{1,2}\s*([^\s;&|>]+)/g;
  let r: RegExpExecArray | null = redirect.exec(command);
  while (r !== null) {
    const target = r[1];
    if (target && target !== '/dev/null' && target !== 'NUL' && target !== 'nul') {
      targets.push(target);
    }
    r = redirect.exec(command);
  }
  return targets.map((t) => t.replace(/^['"]|['"]$/g, ''));
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'path-guard',
  version: '0.1.0',
  description:
    'Blocks or warns about writes, edits, and destructive shell commands touching protected paths (lockfiles, .env, .git, migrations)',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      mode: {
        type: 'string',
        enum: ['block', 'warn'],
        default: 'block',
        description: 'block = refuse the operation; warn = only inject context.',
      },
      protect: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns for protected paths. Replaces the default set when present.',
      },
      allow: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description: 'Glob patterns that override `protect` (exemptions).',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocations = 0;
    state.blocks = 0;
    state.warns = 0;
    state.lastBlock = null;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['path-guard']);
    const protectRes = cfg.protect.map(compilePathGlob);
    const allowRes = cfg.allow.map(compilePathGlob);

    const verdict = (path: string, tool: string, operation: string) => {
      if (cfg.mode === 'block') {
        state.blocks += 1;
        state.lastBlock = { path, tool, when: new Date().toISOString() };
        api.metrics.counter('blocks');
        return {
          decision: 'block' as const,
          reason:
            `path-guard: "${path}" is a protected path (matched by config.extensions["path-guard"].protect) — ${operation} refused. ` +
            'If this change is intentional, ask the user to do it, add an `allow` glob, or set mode: "warn".',
        };
      }
      state.warns += 1;
      api.metrics.counter('warns');
      return {
        decision: 'allow' as const,
        additionalContext:
          `path-guard (warn mode): "${path}" is a protected path and this ${operation} would modify it. ` +
          'Double-check this is intentional.',
      };
    };

    const hook = (input: { toolName?: string | undefined; toolInput?: unknown }) => {
      if (!cfg.enabled) return;
      state.invocations += 1;
      const toolName = input.toolName ?? '';
      const ti = (input.toolInput ?? {}) as Record<string, unknown>;

      if (toolName === 'write' || toolName === 'edit') {
        const raw = ti['path'] ?? ti['file_path'] ?? ti['filePath'];
        if (typeof raw !== 'string' || raw.length === 0) return;
        if (matchesAny(raw, allowRes)) return;
        if (matchesAny(raw, protectRes)) {
          return verdict(raw, toolName, toolName === 'write' ? 'write' : 'edit');
        }
        return;
      }

      if (toolName === 'bash' || toolName === 'exec') {
        const command = typeof ti['command'] === 'string' ? ti['command'] : '';
        if (!command) return;
        for (const target of destructiveTargets(command)) {
          if (matchesAny(target, allowRes)) continue;
          if (matchesAny(target, protectRes)) {
            return verdict(target, toolName, 'destructive shell command');
          }
        }
      }
      return;
    };

    state.hookUnregister = api.registerHook('PreToolUse', 'write|edit|bash|exec', hook as never);

    // ── path_guard_status tool ────────────────────────────────────────
    api.tools.register({
      name: 'path_guard_status',
      description:
        'Reports path-guard state: protected globs, mode, and counters (invocations, blocks, warns).',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          mode: cfg.mode,
          protect: cfg.protect,
          allow: cfg.allow,
          counters: {
            invocations: state.invocations,
            blocks: state.blocks,
            warns: state.warns,
          },
          lastBlock: state.lastBlock,
        };
      },
    });

    api.log.info('path-guard plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      mode: cfg.mode,
      protectCount: cfg.protect.length,
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
    const final = { invocations: state.invocations, blocks: state.blocks, warns: state.warns };
    state.invocations = 0;
    state.blocks = 0;
    state.warns = 0;
    state.lastBlock = null;
    api.log.info('path-guard: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastBlock === null
          ? `path-guard: ${state.invocations} invocation(s), ${state.blocks} block(s), ${state.warns} warn(s)`
          : `path-guard: last block on "${state.lastBlock.path}" (${state.lastBlock.tool}) at ${state.lastBlock.when}`,
      counters: {
        invocations: state.invocations,
        blocks: state.blocks,
        warns: state.warns,
      },
    };
  },
};

export default plugin;
