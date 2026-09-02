/**
 * token-budget plugin — Enforces a per-session token budget.
 *
 * Complements cost-tracker (which tracks but does not enforce).
 * When token usage crosses the warning threshold, injects a "wrap up"
 * signal into the LLM's context. When it crosses the hard limit,
 * triggers a Stop hook to end the agent loop.
 *
 * Tools registered:
 * - token_budget_status : Show budget limit, current usage, percent
 *                          consumed, and whether the warning/stop
 *                          threshold has been crossed.
 *
 * Hooks registered:
 * - Stop : checks whether the budget is exhausted; if so, returns
 *          `decision: 'block'` with a reason so the agent loop does
 *          not continue.
 *
 * Events subscribed:
 * - provider.response : accumulates prompt + completion tokens.
 *
 * Config surface (`config.extensions['token-budget']`):
 *
 * ```jsonc
 * {
 *   "limit": 500000,       // hard token limit (prompt + completion)
 *   "warnPercent": 80,     // inject "wrap up" at this % of limit
 *   "stopPercent": 100,    // trigger Stop at this % of limit
 *   "model": null          // null = all models; or restrict to one
 * }
 * ```
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core/types';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

const state = {
  totalTokens: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  requestCount: 0,
  /** Whether the warning has already fired (one-shot). */
  warningFired: false,
  /** Whether the stop has already fired (one-shot). */
  stopFired: false,
  /** Whether the warning context has been injected into the LLM (one-shot). */
  warnContextInjected: false,
  /** Whether the stop context has been injected into the LLM (one-shot). */
  stopContextInjected: false,
  /** Stop hook unregister handle. */
  hookUnregister: null as null | (() => void),
  /** PostToolUse hook unregister handle. */
  postHookUnregister: null as null | (() => void),
  /** Last token breakdown — surfaced by health(). */
  lastRequest: null as null | {
    model: string;
    prompt: number;
    completion: number;
    when: string;
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface TokenBudgetConfig {
  /** Hard token limit (prompt + completion combined). 0 = no limit. */
  limit: number;
  /** Percentage of limit at which to inject "wrap up" context. */
  warnPercent: number;
  /** Percentage of limit at which to trigger Stop. */
  stopPercent: number;
  /** Restrict counting to a specific model (empty string = all models). */
  model: string;
}

const DEFAULTS: TokenBudgetConfig = {
  limit: 0,
  warnPercent: 80,
  stopPercent: 100,
  model: '',
};

/**
 * Check if a model name matches a pattern. Supports '*' as a trailing
 * wildcard: "gpt-4*" matches "gpt-4", "gpt-4o", "gpt-4o-mini".
 * No wildcard = exact match (case-insensitive).
 */
function modelMatches(pattern: string, model: string): boolean {
  if (pattern === '') return true;
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1).toLowerCase();
    return model.toLowerCase().startsWith(prefix);
  }
  return model.toLowerCase() === pattern.toLowerCase();
}

/**
 * Read a numeric option, falling back to the default unless it is a finite
 * number inside `[min, max]`.
 *
 * The bounds in `configSchema` document intent but do not police this
 * function: it read any `typeof === 'number'` value straight through, so
 * `NaN`, `Infinity`, a negative limit, or `warnPercent: 500` all landed in
 * the live config. `NaN` is the worst of them — every comparison against it
 * is false, so the budget silently stopped enforcing anything.
 */
function readBoundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

