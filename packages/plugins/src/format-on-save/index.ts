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

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import type { Plugin } from '@wrongstack/core/types';
import {
  BoundedMap,
  clearLocalBinCache,
  findOnPath,
  resolveExecInvocation,
  resolveFirstNodeBin,
  withinProject,
} from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Sandbox: reject file paths outside the project root, plus switch the
// `npx biome` shell form to execFileSync argv form. format-on-save runs
// after every write/edit; a prompt-injected write with an absolute host
// path would have `npx biome format --write "C:\Windows\evil.txt"`
// interpolated into a shell — quoting is brittle and Windows quotes can
// be escaped.
// ---------------------------------------------------------------------------
// withinProject() imported from ../runtime/index.js

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
  /** Times the format pass was skipped because import-organizer
   * had already covered the path within the TTL window. */
  coveredSkipCount: 0,
  /** Hook handle for teardown. */
  hookUnregister: null as null | (() => void),
  /** Cross-plugin event listener handle for teardown. */
  patternUnregister: null as null | (() => void),
  /** Last format result — surfaced by health() + status tool. */
  lastResult: null as null | {
    path: string;
    tool: string;
    changed: boolean;
    bytesBefore: number;
    bytesAfter: number;
    durationMs: number;
    when: string;
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface FormatOnSaveConfig {
  enabled: boolean;
  timeoutMs: number;
  /**
   * When the same path was just formatted by another plugin
   * (currently only `import-organizer`), skip the redundant
   * `biome format --write` pass. Defaults to ON. Set to `false`
   * to always run format-on-save regardless of who else touched
   * the file.
   *
   * Coordination is event-based: format-on-save subscribes to
   * `import-organizer:done` (custom event emitted after every
   * successful import-organizer linter run) and remembers the
   * path for `skipTtlMs` milliseconds. While the path is
   * remembered, format-on-save skips its own format invocation.
   */
  skipWhenCoveredBy: boolean;
  /**
   * How long (ms) to remember a "recently formatted by another
   * plugin" path. Default 30 000 (30 s). After this window the
   * path falls out of the cache and format-on-save runs normally
   * again.
   */
  skipTtlMs: number;
}

const DEFAULTS: FormatOnSaveConfig = {
  enabled: true,
  timeoutMs: 5_000,
  skipWhenCoveredBy: true,
  skipTtlMs: 30_000,
};

function readConfig(raw: unknown): FormatOnSaveConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawTimeout = r['timeoutMs'] ?? r['timeout_ms'] ?? r['timeout'];
  const rawCovered =
    r['skipWhenCoveredBy'] ?? r['skip_when_covered_by'] ?? r['skipCovered'] ?? r['skip_covered'];
  const rawTtl = r['skipTtlMs'] ?? r['skip_ttl_ms'] ?? r['ttlMs'] ?? r['ttl_ms'] ?? r['ttl'];
  return {
    enabled: r['enabled'] !== false,
    timeoutMs: typeof rawTimeout === 'number' && rawTimeout > 0 ? rawTimeout : DEFAULTS.timeoutMs,
    skipWhenCoveredBy: rawCovered !== false,
    skipTtlMs: typeof rawTtl === 'number' && rawTtl >= 0 ? rawTtl : DEFAULTS.skipTtlMs,
  };
}

/**
 * Paths that were just touched by another plugin (import-organizer),
 * with the timestamp at which the notice was received. Used by the
 * hook to skip a redundant `biome format --write` pass while the
 * path is still "recent" (TTL-controlled).
 */
const recentlyCovered = new BoundedMap<string, number>({ max: 256 });

function clearRegistrations(): void {
  if (state.hookUnregister) {
    try {
      state.hookUnregister();
    } catch {
      // best-effort
    }
    state.hookUnregister = null;
  }
  if (state.patternUnregister) {
    try {
      state.patternUnregister();
    } catch {
      // best-effort
    }
    state.patternUnregister = null;
  }
}

/** Evict entries older than `ttlMs` from the recentlyCovered map. */
function evictExpired(ttlMs: number): void {
  const cutoff = Date.now() - ttlMs;
  for (const [path, ts] of recentlyCovered) {
    if (ts < cutoff) recentlyCovered.delete(path);
  }
}

