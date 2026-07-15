/**
 * import-organizer plugin — PostToolUse hook that re-sorts and
 * de-duplicates imports in a file after every `write` or `edit`.
 *
 * This is a heavier, post-write step than `format-on-save` (which only
 * handles whitespace/formatting). It runs `biome check --write --unsafe`
 * (or `eslint --fix` as a fallback) on the saved file. The `--unsafe`
 * flag enables import-organization rules:
 *  - Sort imports alphabetically within import groups
 *  - Group by source (builtin, external, internal, relative)
 *  - Remove unused imports
 *  - Merge duplicate imports from the same module
 *
 * Tools registered:
 *  - import_organizer_status : Show config + per-session counters
 *    (invocations / organized / clean / errors + lastResult).
 *
 * Hooks registered:
 *  - PostToolUse with matcher `write|edit`. After the tool completes,
 *    runs the configured command on the file on disk. The hook reads
 *    the file fresh from disk (so `edit` tool's post-edit state is
 *    captured) and detects whether the file changed via byte-count
 *    comparison. If the file was modified, returns `additionalContext`
 *    so the LLM sees that imports were reorganized.
 *
 * Linter detection is lazy: on the first hook invocation, the plugin
 * tries `biome` first (since `--unsafe` is required for import
 * organization), then falls back to `eslint --fix`. If neither
 * succeeds, the hook logs a one-time warning and becomes a no-op for
 * the rest of the session. Linter presence is re-checked on every
 * setup() call so plugin reload can recover if a linter is installed
 * mid-session.
 *
 * Config (`config.extensions['import-organizer']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "command": "npx @biomejs/biome check --write --unsafe",
 *   "fallbackCommand": "npx eslint --fix",
 *   "timeoutMs": 10000
 * }
 * ```
 *
 * @public
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import type { Plugin } from '@wrongstack/core';
import { withinProject } from '../runtime/index.js';

// ---------------------------------------------------------------------------
// Sandbox + command allowlist. import-organizer already uses spawn() with
// argv (no shell interpolation), so file paths cannot break out of the
// command. The remaining risk: the `command` config field lets a config-
// writer set an arbitrary first token, which spawn will execute directly.
// Lock down that first token to a known set of linter binaries.
// ---------------------------------------------------------------------------
// withinProject() imported from ../runtime/index.js

const ALLOWED_FIRST_TOKENS = new Set<string>([
  'npx',
  'pnpm',
  'npm',
  'yarn',
  'biome',
  '@biomejs/biome',
  'eslint',
  'node',
  // Recognise a fully-qualified project-local path like
  // "./node_modules/.bin/biome"; basename check kicks in below.
]);

function resolveAllowedCommand(command: string): { cmd: string; args: string[] } | null {
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const head = tokens[0]!;
  if (ALLOWED_FIRST_TOKENS.has(head)) {
    return { cmd: head, args: tokens.slice(1) };
  }
  if (isAbsolute(head)) {
    if (!withinProject(head)) return null;
    const base = basename(head);
    if (ALLOWED_FIRST_TOKENS.has(base)) return { cmd: head, args: tokens.slice(1) };
  }
  // Allow relative paths under project root (./node_modules/.bin/biome).
  if (!isAbsolute(head) && withinProject(head)) {
    const base = basename(head);
    if (ALLOWED_FIRST_TOKENS.has(base)) return { cmd: head, args: tokens.slice(1) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface OrganizeState {
  /** Total hook invocations (regardless of outcome). */
  invocationCount: number;
  /** Times imports were actually reorganized (file changed). */
  organizedCount: number;
  /** Times the file was already organized (no change after run). */
  cleanCount: number;
  /** Times the linter was unavailable, timed out, or errored. */
  errorCount: number;
  /** Hook handle for teardown. */
  hookUnregister: null | (() => void);
  /** Last invocation result — surfaced by health() + status tool. */
  lastResult: null | {
    path: string;
    tool: string;
    changed: boolean;
    bytesBefore: number;
    bytesAfter: number;
    when: string;
  };
  /** Whether the linter probe has completed yet (lazy). */
  probeComplete: boolean;
  /** True if the linter command was found at last probe. */
  linterAvailable: boolean;
}

