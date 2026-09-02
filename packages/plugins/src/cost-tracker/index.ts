/**
 * cost-tracker plugin — Tracks LLM token usage and cost per session.
 *
 * Config surface (`config.extensions['cost-tracker']`):
 *
 * ```jsonc
 * {
 *   "budgetLimit": 10,            // USD; 0 = no limit
 *   "warningThreshold": 80,       // percent of budget before warning
 *   "pricingOverrides": {         // user-supplied per-model rates (USD/1M tokens)
 *     "gpt-4o":              { "input": 5.0,  "output": 15.0 },
 *     "custom-model":        { "input": 3.0,  "output": 15.0 }
 *   }
 * }
 * ```
 *
 * Pricing lookup chain (first match wins, all keys lowercased):
 *
 * | Priority | Source                              | Populated by                         |
 * |----------|-------------------------------------|--------------------------------------|
 * | 1        | `pricingOverrides[model]`           | User config (highest priority)       |
 * | 2        | `bundledFromRegistry[model]`        | `api.modelsRegistry` (models.dev)    |
 * | 3        | `PRICING[model]`                    | Bundled baseline (updated per release)|
 * | 4        | `DEFAULT_PRICING`                   | Last-resort fallback for unknown models |
 *
 * Tools registered:
 * - cost_summary: Show token usage breakdown by model
 * - cost_reset: Reset tracking counters
 * - cost_export: Export cost report as JSON or CSV
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core/types';
import { expectDefined } from '@wrongstack/core/utils';
import { BoundedMap } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

/**
 * Per-model pricing in USD per 1 million tokens.
 *
 * Used by `pricingOverrides` (user config), `bundledFromRegistry`
 * (models.dev), and the bundled `PRICING` table. All three share
 * the same shape so the lookup chain can fall through uniformly.
 *
 * @public
 */
export interface ModelPricing {
  /** Cost per 1M input (prompt) tokens in USD. */
  input: number;
  /** Cost per 1M output (completion) tokens in USD. */
  output: number;
  /** Cost per 1M prompt-cache read tokens; input rate is the safe fallback. */
  cacheRead?: number | undefined;
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  timestamp: string;
  costUsd?: number | undefined;
}

