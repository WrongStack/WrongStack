/**
 * type-gate plugin — PostToolUse hook that runs TypeScript type-checking
 * after every `write` or `edit` to a source file.
 *
 * `lint-gate` validates style; this plugin validates types. It runs
 * `tsc --noEmit` (or a user-supplied command) and injects the first few
 * errors as `additionalContext` so the model can fix type regressions in
 * the same turn.
 *
 * Tools registered:
 * - type_gate_status : Show config + per-session counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit`.
 *
 * Config (`config.extensions['type-gate']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "command": "npx tsc --noEmit",  // base type-check command
 *   "tsConfigPath": "tsconfig.json",
 *   "timeoutMs": 60000,
 *   "failSeverity": "warn",         // "warn" | "block"
 *   "maxErrors": 5,                 // errors shown in context
 *   "runOnChange": [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]
 * }
 * ```
 *
 * @public
 */

import { existsSync } from 'node:fs';
import type { Plugin } from '@wrongstack/core/types';
import {
  releaseHandle,
  type LanguageRuntime,
  resolveNodeBin,
  resolveRunnerCommand,
  runRunnerCommand,
  sanitizeRunnerPath,
  withinProject,
} from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface TypeGateState {
  invocationCount: number;
  runCount: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  skippedCount: number;
  lastResult: {
    passed: boolean;
    errorCount: number;
    durationMs: number;
    when: string;
  } | null;
  hookUnregister: null | (() => void);
}

