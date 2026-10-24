/**
 * process-guard plugin — prevents the LLM/coding agent from killing active
 * WrongStack processes or their host terminals.
 *
 * Two-layer defense:
 *  1. **Tool-level guards** (primary): `bash-kill-guard.ts` in the bash tool
 *     and `exec-kill-guard.ts` in the exec tool intercept kill commands at
 *     the tool-execution level, consulting the cross-instance persistent
 *     process registry (`~/.wrongstack/process-registry.json`).
 *  2. **This plugin** (observability + configuration layer): provides the
 *     `process_guard_status` diagnostic tool, logs all blocked kill attempts,
 *     and surfaces protection state to the user via `/process-guard status`.
 *
 * The tool-level guards handle:
 *   - taskkill /F /IM node.exe, taskkill /PID X
 *   - PowerShell Stop-Process / kill alias
 *   - WMIC process ... delete
 *   - Script-based kills (kill*.ps1, kill*.sh, etc.)
 *   - POSIX kill, pkill, killall
 *   - node -e "process.kill(...)" (via exec-kill-guard.ts)
 *
 * Cross-instance protection: the persistent process registry at
 * `~/.wrongstack/process-registry.json` tracks every WrongStack instance's
 * PID, and the tool-level guards read it to determine which PIDs/names are
 * protected. This plugin registers the current process + parent terminal at
 * setup.
 *
 * Config (`config.extensions['process-guard']`):
 * ```jsonc
 * {
 *   "enabled": true,
 *   "mode": "block"    // "block" | "warn" | "off"
 * }
 * ```
 *
 * @public
 */

import * as os from 'node:os';
import type { Plugin } from '@wrongstack/contracts/types';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface ProcessGuardState {
  invocations: number;
  detections: number;
  warns: number;
  lastDetection: { target: string; tool: string; when: string } | null;
  hookUnregister: null | (() => void);
}

const state: ProcessGuardState = {
  invocations: 0,
  detections: 0,
  warns: 0,
  lastDetection: null,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * What this plugin does when it spots a kill-related command.
 *
 * There is deliberately no `block` here: this plugin CANNOT refuse a tool
 * call. Its PreToolUse hook returns no decision — the refusal is performed
 * downstream by `tools/src/bash-kill-guard.ts` and `exec-kill-guard.ts`,
 * which run whether or not this plugin is loaded and which can see the
 * resolved target PID. `block` is still accepted, as the historical spelling
 * of the default, and means `observe`.
 */
type ProcessGuardMode = 'observe' | 'warn' | 'off';

interface ProcessGuardConfig {
  enabled: boolean;
  mode: ProcessGuardMode;
}

const DEFAULTS: ProcessGuardConfig = {
  enabled: true,
  mode: 'observe',
};

function readConfig(raw: unknown): ProcessGuardConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const mode = r['mode'];
  return {
    enabled: r['enabled'] !== false,
    mode: mode === 'warn' ? 'warn' : mode === 'off' ? 'off' : DEFAULTS.mode,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'process-guard',
  version: '0.1.0',
  description:
    'Reports kill commands (taskkill, Stop-Process, kill, pkill, wmic) seen by bash/exec; the refusal itself is enforced by the built-in bash/exec kill guards.',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      mode: {
        type: 'string',
        // `block` is accepted as the historical spelling of the default and
        // behaves as `observe`; removing it from the enum would fail config
        // validation at load for anyone who had written it.
        enum: ['observe', 'warn', 'off', 'block'],
        default: 'observe',
        description:
          'observe = count and log only (default); warn = also tell the model a kill-related command was seen; off = disable. This plugin never refuses a call — the bash/exec kill guards do that. "block" is a deprecated alias for "observe".',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocations = 0;
    state.detections = 0;
    state.warns = 0;
    state.lastDetection = null;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['process-guard']);

    if (cfg.mode === 'off') {
      api.log.info('[process-guard] loaded but mode=off — protection disabled');
      return;
    }

    // Register the PreToolUse hook on bash|exec
    // This hook detects kill commands via fast string matching. The actual
    // blocking is performed by the tool-level guards (bash-kill-guard.ts in
    // bash.ts and exec-kill-guard.ts in exec.ts). This plugin provides
    // observability — logging, counters, and the process_guard_status tool.
    const hook = (input: { toolName?: string; toolInput?: unknown }) => {
      if (!cfg.enabled || cfg.mode === 'off') return;
      state.invocations += 1;
      const toolName = input.toolName ?? '';

      // Only handle bash and exec
      if (toolName !== 'bash' && toolName !== 'exec') return;

      const ti = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawCmd = ti['command'] ?? ti['CommandLine'] ?? ti['cmd'] ?? ti['script'] ?? ti['input'];
      const command = typeof rawCmd === 'string' ? rawCmd : '';

      if (!command) return;

      // Fast sync check: commands containing known kill patterns
      const isKillRelated = /\b(?:kill|taskkill|stop-process|tskill|pkill|killall|wmic)\b/i.test(
        command,
      );

      if (!isKillRelated) return;

      // Record detection only. This PreToolUse hook cannot observe the later
      // tool-level verdict, so counting every match as a block over-reports.
      state.detections += 1;
      state.lastDetection = {
        target: command.slice(0, 100),
        tool: toolName,
        when: new Date().toISOString(),
      };
      api.metrics.counter('detections');
      api.log.warn?.(
        '[process-guard] kill-related command detected; tool-level guard will evaluate it',
        {
          tool: toolName,
          command: command.slice(0, 200),
        },
      );

      // `warn` is the only mode with an effect the operator can see from the
      // model's side. It used to be indistinguishable from the default: both
      // counted and logged, and neither reached the conversation, so the
      // setting read as a policy choice while changing nothing.
      if (cfg.mode === 'warn') {
        state.warns += 1;
        api.metrics.counter('warns');
        return {
          decision: 'allow' as const,
          additionalContext:
            `process-guard: "${toolName}" is about to run a kill-related command. ` +
            'If it targets a WrongStack process or its host terminal the built-in kill guard will refuse it. ' +
            'Confirm you are killing the process you actually mean to kill.',
        };
      }
      return;
    };

    state.hookUnregister = api.registerHook('PreToolUse', 'bash|exec', hook as never, {
      name: 'process-guard',
      stage: 'validate',
      failurePolicy: 'closed',
      policy: true,
    });

    // ── process_guard_status tool ─────────────────────────────────────
    api.tools.register({
      name: 'process_guard_status',
      description:
        'Reports process-guard state: mode, counters, and last detected kill-related command.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          mode: cfg.mode,
          platform: os.platform(),
          selfPid: process.pid,
          parentPid: process.ppid,
          counters: {
            invocations: state.invocations,
            detections: state.detections,
            warns: state.warns,
          },
          lastDetection: state.lastDetection,
        };
      },
    });

    api.log.info('[process-guard] loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      mode: cfg.mode,
      selfPid: process.pid,
      parentPid: process.ppid,
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
      invocations: state.invocations,
      detections: state.detections,
      warns: state.warns,
    };
    state.invocations = 0;
    state.detections = 0;
    state.warns = 0;
    state.lastDetection = null;
    api.log.info('[process-guard] teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastDetection === null
          ? `process-guard: ${state.invocations} invocation(s), ${state.detections} detection(s), ${state.warns} warn(s)`
          : `process-guard: last detection on "${state.lastDetection.tool}" at ${state.lastDetection.when}`,
    };
  },
};

export default plugin;