const state: OrganizeState = {
  invocationCount: 0,
  organizedCount: 0,
  cleanCount: 0,
  errorCount: 0,
  hookUnregister: null,
  lastResult: null,
  probeComplete: false,
  linterAvailable: false,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ImportOrganizerConfig {
  enabled: boolean;
  command: string;
  fallbackCommand: string;
  timeoutMs: number;
  /**
   * When true (default), emit `import-organizer:done` after every
   * successful linter run. The `format-on-save` plugin listens for
   * this and skips its own `biome format --write` pass when
   * import-organizer just touched the same path — saving one biome
   * invocation per write/edit.
   *
   * Set to false only if you specifically want both plugins to run
   * unconditionally (e.g. for stricter CI parity).
   */
  notifyFormatOnSave: boolean;
}

const DEFAULTS: ImportOrganizerConfig = {
  enabled: true,
  command: 'npx @biomejs/biome check --write --unsafe',
  fallbackCommand: 'npx eslint --fix',
  timeoutMs: 10_000,
  notifyFormatOnSave: true,
};

function readConfig(raw: unknown): ImportOrganizerConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    command:
      typeof r['command'] === 'string' && r['command'].length > 0 ? r['command'] : DEFAULTS.command,
    fallbackCommand:
      typeof r['fallbackCommand'] === 'string' && r['fallbackCommand'].length > 0
        ? r['fallbackCommand']
        : DEFAULTS.fallbackCommand,
    timeoutMs:
      typeof r['timeoutMs'] === 'number' && r['timeoutMs'] > 0
        ? r['timeoutMs']
        : DEFAULTS.timeoutMs,
    notifyFormatOnSave: r['notifyFormatOnSave'] !== false,
  };
}

// ---------------------------------------------------------------------------
// Linter invocation
// ---------------------------------------------------------------------------

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a command, capture stdout/stderr, return exit code. Honors timeout
 * via AbortSignal. Uses `spawn` (not `execSync`) so the caller can mock
 * it from tests without spawning real processes.
 */
function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd: string,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // spawn() can throw synchronously (e.g. ENOENT) when the binary is
      // missing. Treat that as a non-zero exit with no output.
      resolve({ code: 127, stdout: '', stderr: '', timedOut: false });
      return;
    }
    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));
    child.on('error', () => {
      // ENOENT / EPERM etc. — same handling as a thrown spawn.
      resolve({ code: 127, stdout: '', stderr: '', timedOut: false });
    });
    child.on('close', (code) => {
      if (timedOut) return;
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        timedOut: false,
      });
    });
    child.on('abort', () => {
      timedOut = true;
      resolve({ code: null, stdout: '', stderr: '', timedOut: true });
    });
  });
}

interface OrganizeResult {
  changed: boolean;
  bytesBefore: number;
  bytesAfter: number;
  command: string;
  stderr: string;
}

/**
 * Run the configured linter on a file. If the primary command is not
 * installed (exit 127), falls back to the fallback command. If both
 * fail, returns null so the caller can record an error and skip.
 */