function readConfig(raw: unknown): TokenBudgetConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawWarn =
    r['warnPercent'] ?? r['warn_percent'] ?? r['warnThreshold'] ?? r['warn_threshold'];
  const rawStop =
    r['stopPercent'] ?? r['stop_percent'] ?? r['stopThreshold'] ?? r['stop_threshold'];
  const rawLimit = r['limit'] ?? r['maxTokens'] ?? r['max_tokens'] ?? r['budget'];
  const warnPercent = readBoundedNumber(rawWarn, 1, 100, DEFAULTS.warnPercent);
  const stopPercent = readBoundedNumber(rawStop, 1, 100, DEFAULTS.stopPercent);
  return {
    limit: readBoundedNumber(rawLimit, 0, Number.MAX_SAFE_INTEGER, DEFAULTS.limit),
    warnPercent,
    // A warn threshold above the stop threshold can never fire — the run
    // stops first. Clamp so the pair always describes a reachable window.
    stopPercent: Math.max(stopPercent, warnPercent),
    model: typeof r['model'] === 'string' ? r['model'] : '',
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Drop every hook this plugin owns.
 *
 * Shared by `setup()` (idempotent re-init) and `teardown()`. Setup must go
 * through here rather than nulling the handles directly — otherwise the
 * previous registration is abandoned in the registry, unreachable, and
 * still firing.
 */
function clearRegistrations(): void {
  for (const key of ['hookUnregister', 'postHookUnregister'] as const) {
    const off = state[key];
    if (!off) continue;
    try {
      off();
    } catch {
      // best-effort
    }
    state[key] = null;
  }
}

const plugin: Plugin = {
  name: 'token-budget',
  version: '0.1.0',
  description:
    'Enforces a per-session token budget — warns at a threshold and stops the agent loop when the limit is hit',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        minimum: 0,
        default: 0,
        description:
          'Hard token limit (prompt + completion combined). 0 = disabled (tracking only).',
      },
      warnPercent: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 80,
        description: 'Percentage of limit at which to inject a "wrap up" context signal.',
      },
      stopPercent: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 100,
        description: 'Percentage of limit at which to trigger Stop (end the agent loop).',
      },
      model: {
        type: 'string',
        default: '',
        description:
          'Restrict counting to a specific model. Supports "*" trailing wildcard (e.g. "gpt-4*" matches gpt-4o, gpt-4o-mini). Empty string = count all models.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.totalTokens = 0;
    state.totalPromptTokens = 0;
    state.totalCompletionTokens = 0;
    state.requestCount = 0;
    state.warningFired = false;
    state.stopFired = false;
    state.warnContextInjected = false;
    state.stopContextInjected = false;
    state.lastRequest = null;
    // Unregister BEFORE dropping the handles. Assigning null without
    // calling them abandoned the previous registration: the old Stop and
    // PostToolUse hooks stayed live in the registry with no way to reach
    // them, so every plugin reload stacked another copy that fired
    // alongside the new one.
    clearRegistrations();

    const cfg = readConfig(api.config.extensions?.['token-budget']);

    // Subscribe to provider.response to accumulate tokens.
    api.onEvent('provider.response', (payload: unknown) => {
      const p = payload as {
        usage?: { input?: number; output?: number };
        ctx?: { model?: string };
      };
      const usage = p?.usage;
      if (!usage) return;

      // Filter by model if configured. Supports '*' wildcard suffix:
      // "gpt-4*" matches gpt-4, gpt-4o, gpt-4o-mini, etc.
      // Empty string = count all models.
      const rawPayload = (p ?? {}) as Record<string, unknown>;
      const modelName =
        (typeof rawPayload['model'] === 'string' ? rawPayload['model'] : undefined) ??
        (typeof p?.ctx?.model === 'string' ? p.ctx.model : undefined) ??
        (typeof (rawPayload['response'] as Record<string, unknown> | undefined)?.['model'] ===
        'string'
          ? ((rawPayload['response'] as Record<string, unknown>)['model'] as string)
          : 'unknown');

      if (cfg.model !== '' && modelName !== 'unknown') {
        if (!modelMatches(cfg.model, modelName)) return;
      }

      const rawUsage = usage as Record<string, unknown>;
      const promptTokens =
        (typeof rawUsage['input'] === 'number' ? rawUsage['input'] : undefined) ??
        (typeof rawUsage['prompt_tokens'] === 'number' ? rawUsage['prompt_tokens'] : undefined) ??
        (typeof rawUsage['input_tokens'] === 'number' ? rawUsage['input_tokens'] : undefined) ??
        (typeof rawUsage['promptTokens'] === 'number' ? rawUsage['promptTokens'] : 0);

      const completionTokens =
        (typeof rawUsage['output'] === 'number' ? rawUsage['output'] : undefined) ??
        (typeof rawUsage['completion_tokens'] === 'number'
          ? rawUsage['completion_tokens']
          : undefined) ??
        (typeof rawUsage['output_tokens'] === 'number' ? rawUsage['output_tokens'] : undefined) ??
        (typeof rawUsage['completionTokens'] === 'number' ? rawUsage['completionTokens'] : 0);
      const total = promptTokens + completionTokens;

      state.totalPromptTokens += promptTokens;
      state.totalCompletionTokens += completionTokens;
      state.totalTokens += total;
      state.requestCount += 1;
      state.lastRequest = {
        model: modelName,
        prompt: promptTokens,
        completion: completionTokens,
        when: new Date().toISOString(),
      };

      // No limit = tracking only, no enforcement.
      if (cfg.limit <= 0) return;

      const percent = (state.totalTokens / cfg.limit) * 100;

      // Warning threshold (one-shot injection).
      if (!state.warningFired && percent >= cfg.warnPercent && percent < cfg.stopPercent) {
        state.warningFired = true;
        const remaining = cfg.limit - state.totalTokens;
        api.log.info('token-budget: warning threshold reached', {
          percent: Math.round(percent),
          remaining,
        });
        // We can't inject context from onEvent directly — but we can
        // emit a custom event that the host or another plugin can
        // listen for. The Stop hook (below) also checks the budget
        // on every iteration.
        api.emitCustom('token-budget:warning', {
          percent: Math.round(percent),
          remaining,
          total: state.totalTokens,
          limit: cfg.limit,
        });
      }

      // Stop threshold (one-shot).
      if (!state.stopFired && percent >= cfg.stopPercent) {
        state.stopFired = true;
        api.log.warn('token-budget: hard limit reached — agent loop will be stopped', {
          total: state.totalTokens,
          limit: cfg.limit,
        });
        api.emitCustom('token-budget:limit_reached', {
          total: state.totalTokens,
          limit: cfg.limit,
        });
      }
    });

    // Register a Stop hook that checks the budget. When the stop
    // threshold is reached, this hook returns decision: 'block' with
    // a clear reason, preventing the agent loop from continuing.
    state.hookUnregister = api.registerHook('Stop', undefined, () => {
      if (cfg.limit <= 0 || !state.stopFired) return;
      return {
        decision: 'block',
        reason:
          `token-budget: session token limit reached (${state.totalTokens.toLocaleString()} / ${cfg.limit.toLocaleString()} tokens). ` +
          `The budget is exhausted — wrap up the current task and summarize what was accomplished.`,
      };
    });

    // Register a PostToolUse hook that injects budget status into the
    // LLM's context after every tool call. This is how the LLM "feels"
    // the budget pressure — without it, the warning/stop events fire
    // but the LLM never sees them (emitCustom is an inter-plugin
    // channel, not an LLM-facing channel).
    //
    // The hook fires on every tool (matcher '*'). When the warning
    // threshold has been crossed (one-shot), it injects a "wrap up"
    // additionalContext. When the stop threshold is reached, it injects
    // an urgent "stop now" context. Both are one-shot per threshold
    // crossing; after the initial injection, the hook is silent so it
    // doesn't spam the context window on every subsequent tool call.
    state.postHookUnregister = api.registerHook('PostToolUse', '*', () => {
      if (cfg.limit <= 0) return;
      const percent = Math.round((state.totalTokens / cfg.limit) * 100);
      const remaining = Math.max(cfg.limit - state.totalTokens, 0);

      // One-shot: first time crossing stopPercent after a tool call.
      if (state.stopFired && !state.stopContextInjected) {
        state.stopContextInjected = true;
        return {
          additionalContext:
            `\n🛑 token-budget: HARD LIMIT REACHED — ${state.totalTokens.toLocaleString()} / ${cfg.limit.toLocaleString()} tokens (${percent}%). ` +
            `You must stop here. Do NOT start any new task. Summarize what was accomplished and list any remaining work.`,
        };
      }

      // One-shot: first time crossing warnPercent after a tool call.
      if (state.warningFired && !state.warnContextInjected) {
        state.warnContextInjected = true;
        return {
          additionalContext:
            `\n⚠️ token-budget: ${percent}% of budget used (${state.totalTokens.toLocaleString()} / ${cfg.limit.toLocaleString()} tokens, ${remaining.toLocaleString()} remaining). ` +
            `Start wrapping up — prioritize finishing the current task over starting new ones.`,
        };
      }

      // After the one-shot injections, stay silent. The
      // token_budget_status tool is available for the LLM to check
      // the exact remaining budget if needed.
      return;
    });

    // --- token_budget_status tool ---
    api.tools.register({
      name: 'token_budget_status',
      description:
        'Shows the current token budget status: limit, consumed, remaining, percentage, and whether warning/stop thresholds have been crossed.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Meta',
      mutating: false,
      async execute() {
        const consumed = state.totalTokens;
        const limit = cfg.limit;
        const percent = limit > 0 ? Math.round((consumed / limit) * 100) : 0;
        const remaining = limit > 0 ? Math.max(limit - consumed, 0) : Infinity;
        return {
          ok: true,
          limit,
          consumed,
          remaining,
          percent,
          requestCount: state.requestCount,
          // The EFFECTIVE thresholds, after out-of-range values fall back to
          // the defaults and warn/stop are ordered. Without these the user
          // cannot tell that a rejected or clamped setting is not in force.
          warnPercent: cfg.warnPercent,
          stopPercent: cfg.stopPercent,
          model: cfg.model === '' ? null : cfg.model,
          breakdown: {
            prompt: state.totalPromptTokens,
            completion: state.totalCompletionTokens,
          },
          warningFired: state.warningFired,
          stopFired: state.stopFired,
          lastRequest: state.lastRequest,
        };
      },
    });

    api.log.info('token-budget plugin loaded', {
      version: '0.1.0',
      limit: cfg.limit > 0 ? cfg.limit.toLocaleString() : 'unlimited',
      warnPercent: cfg.warnPercent,
      stopPercent: cfg.stopPercent,
    });
  },

  teardown(api) {
    // H1 pattern: unregister hooks + zero counters.
    clearRegistrations();
    const final = {
      totalTokens: state.totalTokens,
      requestCount: state.requestCount,
      warningFired: state.warningFired,
      stopFired: state.stopFired,
    };
    state.totalTokens = 0;
    state.totalPromptTokens = 0;
    state.totalCompletionTokens = 0;
    state.requestCount = 0;
    state.warningFired = false;
    state.stopFired = false;
    state.warnContextInjected = false;
    state.stopContextInjected = false;
    state.lastRequest = null;
    api.log.info('token-budget: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastRequest === null
          ? `token-budget: ${state.totalTokens.toLocaleString()} tokens across ${state.requestCount} request(s)`
          : `token-budget: ${state.totalTokens.toLocaleString()} tokens, last ${state.lastRequest.model} at ${state.lastRequest.when}`,
      totalTokens: state.totalTokens,
      requestCount: state.requestCount,
      warningFired: state.warningFired,
      stopFired: state.stopFired,
    };
  },
};

export default plugin;