const state: TypeGateState = {
  invocationCount: 0,
  runCount: 0,
  passCount: 0,
  failCount: 0,
  errorCount: 0,
  skippedCount: 0,
  lastResult: null,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface TypeGateConfig {
  enabled: boolean;
  command: string;
  tsConfigPath: string;
  timeoutMs: number;
  failSeverity: 'warn' | 'block';
  maxErrors: number;
  runOnChange: string[];
}

const DEFAULTS: TypeGateConfig = {
  enabled: false,
  command: '',
  tsConfigPath: 'tsconfig.json',
  timeoutMs: 60_000,
  failSeverity: 'warn',
  maxErrors: 5,
  runOnChange: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'],
};

/**
 * Extension set for O(1) lookup instead of Array.includes() O(n).
 *
 * Performance: converts the runOnChange array to a Set at config read time
 * so the hook's per-file extension check is O(1) instead of O(n).
 */
let runOnChangeSet = new Set(DEFAULTS.runOnChange);

function readConfig(raw: unknown): TypeGateConfig {
  if (!raw || typeof raw !== 'object') {
    runOnChangeSet = new Set(DEFAULTS.runOnChange);
    return { ...DEFAULTS };
  }
  const r = raw as Record<string, unknown>;
  const runOnChange = Array.isArray(r['runOnChange'])
    ? (r['runOnChange'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : DEFAULTS.runOnChange;

  // Update the module-scope Set for O(1) lookup in the hook.
  runOnChangeSet = new Set(runOnChange);

  const rawPath = r['tsConfigPath'] ?? r['tsconfig_path'] ?? r['tsconfigPath'] ?? r['tsconfig'];
  const rawSeverity =
    typeof (r['failSeverity'] ?? r['fail_severity'] ?? r['severity'] ?? r['mode']) === 'string'
      ? String(r['failSeverity'] ?? r['fail_severity'] ?? r['severity'] ?? r['mode'])
          .trim()
          .toLowerCase()
      : undefined;
  const failSeverity = rawSeverity === 'block' ? 'block' : DEFAULTS.failSeverity;

  return {
    enabled: r['enabled'] === true,
    command: typeof r['command'] === 'string' ? r['command'] : DEFAULTS.command,
    tsConfigPath: typeof rawPath === 'string' ? rawPath : DEFAULTS.tsConfigPath,
    timeoutMs:
      typeof r['timeoutMs'] === 'number' && r['timeoutMs'] > 0
        ? r['timeoutMs']
        : DEFAULTS.timeoutMs,
    failSeverity,
    maxErrors:
      typeof r['maxErrors'] === 'number' && r['maxErrors'] >= 1 && r['maxErrors'] <= 50
        ? r['maxErrors']
        : DEFAULTS.maxErrors,
    runOnChange,
  };
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

// withinProject() imported from ../runtime/index.js

const TSC_RUNTIME: LanguageRuntime = {
  id: 'typescript',
  packageManager: 'pnpm',
  executable: 'tsc',
  allowedFlags: new Set([
    '--noEmit',
    '--pretty',
    '--pretty=false',
    '--incremental',
    '--watch',
    '--build',
    '--filter',
  ]),
  subcommands: ['exec'],
  defaultCommand: 'pnpm exec tsc --noEmit',
};

function validateTsConfigPath(p: string): string | null {
  const sanitized = sanitizeRunnerPath(p);
  return sanitized;
}

// ---------------------------------------------------------------------------
// Type-check runner
// ---------------------------------------------------------------------------

interface TypeCheckResult {
  passed: boolean;
  errorCount: number;
  errors: string[];
  durationMs: number;
}

async function runTypeCheck(cfg: TypeGateConfig): Promise<TypeCheckResult | null> {
  const start = Date.now();
  const rawTsConfig = cfg.tsConfigPath;
  const validTsConfig =
    rawTsConfig && rawTsConfig !== 'tsconfig.json' ? validateTsConfigPath(rawTsConfig) : null;
  if (rawTsConfig && rawTsConfig !== 'tsconfig.json' && !validTsConfig) {
    return null;
  }
  const tsConfig = validTsConfig ?? (rawTsConfig || 'tsconfig.json');

  let argv: readonly string[];
  if (cfg.command) {
    const resolved = resolveRunnerCommand(TSC_RUNTIME, cfg.command);
    if (!resolved) return null;
    argv = [resolved.cmd, ...resolved.args];
  } else {
    // Default argv: enable `--incremental` so tsc reuses the project's
    // `.tsbuildinfo` cache. On a no-op edit (the common case under
    // PostToolUse fire-on-every-edit) tsc returns in tens of milliseconds
    // instead of re-typechecking every file. tsbuildinfo is written next
    // to tsconfig.json or in the path pointed at by `--tsBuildInfoFile`.
    //
    // Prefer the project's own `typescript` over `npx tsc`: `npx` re-resolves
    // (and can download) the package on every gate run, and on Windows it is
    // a `.cmd` shim that a shell-less spawn cannot launch at all — which made
    // this gate a permanent silent no-op on every Windows machine.
    const tscFlags = ['--noEmit', '--incremental'];
    const localTsc = resolveNodeBin('typescript', 'tsc', process.cwd(), tscFlags);
    argv = localTsc ? [localTsc.cmd, ...localTsc.args] : ['npx', 'tsc', ...tscFlags];
    if (tsConfig && tsConfig !== 'tsconfig.json') {
      argv = [...argv, '-p', tsConfig];
    }
  }

  // Verify the tsconfig exists unless the custom command is fully explicit.
  if (!cfg.command && tsConfig && !existsSync(tsConfig)) {
    return null;
  }

  // Async runner: yields the event loop so other hooks / messages / tool
  // results can interleave while tsc runs. The runtime helper handles
  // timeout / signal / maxBuffer uniformly for all subprocess-spawning
  // plugins (was the source of the sync-blocking PostToolUse lag).
  const result = await runRunnerCommand([argv[0]!, ...argv.slice(1)] as string[], {
    cwd: process.cwd(),
    timeoutMs: cfg.timeoutMs,
  });
  if (result.timedOut) return null;
  // spawnError == true means the runtime helper itself failed to start the
  // binary (ENOENT, EPERM, EACCES, cwd-rejected). The helper's diagnostic
  // stderr is "runtime helper: …" prose that does not match the tsc error
  // pattern; without this short-circuit we'd silently report `passed: true`
  // and never re-attempt when the user installs tsc.
  if (result.spawnError) return null;

  const stdout = result.stdout;
  const stderr = result.stderr;
  const combined = `${stdout}\n${stderr}`.trim();
  const durationMs = Date.now() - start;

  // tsc produces "file.ts(line,col): error TS1234: message" or "file.ts:line:col - error TS1234: message"
  const errors: string[] = [];
  const lines = combined.split(/\r?\n/);
  for (const line of lines) {
    if (/\berror\b/i.test(line) && /(?::\s*|\s+-\s+)error\s+TS\d+:/i.test(line)) {
      errors.push(line.trim());
      if (errors.length >= cfg.maxErrors) break;
    }
  }

  const passed = errors.length === 0 && !/\bfound\b.*\berrors?\b/i.test(combined);
  return { passed, errorCount: errors.length, errors, durationMs };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'type-gate',
  version: '0.1.0',
  runtime: {
    language: 'typescript',
    packageManager: 'pnpm',
    executable: 'tsc',
    defaultCommand: 'pnpm exec tsc --noEmit',
  },
  description:
    'PostToolUse hook that runs TypeScript type-checking after every write or edit to a source file',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: false,
        description: 'Master switch.',
      },
      command: {
        type: 'string',
        default: '',
        description:
          'Custom type-check command (overrides tsc default). Empty = "npx tsc --noEmit -p tsConfigPath".',
      },
      tsConfigPath: {
        type: 'string',
        default: 'tsconfig.json',
        description: 'Path to the tsconfig used when command is empty.',
      },
      timeoutMs: {
        type: 'number',
        minimum: 5000,
        default: 60_000,
        description: 'Type-check process timeout in milliseconds.',
      },
      failSeverity: {
        type: 'string',
        enum: ['warn', 'block'],
        default: 'warn',
        description:
          'warn = inject errors as additionalContext; block = refuse the mutating tool when type errors appear.',
      },
      maxErrors: {
        type: 'number',
        minimum: 1,
        maximum: 50,
        default: 5,
        description: 'Maximum number of type errors shown in context.',
      },
      runOnChange: {
        type: 'array',
        items: { type: 'string' },
        default: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'],
        description: 'Only run type-check when the edited file has one of these extensions.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.runCount = 0;
    state.passCount = 0;
    state.failCount = 0;
    state.errorCount = 0;
    state.skippedCount = 0;
    state.lastResult = null;
    state.hookUnregister = releaseHandle(state.hookUnregister);

    const cfg = readConfig(api.config.extensions?.['type-gate']);

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{ decision?: 'block'; reason?: string; additionalContext?: string } | void> => {
      if (!cfg.enabled) return;

      // Skip if the write/edit itself errored.
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

      const ext = sourcePath.includes('.')
        ? sourcePath.slice(sourcePath.lastIndexOf('.')).toLowerCase()
        : '';
      // Performance: uses Set.has() for O(1) lookup instead of Array.includes() O(n).
      if (!runOnChangeSet.has(ext)) {
        state.skippedCount += 1;
        return;
      }

      state.invocationCount += 1;
      const result = await runTypeCheck(cfg);
      if (!result) {
        state.errorCount += 1;
        return;
      }

      state.runCount += 1;
      state.lastResult = {
        passed: result.passed,
        errorCount: result.errorCount,
        durationMs: result.durationMs,
        when: new Date().toISOString(),
      };

      if (result.passed) {
        state.passCount += 1;
        return;
      }

      state.failCount += 1;
      const errorList = result.errors.map((e) => `  ❌ ${e}`).join('\n');
      const message =
        `\n❌ type-gate: Type check failed after editing ${sourcePath} (${result.durationMs}ms).` +
        `\n${errorList}` +
        (result.errorCount >= cfg.maxErrors
          ? `\n  … and possibly more errors (showing first ${cfg.maxErrors})`
          : '') +
        `\nFix the type error(s) or adjust the change.`;

      if (cfg.failSeverity === 'block') {
        return {
          decision: 'block' as const,
          reason: message,
        };
      }

      return { additionalContext: message };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, {
      background: true,
    });

    // --- type_gate_status tool ---
    api.tools.register({
      name: 'type_gate_status',
      description:
        'Reports type-gate state: command, tsconfig, severity, and per-session pass/fail/error counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          command: cfg.command || `npx tsc --noEmit -p ${cfg.tsConfigPath}`,
          tsConfigPath: cfg.tsConfigPath,
          failSeverity: cfg.failSeverity,
          maxErrors: cfg.maxErrors,
          runOnChange: cfg.runOnChange,
          counters: {
            invocations: state.invocationCount,
            runs: state.runCount,
            passed: state.passCount,
            failed: state.failCount,
            errors: state.errorCount,
            skipped: state.skippedCount,
          },
          lastResult: state.lastResult,
        };
      },
    });

    api.log.info('type-gate plugin loaded', {
      version: '0.1.0',
      command: cfg.command,
      tsConfigPath: cfg.tsConfigPath,
      failSeverity: cfg.failSeverity,
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
      runs: state.runCount,
      passed: state.passCount,
      failed: state.failCount,
      errors: state.errorCount,
      skipped: state.skippedCount,
    };
    state.invocationCount = 0;
    state.runCount = 0;
    state.passCount = 0;
    state.failCount = 0;
    state.errorCount = 0;
    state.skippedCount = 0;
    state.lastResult = null;
    api.log.info('type-gate: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: state.lastResult
        ? `type-gate: ${state.runCount} run(s), last ${state.lastResult.passed ? 'PASSED' : 'FAILED'} (${state.lastResult.errorCount} errors)`
        : `type-gate: ${state.invocationCount} invocation(s), ${state.runCount} run(s)`,
      counters: {
        invocations: state.invocationCount,
        runs: state.runCount,
        passed: state.passCount,
        failed: state.failCount,
        errors: state.errorCount,
        skipped: state.skippedCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;
