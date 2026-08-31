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
import type { Plugin } from '@wrongstack/core/types';
import {
  clearLocalBinCache,
  releaseHandle,
  resolveExecInvocation,
  resolveNodeBin,
  withinProject,
} from '../runtime/index.js';

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
  'oxlint',
  'node',
  // Recognise a fully-qualified project-local path like
  // "./node_modules/.bin/biome"; basename check kicks in below.
]);

/** Package-runner heads whose first argument names the real tool. */
const PACKAGE_RUNNERS = new Set(['npx', 'pnpm', 'npm', 'yarn']);

/** Tool token → (npm package, bin name) for project-local resolution. */
const LOCAL_BIN_PACKAGES: Record<string, { packageName: string; binName: string }> = {
  biome: { packageName: '@biomejs/biome', binName: 'biome' },
  '@biomejs/biome': { packageName: '@biomejs/biome', binName: 'biome' },
  eslint: { packageName: 'eslint', binName: 'eslint' },
  oxlint: { packageName: 'oxlint', binName: 'oxlint' },
};

/**
 * Rewrite `npx <tool> …` into `node <tool-bin-entry> …` when the tool is a
 * project dependency.
 *
 * This is strictly better than launching the package runner: it skips
 * `npx`'s per-invocation resolution (and its ability to hit the network),
 * and it works identically on Windows, where `npx`/`pnpm` are `.cmd` shims
 * that `spawn` without a shell cannot launch at all. Returns `null` when
 * the tool is not installed locally, so the caller falls back to the
 * platform-adjusted PATH invocation.
 */
function resolveLocalToolCommand(tokens: readonly string[]): { cmd: string; args: string[] } | null {
  if (tokens.length === 0) return null;
  let i = 0;
  // Skip a leading package runner ("npx biome …", "pnpm exec biome …").
  if (PACKAGE_RUNNERS.has(tokens[i]!)) {
    i++;
    // Consume any run subcommands after the runner ("pnpm exec", "npm exec",
    // "yarn dlx", "pnpm dlx run" …) until the real tool token is reached.
    while (i < tokens.length && (tokens[i] === 'exec' || tokens[i] === 'dlx' || tokens[i] === 'run')) {
      i++;
    }
  }
  const toolToken = tokens[i];
  if (!toolToken) return null;
  const rest = tokens.slice(i + 1);
  const pkg = LOCAL_BIN_PACKAGES[toolToken];
  if (!pkg) return null;
  const local = resolveNodeBin(pkg.packageName, pkg.binName, process.cwd(), rest);
  if (!local) return null;
  return { cmd: local.cmd, args: local.args };
}