interface SessionCost {
  requests: TokenUsage[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  byModel: Record<string, { tokens: number; costUsd: number; requests: number }>;
}

/**
 * Bundled pricing baseline (USD per 1M tokens).
 *
 * Values are intentionally hardcoded — provider-side pricing changes
 * are picked up here per release. Users can override per-model via
 * `config.extensions['cost-tracker'].pricingOverrides` without waiting
 * for a plugin version bump. The models.dev registry (when available
 * via `api.modelsRegistry`) provides a second override layer that
 * beats this baseline automatically.
 *
 * @internal
 */
const PRICING: Record<string, ModelPricing> = {
  'gpt-4o': { input: 5.0, output: 15.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'gemini-1.5-pro': { input: 3.5, output: 10.5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  default: { input: 5.0, output: 15.0 },
};

const DEFAULT_PRICING: ModelPricing = { input: 5.0, output: 15.0 };

/**
 * User-supplied per-model pricing overrides, populated from
 * `config.extensions['cost-tracker'].pricingOverrides` during `setup()`.
 *
 * Keys are lowercased to match the case-insensitive lookup in
 * `estimateCost`. Takes highest priority in the lookup chain.
 *
 * @internal
 */
const pricingOverrides: Record<string, ModelPricing> = {};

/**
 * Per-model pricing hydrated from the host's models registry
 * (`api.modelsRegistry`, backed by models.dev). Populated during
 * `setup()` as a fire-and-forget async operation. Second priority
 * in the lookup chain (beats bundled `PRICING`, loses to user
 * `pricingOverrides`).
 *
 * @internal
 */
const bundledFromRegistry: Record<string, ModelPricing> = {};

/**
 * Snapshot of the most recent cost calculation, for `health()`.
 *
 * @internal
 */
const lastCost = { usd: 0, model: null as string | null, at: null as string | null };

/**
 * Module-scope mailbox-digest counters (separate from sessionCost
 * because those reset on reload while these track cumulative plugin
 * activity for /diag). Reset on setup() per the H1 idempotency
 * pattern.
 */
const digestCounters = {
  totalRequests: 0,
  mailboxDigestsSent: 0,
  mailboxDigestErrors: 0,
};

interface CostTrackerConfig {
  budgetLimit: number;
  warningThreshold: number;
  /**
   * When > 0, the plugin posts a compact cost digest to the project
   * mailbox every N provider responses. Useful for fleet operators
   * who want a running total in their mailbox without polling the
   * `cost_summary` tool. Disabled (0) by default — set to 10 to get
   * a digest roughly every 10 LLM calls.
   */
  mailboxDigestEveryN: number;
  /**
   * Mailbox recipient. Defaults to `cost-tracker` (self-loop is fine
   * for the dedicated inbox view) or set to `*` to broadcast.
   */
  mailboxDigestTo: string;
}

/**
 * Read budget + warning-threshold from the user's config.
 *
 * @internal
 */
function readCostTrackerConfig(raw: Record<string, unknown> | undefined): CostTrackerConfig {
  const digestEveryN =
    raw?.['mailboxDigestEveryN'] ?? raw?.['mailbox_digest_every_n'] ?? raw?.['digestEveryN'];
  const digestTo = raw?.['mailboxDigestTo'] ?? raw?.['mailbox_digest_to'] ?? raw?.['digestTo'];
  const rawBudget =
    raw?.['budgetLimit'] ?? raw?.['budget_limit'] ?? raw?.['budget'] ?? raw?.['limit'];
  const rawThreshold =
    raw?.['warningThreshold'] ??
    raw?.['warning_threshold'] ??
    raw?.['warnThreshold'] ??
    raw?.['warn_threshold'] ??
    raw?.['threshold'];
  return {
    budgetLimit: typeof rawBudget === 'number' ? rawBudget : 0,
    warningThreshold: typeof rawThreshold === 'number' ? rawThreshold : 80,
    mailboxDigestEveryN:
      typeof digestEveryN === 'number' && digestEveryN >= 0 ? Math.floor(digestEveryN) : 0,
    mailboxDigestTo:
      typeof digestTo === 'string' && digestTo.length > 0 ? digestTo : 'cost-tracker',
  };
}

/**
 * Estimate the USD cost of a single LLM request.
 *
 * Uses the four-layer pricing lookup chain (first match wins, all keys
 * lowercased):
 *
 * 1. **User override** — `pricingOverrides[model]`, from
 *    `config.extensions['cost-tracker'].pricingOverrides`. Highest
 *    priority; lets users correct stale bundled rates immediately.
 * 2. **Registry** — `bundledFromRegistry[model]`, hydrated from the
 *    host's models.dev-backed `ModelsRegistry` on setup. Beats the
 *    bundled baseline so fresh catalog data wins automatically.
 * 3. **Bundled** — `PRICING[model]`, hardcoded per release.
 * 4. **Default** — `DEFAULT_PRICING` (input=$5, output=$15 per 1M),
 *    used when none of the above recognize the model name.
 *
 * Performance: caches the lowercased model key to avoid redundant
 * `.toLowerCase()` calls on repeated requests with the same model.
 *
 * @param model - The provider-reported model identifier (e.g. `'gpt-4o'`,
 *   `'custom-model'`). Case-insensitive — lowercased internally.
 * @param promptTokens - Number of input/prompt tokens consumed.
 * @param completionTokens - Number of output/completion tokens generated.
 * @returns Estimated cost in USD.
 *
 * @example
 * ```ts
 * // 1000 prompt + 500 completion tokens of gpt-4o ($5/$15 per 1M):
 * estimateCost('gpt-4o', 1000, 500);  // → 0.0125
 *
 * // Unknown model falls through to DEFAULT_PRICING:
 * estimateCost('future-model', 1000, 500);  // → 0.0125
 *
 * // User override of $10/$20 per 1M takes priority:
 * // (config: pricingOverrides: { 'gpt-4o': { input: 10, output: 20 } })
 * estimateCost('gpt-4o', 1000, 500);  // → 0.02
 * ```
 *
 * @public
 */
/** Model-id normalisation memo. Bounded — model ids come from provider
 * responses, so a misbehaving or proxying provider could otherwise mint
 * unbounded distinct keys. */
const modelKeyCache = new BoundedMap<string, string>({ max: 256 });

function estimateCost(
  model: string,
  freshTokens: number,
  completionTokens: number,
  cachedTokens = 0,
): number {
  // Cache the lowercased key to avoid redundant .toLowerCase() calls.
  let key = modelKeyCache.get(model);
  if (!key) {
    key = model.toLowerCase();
    modelKeyCache.set(model, key);
  }

  const unnamespaced = key.includes('/') ? key.split('/').pop()! : key;
  const pricing =
    pricingOverrides[key] ??
    pricingOverrides[unnamespaced] ??
    bundledFromRegistry[key] ??
    bundledFromRegistry[unnamespaced] ??
    PRICING[key] ??
    PRICING[unnamespaced] ??
    DEFAULT_PRICING;
  const inputCost =
    (freshTokens / 1_000_000) * pricing.input +
    (cachedTokens / 1_000_000) * (pricing.cacheRead ?? pricing.input);
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'cost-tracker',
  version: '0.1.0',
  description: 'Tracks LLM token usage and estimated cost per session with per-model breakdown',
  apiVersion: API_VERSION,
  capabilities: { tools: true, pipelines: ['request', 'response'] },
  defaultConfig: {
    trackPerModel: true,
    trackPerUser: false,
    budgetLimit: 0,
    warningThreshold: 80,
    pricingOverrides: {},
  },
  configSchema: {
    type: 'object',
    properties: {
      trackPerModel: { type: 'boolean', default: true },
      trackPerUser: { type: 'boolean', default: false },
      budgetLimit: {
        type: 'number',
        default: 0,
        description: 'Budget limit in USD (0 = no limit)',
      },
      warningThreshold: {
        type: 'number',
        default: 80,
        description: 'Warning threshold as percentage of budget',
      },
      pricingOverrides: {
        type: 'object',
        description:
          'Per-model pricing overrides in USD per 1M tokens. Values are { input, output, cacheRead? }.',
        additionalProperties: {
          type: 'object',
          properties: {
            input: { type: 'number', minimum: 0, description: 'Cost per 1M input tokens in USD' },
            output: { type: 'number', minimum: 0, description: 'Cost per 1M output tokens in USD' },
            cacheRead: {
              type: 'number',
              minimum: 0,
              description: 'Cost per 1M prompt-cache read tokens in USD',
            },
          },
          required: ['input', 'output'],
          additionalProperties: false,
        },
        default: {},
      },
    },
  },

  async setup(api) {
    // Idempotent re-init: clear any overrides that survived a previous
    // teardown, then apply the user-supplied ones. Mirroring the
    // template-engine / git-autocommit / cron / file-watcher pattern.
    for (const k of Object.keys(pricingOverrides)) {
      delete pricingOverrides[k];
    }
    for (const k of Object.keys(bundledFromRegistry)) {
      delete bundledFromRegistry[k];
    }
    // Clear model key cache to ensure fresh lowercasing after config changes.
    modelKeyCache.clear();

    lastCost.usd = 0;
    lastCost.model = null;
    lastCost.at = null;
    digestCounters.totalRequests = 0;
    digestCounters.mailboxDigestsSent = 0;
    digestCounters.mailboxDigestErrors = 0;

    // Apply user-supplied pricing overrides from config first (sync —
    // available immediately for the first cost calculation).
    const rawConfig = api.config.extensions?.['cost-tracker'] as
      | Record<string, unknown>
      | undefined;
    const cfg = readCostTrackerConfig(rawConfig);
    const userOverrides =
      rawConfig?.['pricingOverrides'] ?? rawConfig?.['pricing_overrides'] ?? rawConfig?.['pricing'];
    if (userOverrides && typeof userOverrides === 'object') {
      for (const [model, value] of Object.entries(userOverrides as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const v = value as Record<string, unknown>;
        const input = v['input'];
        const output = v['output'];
        if (typeof input !== 'number' || typeof output !== 'number') continue;
        const cacheRead = v['cacheRead'];
        pricingOverrides[model.toLowerCase()] = {
          input,
          output,
          ...(typeof cacheRead === 'number' ? { cacheRead } : {}),
        };
      }
    }

    // Hydrate `bundledFromRegistry` from the host's models registry.
    // This is now AWAITED (not fire-and-forget) so the registry layer
    // is populated BEFORE setup() returns — guaranteeing the first
    // `provider.response` event sees the full lookup chain.
    //
    // The registry's `load()` is cached (subsequent calls are
    // in-memory), so the await is near-instant on warm cache. On cold
    // start the network fetch is bounded by the registry's own
    // refreshTimeoutMs (default 15s). On any failure we log a warning
    // and proceed with the bundled PRICING table — the lookup chain's
    // other layers still cover common models.
    if (api.modelsRegistry) {
      try {
        const payload = await api.modelsRegistry.load();
        let hydrated = 0;
        for (const provider of Object.values(payload)) {
          const providerModels = provider?.models;
          if (!providerModels) continue;
          for (const [modelId, model] of Object.entries(providerModels)) {
            const cost = model?.cost;
            if (cost && typeof cost.input === 'number' && typeof cost.output === 'number') {
              bundledFromRegistry[modelId.toLowerCase()] = {
                input: cost.input,
                output: cost.output,
                ...(typeof cost.cache_read === 'number' ? { cacheRead: cost.cache_read } : {}),
              };
              hydrated += 1;
            }
          }
        }
        api.log.info('cost-tracker: hydrated pricing from models registry', {
          models: hydrated,
        });
      } catch (err) {
        // Defensive: a broken or absent registry must not break
        // cost-tracking. The lookup chain falls through to PRICING.
        api.log.warn(
          'cost-tracker: failed to hydrate pricing from models registry — using bundled PRICING',
          err,
        );
      }
    }

    // Track token usage per request across the response pipeline
    const sessionCost: SessionCost = {
      requests: [],
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      byModel: {},
    };

    // Subscribe to provider.response events to capture token usage
    api.onEvent('provider.response', async (payload) => {
      const usage = payload.usage;
      const model = payload.ctx?.model ?? 'unknown';

      const u = (usage ?? {}) as unknown as Record<string, unknown>;
      const cachedTokens =
        Number(u['cacheRead'] ?? u['cache_read_input_tokens'] ?? u['cached_prompt_tokens'] ?? 0) ||
        0;
      const rawInput =
        Number(u['input'] ?? u['prompt_tokens'] ?? u['inputTokens'] ?? u['promptTokens'] ?? 0) || 0;
      const rawCacheWrite = Number(u['cacheWrite'] ?? u['cache_creation_input_tokens'] ?? 0) || 0;
      const freshTokens = rawInput + rawCacheWrite;
      const promptTokens = freshTokens + cachedTokens;
      const completionTokens =
        Number(
          u['output'] ?? u['completion_tokens'] ?? u['outputTokens'] ?? u['completionTokens'] ?? 0,
        ) || 0;
      const totalTokens = promptTokens + completionTokens;
      const costUsd = estimateCost(model, freshTokens, completionTokens, cachedTokens);

      const record: TokenUsage = {
        promptTokens,
        completionTokens,
        totalTokens,
        model,
        timestamp: new Date().toISOString(),
        costUsd,
      };

      sessionCost.requests.push(record);
      sessionCost.totalPromptTokens += promptTokens;
      sessionCost.totalCompletionTokens += completionTokens;
      sessionCost.totalTokens += totalTokens;
      sessionCost.totalCostUsd += costUsd;

      if (sessionCost.byModel[model] === undefined) {
        sessionCost.byModel[model] = { tokens: 0, costUsd: 0, requests: 0 };
      }
      const slot = expectDefined(sessionCost.byModel[model]);
      slot.tokens += totalTokens;
      slot.costUsd += costUsd;
      slot.requests += 1;

      api.metrics.counter('tokens_total', totalTokens, { model });
      api.metrics.histogram('cost_usd', costUsd, { model });
      digestCounters.totalRequests += 1;

      // Opt-in mailbox digest: every N requests, post a running
      // totals summary. Skipped silently if the host has no mailbox
      // (minimal hosts, tests).
      if (
        cfg.mailboxDigestEveryN > 0 &&
        digestCounters.totalRequests % cfg.mailboxDigestEveryN === 0 &&
        api.mailbox
      ) {
        const top = Object.entries(sessionCost.byModel)
          .map(([m, v]) => `${m}:${v.tokens}t/${v.costUsd.toFixed(4)}`)
          .join(', ');
        try {
          await api.mailbox.send({
            to: cfg.mailboxDigestTo,
            from: 'cost-tracker',
            type: 'note',
            subject: `cost-tracker digest @ #${digestCounters.totalRequests} requests`,
            body:
              `running totals: ${sessionCost.totalTokens} tokens, ` +
              `~${sessionCost.totalCostUsd.toFixed(4)} USD, ${sessionCost.requests.length} reqs\n` +
              `by model: ${top || '(none)'}`,
          });
          digestCounters.mailboxDigestsSent += 1;
        } catch {
          digestCounters.mailboxDigestErrors += 1;
        }
      }

      // Snapshot for /diag plugins (health()).
      lastCost.usd = costUsd;
      lastCost.model = model;
      lastCost.at = new Date().toISOString();
    });

    // --- cost_summary tool ---
    api.tools.register({
      name: 'cost_summary',
      description:
        "Returns the current session's token usage breakdown by model, total cost estimate, and budget status.",
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Meta',
      mutating: false,
      async execute() {
        const { budgetLimit, warningThreshold } = cfg;

        const usage = {
          totalRequests: sessionCost.requests.length,
          totalPromptTokens: sessionCost.totalPromptTokens,
          totalCompletionTokens: sessionCost.totalCompletionTokens,
          totalTokens: sessionCost.totalTokens,
          totalCostUsd: Math.round(sessionCost.totalCostUsd * 1_000_000) / 1_000_000,
          byModel: sessionCost.byModel,
          recentRequests: sessionCost.requests.slice(-5).map((r) => ({
            model: r.model,
            tokens: r.totalTokens,
            costUsd: r.costUsd,
            ts: r.timestamp,
          })),
        };

        const budgetStatus =
          budgetLimit > 0
            ? {
                limit: budgetLimit,
                spent: sessionCost.totalCostUsd,
                percentUsed: Math.round((sessionCost.totalCostUsd / budgetLimit) * 100),
                warning: (sessionCost.totalCostUsd / budgetLimit) * 100 >= warningThreshold,
              }
            : null;

        return {
          ok: true,
          usage,
          budgetStatus,
        };
      },
    });

    // --- cost_reset tool ---
    api.tools.register({
      name: 'cost_reset',
      description: 'Resets all token usage and cost counters for the current session.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: true,
      async execute() {
        const prev = {
          totalTokens: sessionCost.totalTokens,
          totalCostUsd: sessionCost.totalCostUsd,
        };

        sessionCost.requests = [];
        sessionCost.totalPromptTokens = 0;
        sessionCost.totalCompletionTokens = 0;
        sessionCost.totalTokens = 0;
        sessionCost.totalCostUsd = 0;
        sessionCost.byModel = {};

        return {
          ok: true,
          previousTotals: prev,
          message: 'Cost tracking counters have been reset.',
        };
      },
    });

    // --- cost_export tool ---
    api.tools.register({
      name: 'cost_export',
      description: 'Export the cost report as JSON or CSV.',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
          includeModel: { type: 'boolean', default: true },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const format = (input['format'] as 'json' | 'csv') ?? 'json';
        const includeModel = (input['includeModel'] as boolean) ?? true;

        if (format === 'csv') {
          const header = includeModel
            ? 'model,timestamp,prompt_tokens,completion_tokens,total_tokens,cost_usd'
            : 'timestamp,prompt_tokens,completion_tokens,total_tokens,cost_usd';
          const rows = sessionCost.requests.map((r) => {
            /* v8 ignore next -- costUsd is always set by estimateCost; the ?? 0 fallback is defensive. */
            const cost = r.costUsd ?? 0;
            return includeModel
              ? `${r.model},${r.timestamp},${r.promptTokens},${r.completionTokens},${r.totalTokens},${cost}`
              : `${r.timestamp},${r.promptTokens},${r.completionTokens},${r.totalTokens},${cost}`;
          });
          return {
            ok: true,
            format: 'csv',
            data: [header, ...rows].join('\n'),
            summary: {
              totalTokens: sessionCost.totalTokens,
              totalCostUsd: sessionCost.totalCostUsd,
              totalRequests: sessionCost.requests.length,
            },
          };
        }

        return {
          ok: true,
          format: 'json',
          data: {
            summary: {
              totalTokens: sessionCost.totalTokens,
              totalPromptTokens: sessionCost.totalPromptTokens,
              totalCompletionTokens: sessionCost.totalCompletionTokens,
              totalCostUsd: sessionCost.totalCostUsd,
              totalRequests: sessionCost.requests.length,
              byModel: sessionCost.byModel,
            },
            requests: includeModel
              ? sessionCost.requests
              : sessionCost.requests.map(
                  ({ promptTokens, completionTokens, totalTokens, costUsd, timestamp }) => ({
                    promptTokens,
                    completionTokens,
                    totalTokens,
                    costUsd,
                    timestamp,
                  }),
                ),
          },
        };
      },
    });

    // Write cost data to session log on shutdown
    api.onEvent('session.ended', async () => {
      if (sessionCost.requests.length > 0) {
        try {
          await api.session?.append?.({
            type: 'cost-tracker:session_summary',
            ts: new Date().toISOString(),
            totalTokens: sessionCost.totalTokens,
            totalCostUsd: sessionCost.totalCostUsd,
            totalRequests: sessionCost.requests.length,
            byModel: sessionCost.byModel,
          });
        } catch {
          // session.append is best-effort.
        }
      }
    });

    api.log.info('cost-tracker plugin loaded', { version: '0.1.0' });
  },

  teardown(api) {
    // Mirror of the H1 pattern: clear module-scope state on unload so
    // the next setup() starts fresh and a reload cycle doesn't
    // accumulate stale overrides, registry snapshots, or last-cost
    // entries.
    const overrideCount = Object.keys(pricingOverrides).length;
    const registryCount = Object.keys(bundledFromRegistry).length;
    for (const k of Object.keys(pricingOverrides)) {
      delete pricingOverrides[k];
    }
    for (const k of Object.keys(bundledFromRegistry)) {
      delete bundledFromRegistry[k];
    }
    // Clear model key cache.
    modelKeyCache.clear();

    const finalLast = { ...lastCost };
    lastCost.usd = 0;
    lastCost.model = null;
    lastCost.at = null;
    digestCounters.totalRequests = 0;
    digestCounters.mailboxDigestsSent = 0;
    digestCounters.mailboxDigestErrors = 0;
    api.log.info('cost-tracker: teardown complete', {
      overrideCount,
      registryCount,
      lastModel: finalLast.model,
    });
  },

  async health() {
    // /diag plugins wants a quick yes/no plus context. We surface:
    //   - override count (so operators can confirm their pricingOverrides
    //     were applied without grepping config)
    //   - the last cost we recorded (so a fresh diag right after a
    //     request confirms the wiring is alive)
    // Note: session totals are *not* reported here — they live inside
    // the setup() closure (sessionCost) and are exposed via the
    // cost_summary tool instead. health() is module-scope only.
    return {
      ok: true,
      message:
        lastCost.model === null
          ? 'cost-tracker: no requests recorded yet this session'
          : `cost-tracker: last ${lastCost.model} cost=${lastCost.usd.toFixed(6)} at ${lastCost.at}`,
      overrideCount: Object.keys(pricingOverrides).length,
      registryCount: Object.keys(bundledFromRegistry).length,
      lastCostUsd: lastCost.usd,
      lastCostModel: lastCost.model,
      lastCostAt: lastCost.at,
      mailboxDigestsSent: digestCounters.mailboxDigestsSent,
      mailboxDigestErrors: digestCounters.mailboxDigestErrors,
      totalRequests: digestCounters.totalRequests,
    };
  },
};

export default plugin;