// ---------------------------------------------------------------------------
// Biome format helper
// ---------------------------------------------------------------------------

interface FormatResult {
  changed: boolean;
  bytesBefore: number;
  bytesAfter: number;
  durationMs: number;
}

/**
 * Run `biome format --write` on a file. Returns the byte sizes before
 * and after, and whether the file changed. Returns null if biome
 * failed or the file doesn't exist.
 *
 * Async: all fs/exec operations yield the event loop so the PostToolUse
 * hook returns immediately and the formatter runs without blocking other
 * tool results / messages from interleaving.
 */
/**
 * Formatters this plugin knows how to drive, in preference order. Each is
 * resolved as a project-local Node CLI (`node <bin-entry> …`) — never
 * through `npx`, which does not exist as a spawnable binary on Windows,
 * re-resolves the package on every invocation, and can reach the network
 * on a hook that fires after every single write.
 */
const FORMATTERS: readonly {
  packageName: string;
  binName: string;
  /** Args placed before the file path to format in place. */
  writeArgs: readonly string[];
  label: string;
}[] = [
  {
    packageName: '@biomejs/biome',
    binName: 'biome',
    writeArgs: ['format', '--write'],
    label: 'biome',
  },
  { packageName: 'prettier', binName: 'prettier', writeArgs: ['--write'], label: 'prettier' },
  { packageName: 'dprint', binName: 'dprint', writeArgs: ['fmt'], label: 'dprint' },
];

/**
 * Which formatter this project has, resolved once and reused. `undefined`
 * means "not yet probed"; `null` means "probed, none installed".
 */
let activeFormatter: { cmd: string; args: string[]; label: string } | null | undefined;

/** Reset the memoised formatter. Called from setup() and teardown(). */
function resetFormatter(): void {
  activeFormatter = undefined;
  clearLocalBinCache();
}

/**
 * Resolve the project's formatter to a directly-spawnable invocation.
 *
 * Falls back to a PATH lookup (platform-adjusted, so a Windows `.cmd`
 * shim still launches) when the tool is installed globally rather than as
 * a project dependency.
 */
function resolveFormatter(): { cmd: string; args: string[]; label: string } | null {
  if (activeFormatter !== undefined) return activeFormatter;
  const cwd = process.cwd();
  for (const f of FORMATTERS) {
    const local = resolveNodeBinFor(f, cwd);
    if (local) {
      activeFormatter = local;
      return local;
    }
  }
  // PATH fallback: when no formatter is installed as a project dependency,
  // try resolving from the system PATH (handles global npm/pnpm/yarn
  // installs). resolveExecInvocation uses resolveWin32Command internally,
  // which does a platform-adjusted PATH lookup (where.exe on Windows,
  // which on POSIX) and handles .cmd shims on Windows.
  for (const f of FORMATTERS) {
    // `findOnPath` — not `resolveExecInvocation` — because the latter hands
    // back its input unchanged when nothing matches. Accepting that
    // passthrough as a hit would make the FIRST candidate always "resolve":
    // the plugin would report biome as available on a machine with no
    // formatter at all, never fall through to prettier or dprint, and fail
    // every format silently while `formatterAvailable` stayed true.
    const onPath = findOnPath(f.binName);
    if (!onPath) continue;
    activeFormatter = { cmd: onPath, args: [...f.writeArgs], label: f.label };
    return activeFormatter;
  }
  activeFormatter = null;
  return null;
}

function resolveNodeBinFor(
  f: (typeof FORMATTERS)[number],
  cwd: string,
): { cmd: string; args: string[]; label: string } | null {
  const hit = resolveFirstNodeBin([{ packageName: f.packageName, binName: f.binName }], cwd);
  if (!hit) return null;
  return { cmd: hit.cmd, args: [...hit.args, ...f.writeArgs], label: f.label };
}

/** Which formatter is currently in use — surfaced by health()/status. */
export function activeFormatterLabel(): string | null {
  return activeFormatter?.label ?? null;
}

async function sha256File(filePath: string): Promise<string | null> {
  try {
    return createHash('sha256')
      .update(await readFile(filePath))
      .digest('hex');
  } catch {
    return null;
  }
}

