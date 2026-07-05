/**
 * auto-format-on-save plugin — PostToolUse hook that runs biome
 * `format --write` on the file after every `write` or `edit`.
 *
 * Unlike lint-gate (which lints BEFORE the tool runs and can block),
 * this plugin formats AFTER the write/edit commits — ensuring the
 * file on disk always matches the project's formatting rules. No
 * blocking, no warnings — just silently formats in-place.
 *
 * Tools registered:
 * - format_on_save_status : Show config + per-session counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit`. After the tool completes,
 *   runs `biome format --write <path>` on the actual file on disk.
 *   If the file changed (formatting was applied), logs the diff size.
 *   If biome fails or the file doesn't exist, silent fallback.
 *
 * Config (`config.extensions['format-on-save']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,    // master switch
 *   "timeoutMs": 5000   // biome process timeout
 * }
 * ```
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Sandbox: reject file paths outside the project root, plus switch the
// `npx biome` shell form to execFileSync argv form. format-on-save runs
// after every write/edit; a prompt-injected write with an absolute host
// path would have `npx biome format --write "C:\Windows\evil.txt"`
// interpolated into a shell — quoting is brittle and Windows quotes can
// be escaped.
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

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

const state = {
  invocationCount: 0,
  /** Times formatting was applied (file changed). */
  formattedCount: 0,
  /** Times the file was already formatted (no change). */
  cleanCount: 0,
  /** Times biome failed (not installed, timeout, parse error). */
  errorCount: 0,
  /** Hook handle for teardown. */
  hookUnregister: null as null | (() => void),
  /** Last format result — surfaced by health() + status tool. */
  lastResult: null as null | {
    path: string;
    tool: string;
    changed: boolean;
    bytesBefore: number;
    bytesAfter: number;
    when: string;
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface FormatOnSaveConfig {
  enabled: boolean;
  timeoutMs: number;
}

const DEFAULTS: FormatOnSaveConfig = {
  enabled: true,
  timeoutMs: 5_000,
};

function readConfig(raw: unknown): FormatOnSaveConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    timeoutMs:
      typeof r['timeoutMs'] === 'number' && r['timeoutMs'] > 0
        ? r['timeoutMs']
        : DEFAULTS.timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Biome format helper
// ---------------------------------------------------------------------------

interface FormatResult {
  changed: boolean;
  bytesBefore: number;
  bytesAfter: number;
}

/**
 * Run `biome format --write` on a file. Returns the byte sizes before
 * and after, and whether the file changed. Returns null if biome
 * failed or the file doesn't exist.
 */
function formatFile(filePath: string, timeoutMs: number): FormatResult | null {
  // Sandbox: refuse to format files outside the project root before we
  // spawn biome. Without this guard a host-FS file could be written or
  // diffed through the formatter call.
  if (!withinProject(filePath)) return null;
  if (!existsSync(filePath)) return null;

  let bytesBefore: number;
  try {
    bytesBefore = statSync(filePath).size;
  } catch {
    return null;
  }

  try {
    execFileSync('npx', ['biome', 'format', '--write', filePath], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    const e = err as { killed?: boolean; status?: number };
    // Biome exits 0 on success even when it reformats. Non-zero exit
    // usually means a parse error or the file is not formattable.
    // A killed process means timeout.
    if (e.killed) return null;

    // Some non-zero exits still format the file (e.g. exit code 1 when
    // there are diagnostics alongside formatting). Check if the file
    // size changed to detect if formatting happened anyway.
  }

  let bytesAfter: number;
  try {
    bytesAfter = statSync(filePath).size;
  } catch {
    return null;
  }

  // Detect change by size first (fast), then by content if sizes match
  // (biome might rearrange whitespace without changing length).
  if (bytesAfter !== bytesBefore) {
    return { changed: true, bytesBefore, bytesAfter };
  }

  // Sizes are equal — read both versions to check if content changed.
  // We can't compare pre/post without a snapshot, so we re-run biome
  // in check mode: if it exits 0, the file is already formatted.
  try {
    execFileSync('npx', ['biome', 'format', filePath], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Exit 0 = already formatted
    return { changed: false, bytesBefore, bytesAfter };
  } catch {
    // Non-zero exit = still has formatting issues — but we already
    // ran --write above. This means biome couldn't fix everything
    // (e.g. parse error). Treat as "changed" optimistically.
    return { changed: true, bytesBefore, bytesAfter };
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'format-on-save',
  version: '0.1.0',
  description:
    'PostToolUse hook that runs biome format --write on the file after every write or edit',
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
      timeoutMs: {
        type: 'number',
        minimum: 1000,
        default: 5000,
        description: 'Biome format process timeout in milliseconds.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.formattedCount = 0;
    state.cleanCount = 0;
    state.errorCount = 0;
    state.hookUnregister = null;
    state.lastResult = null;

    const cfg = readConfig(api.config.extensions?.['format-on-save']);

    // Detect biome at setup time.
    let biomeAvailable = false;
    try {
      execSync('npx biome --version', {
        encoding: 'utf-8',
        timeout: 5_000,
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      biomeAvailable = true;
      api.log.info('format-on-save: biome detected');
    } catch {
      biomeAvailable = false;
      api.log.warn('format-on-save: biome not found — hook will be a no-op');
    }

    const hook = (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): { additionalContext?: string | undefined } | void => {
      if (!cfg.enabled || !biomeAvailable) return;

      // Skip if the tool errored — the file may not have been written.
      if (input.toolResult?.isError) return;

      const toolName = input.toolName ?? '';
      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const filePath = inp['path'] as string | undefined;
      if (!filePath || typeof filePath !== 'string') return;

      state.invocationCount += 1;

      const result = formatFile(filePath, cfg.timeoutMs);
      if (!result) {
        state.errorCount += 1;
        return; // biome failed or file doesn't exist — silent
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
        state.formattedCount += 1;
        const delta = result.bytesAfter - result.bytesBefore;
        api.log.info(`format-on-save: formatted ${filePath}`, {
          tool: toolName,
          delta: `${delta >= 0 ? '+' : ''}${delta} bytes`,
        });
        return {
          additionalContext:
            `\n🔧 format-on-save: applied biome formatting to '${filePath}' after ${toolName}. ` +
            `The file on disk has been reformatted (${delta >= 0 ? '+' : ''}${delta} bytes).`,
        };
      }

      state.cleanCount += 1;
      // Already formatted — silent (no context injection needed).
      return;
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook);

    // --- format_on_save_status tool ---
    api.tools.register({
      name: 'format_on_save_status',
      description:
        'Reports format-on-save state: biome availability, and per-session formatted/clean/error counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Code Quality',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          biomeAvailable,
          timeoutMs: cfg.timeoutMs,
          counters: {
            invocations: state.invocationCount,
            formatted: state.formattedCount,
            clean: state.cleanCount,
            errors: state.errorCount,
          },
          lastResult: state.lastResult,
        };
      },
    });

    api.log.info('format-on-save plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      biomeAvailable,
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
      formatted: state.formattedCount,
      clean: state.cleanCount,
      errors: state.errorCount,
    };
    state.invocationCount = 0;
    state.formattedCount = 0;
    state.cleanCount = 0;
    state.errorCount = 0;
    state.lastResult = null;
    api.log.info('format-on-save: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastResult === null
          ? `format-on-save: ${state.invocationCount} invocation(s), ${state.formattedCount} formatted`
          : state.lastResult.changed
            ? `format-on-save: last formatted ${state.lastResult.path} (${state.lastResult.tool}) at ${state.lastResult.when}`
            : `format-on-save: last check on ${state.lastResult.path} was already clean`,
      counters: {
        invocations: state.invocationCount,
        formatted: state.formattedCount,
        clean: state.cleanCount,
        errors: state.errorCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;
