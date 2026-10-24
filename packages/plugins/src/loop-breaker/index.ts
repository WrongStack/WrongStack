import type { Plugin } from '@wrongstack/contracts/types';
import {
  fingerprint,
  gitDiffFingerprint,
  isOscillating,
  normalizeError,
} from './loop-breaker-fingerprint.js';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface LoopBreakerRunState {
  /** Fingerprint of the last observed tool call. */
  lastFingerprint: string | null;
  /** How many times `lastFingerprint` has been seen consecutively. */
  streak: number;
  /** Ring of recent fingerprints for oscillation detection. */
  recent: string[];
  /** Deferred block raised by a PostToolUse no-progress detector. */
  pendingBlockReason: string | null;
  /** Last observed git diff fingerprint after a mutating tool. */
  lastDiffFingerprint: string | null;
  /** Consecutive successful mutating tools that did not change the diff. */
  noDiffStreak: number;
  /** Last normalized error fingerprint. */
  lastErrorFingerprint: string | null;
  /** Consecutive tool errors with the same normalized fingerprint. */
  repeatedErrorStreak: number;
  /** Counters. */
  invocations: number;
  postInvocations: number;
  warnings: number;
  blocks: number;
  oscillationsDetected: number;
  stepBudgetBlocks: number;
  noDiffWarnings: number;
  noDiffBlocks: number;
  repeatedErrorWarnings: number;
  repeatedErrorBlocks: number;
}

interface LoopBreakerState {
  runs: Map<string, LoopBreakerRunState>;
  /** Hook handle for teardown. */
  hookUnregister: null | (() => void);
}

const FALLBACK_SESSION = '__default__';
const MAX_TRACKED_RUNS = 32;

function createRunState(): LoopBreakerRunState {
  return {
    lastFingerprint: null,
    streak: 0,
    recent: [],
    pendingBlockReason: null,
    lastDiffFingerprint: null,
    noDiffStreak: 0,
    lastErrorFingerprint: null,
    repeatedErrorStreak: 0,
    invocations: 0,
    postInvocations: 0,
    warnings: 0,
    blocks: 0,
    oscillationsDetected: 0,
    stepBudgetBlocks: 0,
    noDiffWarnings: 0,
    noDiffBlocks: 0,
    repeatedErrorWarnings: 0,
    repeatedErrorBlocks: 0,
  };
}

const state: LoopBreakerState = { runs: new Map(), hookUnregister: null };

function sessionKey(sessionId: string | undefined): string {
  return sessionId || FALLBACK_SESSION;
}

function storeRun(key: string, current: LoopBreakerRunState): void {
  state.runs.set(key, current);
  if (state.runs.size <= MAX_TRACKED_RUNS) return;
  const oldest = state.runs.keys().next().value;
  if (oldest !== undefined && oldest !== key) state.runs.delete(oldest);
}

function runState(sessionId: string | undefined): LoopBreakerRunState {
  const key = sessionKey(sessionId);
  let current = state.runs.get(key);
  if (!current) {
    current = createRunState();
    storeRun(key, current);
  }
  return current;
}

function resetRun(sessionId: string | undefined): void {
  storeRun(sessionKey(sessionId), createRunState());
}