async function formatFile(filePath: string, timeoutMs: number): Promise<FormatResult | null> {
  // Sandbox: refuse to format files outside the project root before we
  // spawn the formatter. Without this guard a host-FS file could be
  // written or diffed through the formatter call.
  if (!withinProject(filePath)) return null;
  try {
    await access(filePath);
  } catch {
    return null;
  }

  const formatter = resolveFormatter();
  if (!formatter) return null;

  const started = Date.now();
  let bytesBefore: number;
  try {
    bytesBefore = (await stat(filePath)).size;
  } catch {
    return null;
  }
  // Hash before formatting so a same-size reformat (whitespace shuffled,
  // quotes swapped) is still reported as a change. The previous code ran
  // the formatter a SECOND time in check mode to answer this question,
  // doubling the subprocess cost of every single write.
  const hashBefore = await sha256File(filePath);

  let invocation: { cmd: string; args: string[]; windowsVerbatimArguments: boolean };
  try {
    invocation = resolveExecInvocation(formatter.cmd, [...formatter.args, filePath]);
  } catch {
    // Windows shim path rejected an argument as unsafe — skip, never run.
    return null;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        invocation.cmd,
        invocation.args,
        {
          encoding: 'utf-8',
          timeout: timeoutMs,
          cwd: process.cwd(),
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
          ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        },
        (err) => {
          if (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean };
            // Formatters exit 0 on success even when they rewrite the file.
            // A killed process means timeout — that is a real failure.
            if (e.killed) return reject(err);
            // Some non-zero exits still format the file (e.g. exit 1 with
            // diagnostics alongside formatting). Fall through and let the
            // content hash decide whether formatting actually landed.
          }
          resolve();
        },
      );
    });
  } catch {
    return null;
  }

  let bytesAfter: number;
  try {
    bytesAfter = (await stat(filePath)).size;
  } catch {
    return null;
  }

  const durationMs = Date.now() - started;
  if (bytesAfter !== bytesBefore) {
    return { changed: true, bytesBefore, bytesAfter, durationMs };
  }

  // Same size — compare content hashes. One extra read beats one extra
  // process spawn, and it answers the question exactly rather than
  // inferring it from an exit code.
  const hashAfter = await sha256File(filePath);
  if (hashBefore === null || hashAfter === null) {
    return { changed: false, bytesBefore, bytesAfter, durationMs };
  }
  return { changed: hashBefore !== hashAfter, bytesBefore, bytesAfter, durationMs };
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
      skipWhenCoveredBy: {
        type: 'boolean',
        default: true,
        description:
          'Skip the format pass when another plugin (e.g. import-organizer) just touched the same path. Saves one biome invocation per write/edit when both plugins are enabled.',
      },
      skipTtlMs: {
        type: 'number',
        minimum: 0,
        default: 30000,
        description:
          'How long (ms) to remember a path covered by another plugin. 0 disables the memory.',
      },
    },
  },

  async setup(api) {
    // Idempotent re-init (H1 pattern). Unregister old hooks/listeners before
    // resetting counters so plugin reload cannot stack duplicate callbacks.
    clearRegistrations();
    state.invocationCount = 0;
    state.formattedCount = 0;
    state.cleanCount = 0;
    state.errorCount = 0;
    state.coveredSkipCount = 0;
    state.lastResult = null;
    recentlyCovered.clear();

    const cfg = readConfig(api.config.extensions?.['format-on-save']);

    // Detect the project's formatter at setup time. This is now a pure
    // module-resolution walk (no subprocess at all), so init cannot stall
    // on a slow PATH lookup or a Windows antivirus scan — the previous
    // `npx biome --version` probe cost up to 5s and, on Windows, always
    // failed ENOENT, permanently disabling the hook there.
    resetFormatter();
    const formatter = resolveFormatter();
    const formatterAvailable = formatter !== null;
    if (formatter) {
      api.log.info(`format-on-save: ${formatter.label} detected`);
    } else {
      api.log.warn(
        'format-on-save: no formatter found (biome, prettier, dprint) — hook will be a no-op',
      );
    }

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{ additionalContext?: string | undefined } | void> => {
      if (!cfg.enabled || !formatterAvailable) return;

      // Skip if the tool errored — the file may not have been written.
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
      const filePath = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : undefined;
      if (!filePath) return;

      // Cross-plugin coordination: skip if import-organizer already
      // touched this path within the TTL window. import-organizer's
      // `biome check --write --unsafe` runs the full formatter as a
      // side-effect, so re-running `biome format --write` here is
      // redundant. Eviction is lazy — happens once per invocation —
      // so the cache never grows unbounded.
      if (cfg.skipWhenCoveredBy && cfg.skipTtlMs > 0) {
        evictExpired(cfg.skipTtlMs);
        if (recentlyCovered.has(filePath)) {
          state.coveredSkipCount = (state.coveredSkipCount ?? 0) + 1;
          recentlyCovered.delete(filePath);
          api.log.info(
            `format-on-save: skipped ${filePath} — already formatted by import-organizer`,
            {
              tool: toolName,
            },
          );
          return;
        }
      }

      state.invocationCount += 1;

      const result = await formatFile(filePath, cfg.timeoutMs);
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
        durationMs: result.durationMs,
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

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, {
      background: true,
    });

    // Cross-plugin listener: import-organizer announces each
    // successful linter run via `import-organizer:done`. We cache the
    // path so a follow-up write/edit to the same file can skip its
    // own `biome format --write` (import-organizer's `biome check
    // --write --unsafe` already formatted the file). The listener is
    // tied to the hook lifetime — calling unregister on teardown is
    // best-effort.
    state.patternUnregister = api.onPattern(
      'import-organizer:done',
      (_eventName: string, payload: unknown) => {
        // Custom plugin events don't show up in the typed EventMap,
        // so we listen via onPattern (string-typed) instead of onEvent.
        const p = (payload ?? {}) as { path?: unknown };
        if (typeof p.path !== 'string' || p.path.length === 0) return;
        recentlyCovered.set(p.path, Date.now());
        api.metrics.counter('covered_notice');
      },
    );

    // --- format_on_save_status tool ---
    api.tools.register({
      name: 'format_on_save_status',
      description:
        'Reports format-on-save state: which formatter is active, and per-session formatted/clean/error/skipped counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Code Quality',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          formatterAvailable,
          formatter: activeFormatterLabel(),
          /**
           * Back-compat alias for the pre-multi-formatter status shape.
           * Now accurate rather than assumed: true only when the resolved
           * formatter really is biome.
           */
          biomeAvailable: activeFormatterLabel() === 'biome',
          timeoutMs: cfg.timeoutMs,
          skipWhenCoveredBy: cfg.skipWhenCoveredBy,
          skipTtlMs: cfg.skipTtlMs,
          counters: {
            invocations: state.invocationCount,
            formatted: state.formattedCount,
            clean: state.cleanCount,
            errors: state.errorCount,
            coveredSkips: state.coveredSkipCount,
            bytesBefore: state.lastResult?.bytesBefore ?? 0,
            bytesAfter: state.lastResult?.bytesAfter ?? 0,
            durationMs: state.lastResult?.durationMs ?? 0,
          },
          lastResult: state.lastResult,
        };
      },
    });

    api.log.info('format-on-save plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      formatterAvailable,
      formatter: activeFormatterLabel(),
    });
  },

  teardown(api) {
    clearRegistrations();
    // Drop the memoised formatter + local-bin cache so a plugin reload
    // re-probes instead of reusing a possibly-uninstalled binary.
    resetFormatter();
    const final = {
      invocations: state.invocationCount,
      formatted: state.formattedCount,
      clean: state.cleanCount,
      errors: state.errorCount,
      coveredSkips: state.coveredSkipCount,
    };
    state.invocationCount = 0;
    state.formattedCount = 0;
    state.cleanCount = 0;
    state.errorCount = 0;
    state.coveredSkipCount = 0;
    state.lastResult = null;
    recentlyCovered.clear();
    api.log.info('format-on-save: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastResult === null
          ? `format-on-save: ${state.invocationCount} invocation(s), ${state.formattedCount} formatted, ${state.coveredSkipCount} covered-skipped`
          : state.lastResult.changed
            ? `format-on-save: last formatted ${state.lastResult.path} (${state.lastResult.tool}) at ${state.lastResult.when}`
            : `format-on-save: last check on ${state.lastResult.path} was already clean`,
      counters: {
        invocations: state.invocationCount,
        formatted: state.formattedCount,
        clean: state.cleanCount,
        errors: state.errorCount,
        coveredSkips: state.coveredSkipCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;