export function resolveAllowedCommand(command: string): { cmd: string; args: string[] } | null {
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const head = tokens[0]!;
  // Package runners (`npx some-other-package`) only pass when the resolved
  // tool token is a known linter. First-token allowlist of `npx` alone
  // would otherwise let an arbitrary package through.
  if (PACKAGE_RUNNERS.has(head)) {
    let i = 1;
    while (
      i < tokens.length &&
      (tokens[i] === 'exec' || tokens[i] === 'dlx' || tokens[i] === 'run')
    ) {
      i++;
    }
    const toolToken = tokens[i];
    if (!toolToken || !(toolToken in LOCAL_BIN_PACKAGES)) return null;
  }
  if (head === 'node') {
    const target = tokens[1];
    if (!target) return null;
    const base = basename(target);
    if (!(base in LOCAL_BIN_PACKAGES) && !ALLOWED_FIRST_TOKENS.has(base)) return null;
  }
  // Prefer the project-local binary: no package runner, no shell, no shim.
  // Defense-in-depth: only enter the local-resolution path when the first
  // token already passes the sandbox allowlist — the local path must never
  // widen what the allowlist below would accept.
  const local = ALLOWED_FIRST_TOKENS.has(head) ? resolveLocalToolCommand(tokens) : null;
  if (local) return local;
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
  const rawFallback = r['fallbackCommand'] ?? r['fallback_command'] ?? r['fallback'];
  const rawTimeout = r['timeoutMs'] ?? r['timeout_ms'] ?? r['timeout'];
  const rawNotify = r['notifyFormatOnSave'] ?? r['notify_format_on_save'] ?? r['notify'];
  return {
    enabled: r['enabled'] !== false,
    command:
      typeof r['command'] === 'string' && r['command'].length > 0 ? r['command'] : DEFAULTS.command,
    fallbackCommand:
      typeof rawFallback === 'string' && rawFallback.length > 0
        ? rawFallback
        : DEFAULTS.fallbackCommand,
    timeoutMs:
      typeof rawTimeout === 'number' && rawTimeout > 0
        ? rawTimeout
        : DEFAULTS.timeoutMs,
    notifyFormatOnSave: rawNotify !== false,
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

/** Cap captured output so a chatty linter cannot grow the heap unbounded. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

/**
 * Run a command, capture stdout/stderr, return exit code. Honors timeout
 * via AbortSignal. Uses `spawn` (not `execSync`) so the caller can mock
 * it from tests without spawning real processes.
 *
 * Timeout detection: `ChildProcess` has no `'abort'` event — the previous
 * listener for one never fired, so an aborted run surfaced through
 * `'error'` as `code: 127` ("binary not found") and spuriously triggered
 * the fallback command. The abort is now observed on the signal itself.
 */
function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd: string,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const settle = (r: SpawnResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const signal = AbortSignal.timeout(timeoutMs);
    const onAbort = (): void => {
      timedOut = true;
      settle({ code: null, stdout: '', stderr: '', timedOut: true });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let child: ReturnType<typeof spawn>;
    // Platform-adjust before spawning: `npx`/`pnpm`/`biome` are `.cmd`
    // shims on Windows and `spawn` without a shell ignores PATHEXT, so the
    // bare name failed ENOENT and this plugin never ran there at all.
    let invocation: { cmd: string; args: string[]; windowsVerbatimArguments: boolean };
    try {
      invocation = resolveExecInvocation(command, args);
    } catch {
      // Unsafe argument on the Windows shim path — refuse to run.
      signal.removeEventListener('abort', onAbort);
      settle({ code: 127, stdout: '', stderr: '', timedOut: false });
      return;
    }
    try {
      child = spawn(invocation.cmd, invocation.args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
        windowsHide: true,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch {
      // spawn() can throw synchronously (e.g. ENOENT) when the binary is
      // missing. Treat that as a non-zero exit with no output.
      signal.removeEventListener('abort', onAbort);
      settle({ code: 127, stdout: '', stderr: '', timedOut: false });
      return;
    }
    child.stdout?.on('data', (c: Buffer) => {
      stdoutBytes += c.length;
      if (stdoutBytes <= MAX_CAPTURE_BYTES) stdoutChunks.push(c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderrBytes += c.length;
      if (stderrBytes <= MAX_CAPTURE_BYTES) stderrChunks.push(c);
    });
    child.on('error', () => {
      // ENOENT / EPERM etc. — same handling as a thrown spawn. An abort
      // also lands here, but `onAbort` has already settled by then.
      signal.removeEventListener('abort', onAbort);
      settle({ code: 127, stdout: '', stderr: '', timedOut: false });
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (timedOut) return;
      settle({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        timedOut: false,
      });
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
  let mtimeBefore: number;
  try {
    const st = statSync(filePath);
    bytesBefore = st.size;
    mtimeBefore = st.mtimeMs;
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
  let mtimeAfter: number;
  try {
    const st = statSync(filePath);
    bytesAfter = st.size;
    mtimeAfter = st.mtimeMs;
  } catch {
    return null;
  }

  return {
    changed: bytesAfter !== bytesBefore || mtimeAfter > mtimeBefore,
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
    state.hookUnregister = releaseHandle(state.hookUnregister);
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
      const rawPath =
        inp['path'] ??
        inp['filePath'] ??
        inp['file_path'] ??
        inp['TargetFile'] ??
        inp['targetFile'] ??
        inp['file'];
      const filePath = typeof rawPath === 'string' ? rawPath : undefined;
      if (!filePath) return;

      // Only process TypeScript/JavaScript files.
      const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';
      if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.cts'].includes(ext)) return;

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

      if (/\boxlint\b/.test(result.command)) {
        return {
          additionalContext:
            `\n📦 import-organizer: oxlint has no import-organize support — ran ` +
            `'${result.command}' as a no-op for import sorting on '${filePath}'.`,
        };
      }

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
    // Mirror format-on-save: release the local-bin memo cache so a reload
    // re-resolves a changed toolchain (issue #367).
    clearLocalBinCache();
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