function aggregateRuns(): LoopBreakerRunState {
  const total = createRunState();
  for (const current of state.runs.values()) {
    total.invocations += current.invocations;
    total.postInvocations += current.postInvocations;
    total.warnings += current.warnings;
    total.blocks += current.blocks;
    total.oscillationsDetected += current.oscillationsDetected;
    total.stepBudgetBlocks += current.stepBudgetBlocks;
    total.noDiffWarnings += current.noDiffWarnings;
    total.noDiffBlocks += current.noDiffBlocks;
    total.repeatedErrorWarnings += current.repeatedErrorWarnings;
    total.repeatedErrorBlocks += current.repeatedErrorBlocks;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface LoopBreakerConfig {
  enabled: boolean;
  mode: 'block' | 'warn';
  warnAfter: number;
  blockAfter: number;
  oscillationWindow: number;
  /** Maximum observed tool steps before blocking; 0 disables. */
  maxSteps: number;
  /** Successful edit/write steps without a changed git diff before warning. */
  noDiffWarnAfter: number;
  /** Successful edit/write steps without a changed git diff before blocking next step; 0 disables. */
  noDiffBlockAfter: number;
  /** Consecutive identical tool errors before warning. */
  repeatedErrorWarnAfter: number;
  /** Consecutive identical tool errors before blocking next step; 0 disables. */
  repeatedErrorBlockAfter: number;
  ignoreTools: string[];
}

const DEFAULTS: LoopBreakerConfig = {
  // The master switch defaults ON, like every other official plugin's.
  // It defaulted to false while the host catalog listed the plugin as
  // default-active, so all three hooks below were registered and every
  // one of them returned on its first line: the guard could not fire for
  // anyone who had not hand-written a config block. Opting in belongs to
  // host enablement (`DEFAULT_ACTIVE_PLUGINS` in plugins/src/manifest),
  // never to this switch — see the plugin-enable-double-gate audit.
  enabled: true,
  // Documented contract (feature matrix, plugin description): warn, then
  // block. A warn-only default meant an agent stuck re-issuing the same call
  // was never actually stopped unless the user happened to set any option.
  mode: 'block',
  warnAfter: 3,
  blockAfter: 5,
  oscillationWindow: 8,
  maxSteps: 0,
  noDiffWarnAfter: 6,
  noDiffBlockAfter: 10,
  repeatedErrorWarnAfter: 2,
  repeatedErrorBlockAfter: 3,
  ignoreTools: [],
};

/**
 * Tool name set for O(1) lookup instead of Array.includes() O(n).
 *
 * Performance: converts the ignoreTools array to a Set at config read time
 * so the hook's per-tool name check is O(1) instead of O(n).
 */
let ignoreToolsSet = new Set(DEFAULTS.ignoreTools);

function readConfig(raw: unknown): LoopBreakerConfig {
  if (!raw || typeof raw !== 'object') {
    ignoreToolsSet = new Set(DEFAULTS.ignoreTools);
    return { ...DEFAULTS };
  }
  const r = raw as Record<string, unknown>;
  const rawWarn = r['warnAfter'] ?? r['warn_after'] ?? r['warnThreshold'] ?? r['warn_threshold'];
  const warnAfter = typeof rawWarn === 'number' && rawWarn >= 2 ? rawWarn : DEFAULTS.warnAfter;
  const rawBlock =
    r['blockAfter'] ?? r['block_after'] ?? r['blockThreshold'] ?? r['block_threshold'];
  const blockAfter =
    typeof rawBlock === 'number' && rawBlock > warnAfter
      ? rawBlock
      : Math.max(DEFAULTS.blockAfter, warnAfter + 1);
  const rawIgnore = r['ignoreTools'] ?? r['ignore_tools'] ?? r['ignore'] ?? r['ignoredTools'];
  const ignoreTools = Array.isArray(rawIgnore)
    ? (rawIgnore as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];

  // Update the module-scope Set for O(1) lookup in the hook.
  ignoreToolsSet = new Set(ignoreTools);

  const rawMode =
    typeof (r['mode'] ?? r['action'] ?? r['behavior']) === 'string'
      ? String(r['mode'] ?? r['action'] ?? r['behavior'])
          .trim()
          .toLowerCase()
      : undefined;
  // Only an explicit `warn` disables blocking. Missing or misspelled values
  // take the default — the same answer as having no config object at all.
  // (A partial config used to block while no config only warned.)
  const mode = rawMode === 'warn' || rawMode === 'block' ? rawMode : DEFAULTS.mode;

  const rawOsc = r['oscillationWindow'] ?? r['oscillation_window'] ?? r['window'];
  const rawMaxSteps = r['maxSteps'] ?? r['max_steps'] ?? r['stepLimit'] ?? r['step_limit'];

  return {
    // `=== true` here was the second half of the same double gate as the
    // `enabled: false` default: writing ANY option (`{ mode: 'block' }`)
    // silently kept the guard off, because only the literal `enabled: true`
    // could switch it on. Opting out now takes an explicit `enabled: false`,
    // matching every sibling plugin in this package.
    enabled: r['enabled'] !== false,
    mode,
    warnAfter,
    blockAfter,
    oscillationWindow:
      typeof rawOsc === 'number' && rawOsc >= 4 ? rawOsc : DEFAULTS.oscillationWindow,
    maxSteps:
      typeof rawMaxSteps === 'number' && rawMaxSteps >= 0
        ? Math.floor(rawMaxSteps)
        : DEFAULTS.maxSteps,
    noDiffWarnAfter:
      typeof r['noDiffWarnAfter'] === 'number' && r['noDiffWarnAfter'] >= 1
        ? Math.floor(r['noDiffWarnAfter'])
        : DEFAULTS.noDiffWarnAfter,
    noDiffBlockAfter:
      typeof r['noDiffBlockAfter'] === 'number' && r['noDiffBlockAfter'] >= 0
        ? Math.floor(r['noDiffBlockAfter'])
        : DEFAULTS.noDiffBlockAfter,
    repeatedErrorWarnAfter:
      typeof r['repeatedErrorWarnAfter'] === 'number' && r['repeatedErrorWarnAfter'] >= 1
        ? Math.floor(r['repeatedErrorWarnAfter'])
        : DEFAULTS.repeatedErrorWarnAfter,
    repeatedErrorBlockAfter:
      typeof r['repeatedErrorBlockAfter'] === 'number' && r['repeatedErrorBlockAfter'] >= 0
        ? Math.floor(r['repeatedErrorBlockAfter'])
        : DEFAULTS.repeatedErrorBlockAfter,
    ignoreTools,
  };
}

const MUTATING_TOOLS = new Set(['edit', 'write', 'write_to_file', 'replace_file_content']);

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'loop-breaker',
  version: '0.1.0',
  description:
    'Detects runaway tool-call loops (identical repeats and A-B-A-B oscillation) — warns the model, then blocks',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: true,
        description: 'Master switch; set false to turn the loop guard off.',
      },
      mode: {
        type: 'string',
        enum: ['warn', 'block'],
        default: 'block',
        description: 'block = refuse the repeated call; warn = only inject context.',
      },
      warnAfter: {
        type: 'number',
        minimum: 2,
        default: 3,
        description: 'Consecutive identical calls before a warning is injected.',
      },
      blockAfter: {
        type: 'number',
        minimum: 3,
        default: 5,
        description: 'Consecutive identical calls before the call is blocked.',
      },
      oscillationWindow: {
        type: 'number',
        minimum: 4,
        default: 8,
        description: 'Recent-call window length used for A-B-A-B oscillation detection.',
      },
      maxSteps: {
        type: 'number',
        minimum: 0,
        default: 0,
        description: 'Optional maximum tool steps before blocking; 0 keeps runs unlimited.',
      },
      noDiffWarnAfter: {
        type: 'number',
        minimum: 1,
        default: 6,
        description: 'Successful edit/write steps without a changed git diff before warning.',
      },
      noDiffBlockAfter: {
        type: 'number',
        minimum: 0,
        default: 10,
        description:
          'Successful edit/write steps without a changed git diff before blocking next step; 0 disables.',
      },
      repeatedErrorWarnAfter: {
        type: 'number',
        minimum: 1,
        default: 2,
        description: 'Consecutive identical tool errors before warning.',
      },
      repeatedErrorBlockAfter: {
        type: 'number',
        minimum: 0,
        default: 3,
        description: 'Consecutive identical tool errors before blocking next step; 0 disables.',
      },
      ignoreTools: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description: 'Tool names exempt from loop detection.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.runs.clear();
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['loop-breaker']);

    const hook = (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      sessionId?: string | undefined;
    }) => {
      if (!cfg.enabled) return;
      const toolName = input.toolName ?? 'unknown';
      // Performance: uses Set.has() for O(1) lookup instead of Array.includes() O(n).
      if (ignoreToolsSet.has(toolName)) return;
      const current = runState(input.sessionId);

      if (current.pendingBlockReason && cfg.mode === 'block') {
        const reason = current.pendingBlockReason;
        current.pendingBlockReason = null;
        current.blocks += 1;
        api.metrics.counter('blocks');
        return { decision: 'block' as const, reason };
      }

      // A denied attempt is not an executed step. Keeping this saturated at
      // the cap also avoids misleading 206/200, 207/200, ... diagnostics.
      if (cfg.maxSteps > 0 && current.invocations >= cfg.maxSteps && cfg.mode === 'block') {
        current.blocks += 1;
        current.stepBudgetBlocks += 1;
        api.metrics.counter('blocks');
        api.metrics.counter('step_budget_blocks');
        return {
          decision: 'block' as const,
          reason:
            `loop-breaker: step budget exceeded (${current.invocations}/${cfg.maxSteps} tool calls). ` +
            'Stop and report what has been tried instead of continuing an unbounded loop.',
        };
      }
      current.invocations += 1;

      const fp = fingerprint(toolName, input.toolInput);
      if (fp === current.lastFingerprint) {
        current.streak += 1;
      } else {
        current.lastFingerprint = fp;
        current.streak = 1;
      }
      current.recent.push(fp);
      if (current.recent.length > Math.max(cfg.oscillationWindow, 16)) {
        current.recent.splice(0, current.recent.length - Math.max(cfg.oscillationWindow, 16));
      }

      // ── Consecutive identical repeats ─────────────────────────────────
      if (current.streak >= cfg.blockAfter && cfg.mode === 'block') {
        current.blocks += 1;
        api.metrics.counter('blocks');
        return {
          decision: 'block' as const,
          reason:
            `loop-breaker: "${toolName}" has been called ${current.streak} times in a row with identical input. ` +
            'This looks like a runaway loop. Change the input, try a different tool, or explain to the user why repetition is needed. ' +
            '(Disable this guard via config.extensions["loop-breaker"].enabled = false.)',
        };
      }
      if (current.streak >= cfg.warnAfter) {
        current.warnings += 1;
        api.metrics.counter('warnings');
        const remaining = cfg.mode === 'block' ? cfg.blockAfter - current.streak : null;
        return {
          decision: 'allow' as const,
          additionalContext:
            `loop-breaker: "${toolName}" repeated ${current.streak}x with identical input.` +
            (remaining !== null && remaining > 0
              ? ` It will be BLOCKED after ${remaining} more identical call(s).`
              : '') +
            ' If the previous result was not what you needed, change the approach instead of retrying.',
        };
      }

      // ── A-B-A-B oscillation ───────────────────────────────────────────
      if (isOscillating(current.recent, cfg.oscillationWindow)) {
        current.oscillationsDetected += 1;
        api.metrics.counter('oscillations');
        // Reset the window so we don't warn on every subsequent call.
        current.recent = [];
        return {
          decision: 'allow' as const,
          additionalContext:
            `loop-breaker: the last ${cfg.oscillationWindow} tool calls alternate between two identical calls (A-B-A-B pattern). ` +
            'You appear to be undoing and redoing the same work. Step back and pick a single approach.',
        };
      }
      return;
    };

    const postHook = async (
      input: {
        toolName?: string | undefined;
        toolInput?: unknown;
        toolResult?: { content: string; isError: boolean } | undefined;
        cwd?: string | undefined;
        sessionId?: string | undefined;
      },
      runtime: { signal: AbortSignal } = { signal: new AbortController().signal },
    ) => {
      if (!cfg.enabled) return;
      const toolName = input.toolName ?? 'unknown';
      // Performance: uses Set.has() for O(1) lookup instead of Array.includes() O(n).
      if (ignoreToolsSet.has(toolName)) return;
      const current = runState(input.sessionId);
      current.postInvocations += 1;

      if (input.toolResult?.isError) {
        const errorFingerprint = normalizeError(input.toolResult.content);
        if (errorFingerprint && errorFingerprint === current.lastErrorFingerprint) {
          current.repeatedErrorStreak += 1;
        } else {
          current.lastErrorFingerprint = errorFingerprint;
          current.repeatedErrorStreak = errorFingerprint ? 1 : 0;
        }
        current.noDiffStreak = 0;

        if (
          cfg.repeatedErrorBlockAfter > 0 &&
          current.repeatedErrorStreak >= cfg.repeatedErrorBlockAfter &&
          cfg.mode === 'block'
        ) {
          current.repeatedErrorBlocks += 1;
          current.pendingBlockReason =
            `loop-breaker: the same tool error repeated ${current.repeatedErrorStreak} times. ` +
            'The next tool call is blocked so you can stop, summarize the repeated failure, and change approach.';
        }
        if (current.repeatedErrorStreak >= cfg.repeatedErrorWarnAfter) {
          current.repeatedErrorWarnings += 1;
          api.metrics.counter('repeated_error_warnings');
          return {
            decision: 'allow' as const,
            additionalContext:
              `loop-breaker: same error repeated ${current.repeatedErrorStreak}x. ` +
              'Do not retry the same command/tool unchanged; inspect the root cause or ask for help.',
          };
        }
        return;
      }

      current.lastErrorFingerprint = null;
      current.repeatedErrorStreak = 0;

      if (!MUTATING_TOOLS.has(toolName)) return;
      const toolInput = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawTarget =
        toolInput['path'] ??
        toolInput['TargetFile'] ??
        toolInput['filePath'] ??
        toolInput['targetFile'] ??
        toolInput['file_path'] ??
        toolInput['destination'] ??
        toolInput['file'];
      const targetPath = typeof rawTarget === 'string' ? rawTarget : undefined;
      if (typeof targetPath !== 'string' || targetPath.length === 0) return;
      const diffFingerprint = await gitDiffFingerprint(
        input.cwd ?? process.cwd(),
        targetPath,
        runtime.signal,
      );
      if (diffFingerprint === null) return;
      if (diffFingerprint === current.lastDiffFingerprint) {
        current.noDiffStreak += 1;
      } else {
        current.lastDiffFingerprint = diffFingerprint;
        current.noDiffStreak = 0;
      }

      if (
        cfg.noDiffBlockAfter > 0 &&
        current.noDiffStreak >= cfg.noDiffBlockAfter &&
        cfg.mode === 'block'
      ) {
        current.noDiffBlocks += 1;
        current.pendingBlockReason =
          `loop-breaker: no diff was produced in the last ${current.noDiffStreak} mutating step(s). ` +
          'The next tool call is blocked because continued edits are not changing the working tree.';
      }
      if (current.noDiffStreak >= cfg.noDiffWarnAfter) {
        current.noDiffWarnings += 1;
        api.metrics.counter('no_diff_warnings');
        return {
          decision: 'allow' as const,
          additionalContext:
            `loop-breaker: no diff has changed for ${current.noDiffStreak} mutating step(s). ` +
            'Stop repeating edits; read the file/status, explain why no change is happening, or choose a different approach.',
        };
      }
      return;
    };

    const unregisterPre = api.registerHook('PreToolUse', '*', hook as never, {
      name: 'loop-breaker',
      stage: 'validate',
      failurePolicy: 'open',
    });
    const unregisterPost = api.registerHook('PostToolUse', '*', postHook as never, {
      name: 'loop-breaker-progress',
      timeoutMs: 2_000,
      failurePolicy: 'open',
    });
    const unregisterPrompt = api.registerHook(
      'UserPromptSubmit',
      undefined,
      ((input: { sessionId?: string | undefined }) => {
        // maxSteps and all loop streaks describe one agent run. A new user
        // prompt starts a new run even though the long-lived WebUI plugin host
        // and conversation session remain alive.
        resetRun(input.sessionId);
      }) as never,
      { name: 'loop-breaker-turn-reset', failurePolicy: 'open' },
    );
    state.hookUnregister = () => {
      unregisterPre();
      unregisterPost();
      unregisterPrompt();
    };

    // ── loop_breaker_status tool ──────────────────────────────────────
    api.tools.register({
      name: 'loop_breaker_status',
      description:
        'Reports loop-breaker state: config, current repeat streak, and counters (warnings, blocks, oscillations).',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute(_input, ctx) {
        const current = runState(ctx?.session?.id);
        return {
          ok: true,
          enabled: cfg.enabled,
          mode: cfg.mode,
          warnAfter: cfg.warnAfter,
          blockAfter: cfg.blockAfter,
          oscillationWindow: cfg.oscillationWindow,
          maxSteps: cfg.maxSteps,
          noDiffWarnAfter: cfg.noDiffWarnAfter,
          noDiffBlockAfter: cfg.noDiffBlockAfter,
          repeatedErrorWarnAfter: cfg.repeatedErrorWarnAfter,
          repeatedErrorBlockAfter: cfg.repeatedErrorBlockAfter,
          ignoreTools: cfg.ignoreTools,
          currentStreak: current.streak,
          noDiffStreak: current.noDiffStreak,
          repeatedErrorStreak: current.repeatedErrorStreak,
          counters: {
            invocations: current.invocations,
            postInvocations: current.postInvocations,
            warnings: current.warnings,
            blocks: current.blocks,
            oscillationsDetected: current.oscillationsDetected,
            stepBudgetBlocks: current.stepBudgetBlocks,
            noDiffWarnings: current.noDiffWarnings,
            noDiffBlocks: current.noDiffBlocks,
            repeatedErrorWarnings: current.repeatedErrorWarnings,
            repeatedErrorBlocks: current.repeatedErrorBlocks,
          },
        };
      },
    });

    api.log.info('loop-breaker plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      mode: cfg.mode,
      warnAfter: cfg.warnAfter,
      blockAfter: cfg.blockAfter,
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
    const final = aggregateRuns();
    state.runs.clear();
    api.log.info('loop-breaker: teardown complete', { final });
  },

  async health() {
    const totals = aggregateRuns();
    return {
      ok: true,
      message: `loop-breaker: ${totals.invocations} call(s) observed, ${totals.warnings + totals.noDiffWarnings + totals.repeatedErrorWarnings} warning(s), ${totals.blocks} block(s), ${totals.oscillationsDetected} oscillation(s)`,
      counters: {
        invocations: totals.invocations,
        postInvocations: totals.postInvocations,
        warnings: totals.warnings,
        blocks: totals.blocks,
        oscillationsDetected: totals.oscillationsDetected,
        stepBudgetBlocks: totals.stepBudgetBlocks,
        noDiffWarnings: totals.noDiffWarnings,
        noDiffBlocks: totals.noDiffBlocks,
        repeatedErrorWarnings: totals.repeatedErrorWarnings,
        repeatedErrorBlocks: totals.repeatedErrorBlocks,
      },
    };
  },
};

export default plugin;
