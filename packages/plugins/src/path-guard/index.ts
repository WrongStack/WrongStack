/**
 * path-guard plugin — blocks (or warns about) writes, edits, and
 * destructive shell commands that touch protected paths.
 *
 * @public
 */
import type { Plugin, PluginAPI } from '@wrongstack/core/types';
import {
  compilePathGlob,
  effectiveToolCwd,
  hasConfiguredProtectedDescendant,
  isDirectoryAmbiguousPath,
  isRootPathScope,
  isUnresolvedPathScope,
  matchesAnyGuarded,
  relativeToInvocationCwd,
  resolveTargetPath,
  targetFullyAllowed,
  targetIntersectsPatterns,
  targetIntersectsPatternsGuarded,
  type WriteTarget,
} from './glob.js';
import {
  commandDeletesImplicitScope,
  commandRecursivelyDeletes,
  destructiveTargets,
} from './shell-targets.js';
import {
  DISK_MUTATING_CAPABILITIES,
  executesShell,
  isReadOnlyInvocation,
  LEGACY_WRITE_TOOLS,
  operationLabel,
  PATH_FIELDS,
  PATH_LIST_FIELDS,
  pathsFromToolInput,
  writesToDisk,
} from './tool-targets.js';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { withinProject } from '../runtime/index.js';

export { compilePathGlob } from './glob.js';
export { destructiveTargets } from './shell-targets.js';