async function organizeImports(
  filePath: string,
  cfg: ImportOrganizerConfig,
  cwd: string,
): Promise<OrganizeResult | null> {
  // Sandbox: refuse to lint files outside the project root. Without
  // this guard a prompt-injected write/edit with a host-FS path could
  // pivot the linter into reading and rewriting arbitrary files.
  if (!withinProject(filePath)) return null;
  if (!existsSync(filePath)) return null;

  let bytesBefore: number;
  try {
    bytesBefore = statSync(filePath).size;
  } catch {
    return null;
  }

  // Command allowlist: the primary command's first token must resolve
  // to a known linter. Without this guard, a config-supplied `command`
  // would let an attacker pivot the post-save hook into spawning
  // arbitrary processes.
  const primary = resolveAllowedCommand(cfg.command);
  if (!primary) return null;
  const [primaryCmd, ...primaryArgs] = [primary.cmd, ...primary.args] as [string, ...string[]];

  let result = await runCommand(primaryCmd, [...primaryArgs, filePath], cfg.timeoutMs, cwd);
  let usedCommand = cfg.command;

  if (result.code === 127 && cfg.fallbackCommand) {
    const fallback = resolveAllowedCommand(cfg.fallbackCommand);
    if (fallback) {
      const [fbCmd, ...fbArgs] = [fallback.cmd, ...fallback.args] as [string, ...string[]];
      result = await runCommand(fbCmd, [...fbArgs, filePath], cfg.timeoutMs, cwd);
      usedCommand = cfg.fallbackCommand;
    }
  }

  if (result.timedOut || result.code === null) return null;
  if (result.code === 127) return null; // neither linter found

  let bytesAfter: number;
  try {
    bytesAfter = statSync(filePath).size;
  } catch {
    return null;
  }

  return {
    changed: bytesAfter !== bytesBefore,
    bytesBefore,
    bytesAfter,
    command: usedCommand,
    stderr: result.stderr,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'import-organizer',
  version: '0.1.0',
  description:
    'PostToolUse hook that re-sorts and de-duplicates imports in a file after every write or edit',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: true,
        description: 'Master switch. When false, the hook is a no-op.',
      },
      command: {
        type: 'string',
        default: DEFAULTS.command,
        description:
          'Primary linter command. Use the `--write` (or `--fix`) flag and biome-specific `--unsafe` so import organization runs.',
      },
      fallbackCommand: {
        type: 'string',
        default: DEFAULTS.fallbackCommand,
        description:
          'Fallback command (e.g. `eslint --fix`) used when the primary linter is not installed.',
      },
      timeoutMs: {
        type: 'number',
        minimum: 1000,
        default: 10_000,
        description: 'Per-invocation linter timeout in milliseconds.',
      },
      notifyFormatOnSave: {
        type: 'boolean',
        default: true,
        description:
          'Emit `import-organizer:done` after each successful run so `format-on-save` can skip its redundant `biome format --write` pass on the same file. Set false to keep both running unconditionally.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.organizedCount = 0;
    state.cleanCount = 0;
    state.errorCount = 0;
    state.hookUnregister = null;
    state.lastResult = null;
    state.probeComplete = false;
    state.linterAvailable = false;

    const cfg = readConfig(api.config.extensions?.['import-organizer']);

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{ additionalContext?: string } | void> => {
      if (!cfg.enabled) return;

      // Skip if the write/edit itself errored.
      if (input.toolResult?.isError) return;

      const toolName = input.toolName ?? '';
      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const filePath = inp['path'] as string | undefined;
      if (!filePath || typeof filePath !== 'string') return;

      // Only process TypeScript/JavaScript files.
      const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';
      if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'].includes(ext)) return;

      state.invocationCount += 1;

      const result = await organizeImports(filePath, cfg, process.cwd());
      if (!result) {
        if (!state.linterAvailable) {
          state.linterAvailable = false; // first probe failed
          state.probeComplete = true;
          api.log.warn(
            'import-organizer: no linter available — hook will be a no-op for the rest of the session',
          );
        }
        state.errorCount += 1;
        return;
      }

      state.linterAvailable = true;
      state.probeComplete = true;

      // Cross-plugin coordination: announce that we just ran the
      // linter (which, for `biome check --write --unsafe` or any
      // `eslint --fix`-shaped command, also applies formatting).
      // format-on-save listens for this so it can skip its own
      // `biome format --write` pass on the same file.
      if (cfg.notifyFormatOnSave) {
        api.emitCustom('import-organizer:done', {
          path: filePath,
          changed: result.changed,
          command: result.command,
          when: new Date().toISOString(),
        });
      }

      state.lastResult = {
        path: filePath,
        tool: toolName,
        changed: result.changed,
        bytesBefore: result.bytesBefore,
        bytesAfter: result.bytesAfter,
        when: new Date().toISOString(),
      };

      if (result.changed) {
        state.organizedCount += 1;
        const delta = result.bytesAfter - result.bytesBefore;
        api.log.info(`import-organizer: reorganized imports in ${filePath}`, {
          tool: toolName,
          command: result.command,
          delta: `${delta >= 0 ? '+' : ''}${delta} bytes`,
        });
        return {
          additionalContext:
            `\n📦 import-organizer: organized imports in '${filePath}' after ${toolName}. ` +
            `Imports have been sorted, grouped, and unused imports removed (${delta >= 0 ? '+' : ''}${delta} bytes).`,
        };
      }

      state.cleanCount += 1;
      // Don't surface anything when nothing changed — keeps the context window clean.
      if (result.stderr.trim().length > 0) {
        return {
          additionalContext: `\n📦 import-organizer: '${filePath}' was already clean, but the linter reported:\n${result.stderr.trim()}`,
        };
      }
      return;
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook as never, { background: true });

    // --- import_organizer_status tool ---
    api.tools.register({
      name: 'import_organizer_status',
      description:
        'Reports import-organizer state: linter availability, config, and per-session organized/clean/error counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Code Quality',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          command: cfg.command,
          fallbackCommand: cfg.fallbackCommand,
          timeoutMs: cfg.timeoutMs,
          linterAvailable: state.linterAvailable,
          counters: {
            invocations: state.invocationCount,
            organized: state.organizedCount,
            clean: state.cleanCount,
            errors: state.errorCount,
          },
          lastResult: state.lastResult,
        };
      },
    });

    api.log.info('import-organizer plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      command: cfg.command,
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
      organized: state.organizedCount,
      clean: state.cleanCount,
      errors: state.errorCount,
    };
    state.invocationCount = 0;
    state.organizedCount = 0;
    state.cleanCount = 0;
    state.errorCount = 0;
    state.lastResult = null;
    state.probeComplete = false;
    state.linterAvailable = false;
    api.log.info('import-organizer: teardown complete', { final });
  },

  async health() {
    const base = `import-organizer: ${state.invocationCount} invocation(s), ${state.organizedCount} organized, ${state.cleanCount} clean, ${state.errorCount} error(s)`;
    const linterNote = state.probeComplete
      ? state.linterAvailable
        ? ' (linter: ok)'
        : ' (linter: missing)'
      : ' (linter: not yet probed)';
    return {
      ok: true,
      message: base + linterNote,
      counters: {
        invocations: state.invocationCount,
        organized: state.organizedCount,
        clean: state.cleanCount,
        errors: state.errorCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;