/** True when `path` is a project-local symlink whose real target escaped. */
export function isSymlinkEscape(path: string, cwd?: string): boolean {
  if (!withinProject(path)) return false;
  try {
    const abs = resolve(cwd ?? process.cwd(), path);
    const real = realpathSync(abs);
    return !withinProject(real);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-host state
// ---------------------------------------------------------------------------

interface PathGuardState {
  invocations: number;
  blocks: number;
  warns: number;
  redosTimeouts: number;
  lastBlock: { path: string; tool: string; when: string } | null;
  hookUnregister: (() => void) | null;
}

function createState(): PathGuardState {
  return {
    invocations: 0,
    blocks: 0,
    warns: 0,
    redosTimeouts: 0,
    lastBlock: null,
    hookUnregister: null,
  };
}

const states = new WeakMap<PluginAPI, PathGuardState>();
let latestState = createState();

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
  const rawMode = typeof (r['mode'] ?? r['action'] ?? r['behavior']) === 'string'
    ? String(r['mode'] ?? r['action'] ?? r['behavior']).trim().toLowerCase()
    : undefined;
  const mode = rawMode === 'warn' ? 'warn' : 'block';
  const rawProtect = r['protect'] ?? r['protectedPaths'] ?? r['protected_paths'] ?? r['protected'];
  const rawAllow = r['allow'] ?? r['allowedPaths'] ?? r['allowed_paths'] ?? r['allowed'];
  return {
    enabled: r['enabled'] !== false,
    mode,
    protect: Array.isArray(rawProtect)
      ? (rawProtect as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [...DEFAULT_PROTECT],
    allow: Array.isArray(rawAllow)
      ? (rawAllow as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [],
  };
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
        description:
          'Glob patterns for protected paths. Replaces the default set when present. Writer globs whose unresolved scope overlaps protection are blocked; narrow the target or add an `allow` glob.',
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
    const previous = states.get(api);
    if (previous?.hookUnregister) {
      try {
        previous.hookUnregister();
      } catch {
        // best-effort
      }
    }
    const state = createState();
    states.set(api, state);
    latestState = state;

    const cfg = readConfig(api.config.extensions?.['path-guard']);
    const protectRes = cfg.protect.map(compilePathGlob);
    const allowRes = cfg.allow.map(compilePathGlob);

    const verdict = (path: string, tool: string, operation: string, isScope = false) => {
      const subject = isScope
        ? `write scope "${path}" may include a protected path — narrow it or add an \`allow\` glob`
        : `"${path}" is a protected path`;
      const matchContext = isScope
        ? 'its unresolved scope overlaps config.extensions["path-guard"].protect'
        : 'matched by config.extensions["path-guard"].protect';
      if (cfg.mode === 'block') {
        state.blocks += 1;
        state.lastBlock = { path, tool, when: new Date().toISOString() };
        api.metrics.counter('blocks');
        return {
          decision: 'block' as const,
          reason:
            `path-guard: ${subject} (${matchContext}) — ${operation} refused. ` +
            'If this change is intentional, ask the user to do it, add an `allow` glob, or set mode: "warn".',
        };
      }
      state.warns += 1;
      api.metrics.counter('warns');
      return {
        decision: 'allow' as const,
        additionalContext:
          `path-guard (warn mode): ${subject} and this ${operation} would modify it. ` +
          'Double-check this is intentional.',
      };
    };

    const bumpRedos = () => {
      state.redosTimeouts += 1;
      api.metrics.counter('redos_timeouts');
    };

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolCapabilities?: readonly string[] | undefined;
      toolMutating?: boolean | undefined;
      cwd?: string | undefined;
    }) => {
      if (!cfg.enabled) return;
      state.invocations += 1;
      const toolName = input.toolName ?? '';
      const ti = (input.toolInput ?? {}) as Record<string, unknown>;

      const command = typeof ti['command'] === 'string' ? ti['command'] : '';
      const commandArgs = Array.isArray(ti['args'])
        ? ti['args'].filter((arg): arg is string => typeof arg === 'string')
        : [];
      // Serialize argv tokens for shell-rule inspection. Charset-safe tokens
      // pass through verbatim and everything else is quoted — except
      // assignment args (`KEY=value`), whose `KEY=` prefix must stay OUTSIDE
      // the quotes: a fully-quoted token (`dd "of=$HOME/.env"`) hides the
      // assignment from the `of=`-style matchers in destructiveTargets,
      // which only recognize assignments at a token boundary. That was an
      // argv-form write bypass (probe-verified 2026-08-17).
      const serializeArgForInspection = (arg: string): string => {
        if (/^[\w./:@%+=,-]+$/.test(arg)) return arg;
        const assignment = /^([A-Za-z_]\w*)=(.+)$/.exec(arg);
        const key = assignment?.[1];
        const value = assignment?.[2];
        if (key !== undefined && value !== undefined) {
          return `${key}="${value.replaceAll('"', '')}"`;
        }
        return JSON.stringify(arg);
      };
      const commandForInspection = [command, ...commandArgs.map(serializeArgForInspection)].join(
        ' ',
      );
      if (
        command &&
        executesShell({
          toolName: input.toolName,
          toolInput: ti,
          toolCapabilities: input.toolCapabilities,
          toolMutating: input.toolMutating,
        })
      ) {
        const shellTargets = destructiveTargets(commandForInspection);
        const effectiveCwd = effectiveToolCwd(ti['cwd'], input.cwd);
        const recursivelyDeletes = commandRecursivelyDeletes(commandForInspection);
        const deletesImplicitScope = commandDeletesImplicitScope(commandForInspection);
        // Parallel guarded checks: sequential `await` per shell target would
        // stack worker spin-up and blow the 5-second PreToolUse deadline on
        // bulk commands (chimera, index.ts:280). Promise.all keeps wall-clock
        // at O(1 worker) for benign commands; attacker timeouts still fail
        // closed per target.
        const shellHits = await Promise.all(
          shellTargets.map(async (path) => {
            const target: WriteTarget = {
              path: relativeToInvocationCwd(resolveTargetPath(path, effectiveCwd), input.cwd),
              kind:
                (isRootPathScope(path) && deletesImplicitScope) ||
                isUnresolvedPathScope(path) ||
                (recursivelyDeletes &&
                  (isDirectoryAmbiguousPath(path) ||
                    hasConfiguredProtectedDescendant(path, cfg.protect)))
                  ? 'deletion-scope'
                  : 'file',
            };
            if (targetFullyAllowed(target, cfg.allow, allowRes)) return null;
            const protectedShellTarget =
              (await targetIntersectsPatternsGuarded(target, cfg.protect, protectRes, { onTimeout: bumpRedos })) ||
              (await matchesAnyGuarded(`${target.path.replace(/\/$/, '')}/.path-guard-probe`, protectRes, {
                onTimeout: bumpRedos,
              }));
            return protectedShellTarget ? target : null;
          }),
        );
        const firstProtected = shellHits.find((t): t is WriteTarget => t !== null);
        if (firstProtected) {
          return verdict(
            firstProtected.path,
            toolName,
            'destructive shell command',
            firstProtected.kind !== 'file',
          );
        }

        const writes = writesToDisk({ ...input, toolInput: ti });
        const hasStructuredTarget =
          [...PATH_FIELDS, ...PATH_LIST_FIELDS].some((field) => ti[field] !== undefined) ||
          typeof ti['patch'] === 'string';
        const needsImplicitWriteScope =
          writes &&
          ((input.toolCapabilities?.some((capability) =>
            DISK_MUTATING_CAPABILITIES.has(capability),
          ) ??
            false) ||
            ((!input.toolCapabilities || input.toolCapabilities.length === 0) &&
              LEGACY_WRITE_TOOLS.has(toolName)));
        if (!writes || (!hasStructuredTarget && !needsImplicitWriteScope)) return;
      }

      if (!writesToDisk({ ...input, toolInput: ti }) || isReadOnlyInvocation(toolName, ti)) return;
      const targets = pathsFromToolInput(ti, toolName, input.cwd);
      // Parallel guarded checks (same rationale as the shell branch above):
      // sequential awaits would stack worker spin-up on bulk writes and blow
      // the PreToolUse deadline. First-hit-in-original-order is preserved.
      const writeHits = await Promise.all(
        targets.map(async (target) => {
          if (target.kind === 'file' && isSymlinkEscape(target.path, input.cwd)) return target;
          if (targetFullyAllowed(target, cfg.allow, allowRes)) return null;
          // Concrete write targets use the sync matcher. The worker-thread
          // guard is for hostile path *inputs* against user globs (shell
          // branch above). Sync matching keeps patch/write basenames like
          // `.env` deterministic (issue #365).
          return targetIntersectsPatterns(target, cfg.protect, protectRes) ? target : null;
        }),
      );
      const firstProtectedWrite = writeHits.find((t): t is WriteTarget => t !== null);
      if (firstProtectedWrite) {
        return verdict(
          firstProtectedWrite.path,
          toolName,
          operationLabel(toolName),
          firstProtectedWrite.kind !== 'file',
        );
      }
      return;
    };

    state.hookUnregister = api.registerHook('PreToolUse', '*', hook as never, {
      name: 'path-guard',
      stage: 'validate',
      failurePolicy: 'closed',
      policy: true,
    });

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
            redosTimeouts: state.redosTimeouts,
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
    const state = states.get(api);
    if (!state) return;
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
      blocks: state.blocks,
      warns: state.warns,
      redosTimeouts: state.redosTimeouts,
    };
    state.invocations = 0;
    state.blocks = 0;
    state.warns = 0;
    state.redosTimeouts = 0;
    state.lastBlock = null;
    states.delete(api);
    api.log.info('path-guard: teardown complete', { final });
  },

  async health() {
    const state = latestState;
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
        redosTimeouts: state.redosTimeouts,
      },
    };
  },
};

export default plugin;
