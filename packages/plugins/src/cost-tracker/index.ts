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
import type { Plugin } from '@wrongstack/contracts/types';
import { expectDefined } from '@wrongstack/core/utils';
import { readCostTrackerConfig } from './cost-config.js';
import {
  applyPricingOverrides,
  bundledFromRegistry,
  estimateCost,
  hydrateRegistryPricing,
  modelKeyCache,
  ownValue,
  pricingOverrides,
  setOwnValue,
} from './cost-pricing.js';
import { registerCostTools, type SessionCost, type TokenUsage } from './cost-session.js';

export type { ModelPricing } from './cost-pricing.js';

const API_VERSION = '^0.1.10';

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

/**
 * Provider usage is an untrusted response boundary. The old `Number(x) || 0`
 * guard drops `NaN` and non-numeric coercion but passes `±Infinity` (truthy),
 * which poisons the cumulative totals permanently (`Infinity + finite ===
 * Infinity`, `NaN` from `+Inf + -Inf`) and disables the budget-warning
 * comparison. Same invariant as token-budget / token-throttle: non-finite
 * numeric input at this boundary normalizes to 0.
 */
function toFiniteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
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
    applyPricingOverrides(rawConfig);

    // Hydrate `bundledFromRegistry` from the host's models registry (bounded
    // wait; see hydrateRegistryPricing). Guarded here so a host without a
    // registry keeps setup() free of any await.
    if (api.modelsRegistry) await hydrateRegistryPricing(api);

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
      const cachedTokens = toFiniteNumber(
        Number(u['cacheRead'] ?? u['cache_read_input_tokens'] ?? u['cached_prompt_tokens'] ?? 0),
      );
      const rawInput = toFiniteNumber(
        Number(u['input'] ?? u['prompt_tokens'] ?? u['inputTokens'] ?? u['promptTokens'] ?? 0),
      );
      const rawCacheWrite = toFiniteNumber(
        Number(u['cacheWrite'] ?? u['cache_creation_input_tokens'] ?? 0),
      );
      const freshTokens = rawInput + rawCacheWrite;
      const promptTokens = freshTokens + cachedTokens;
      const completionTokens = toFiniteNumber(
        Number(
          u['output'] ?? u['completion_tokens'] ?? u['outputTokens'] ?? u['completionTokens'] ?? 0,
        ),
      );
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

      if (!Object.hasOwn(sessionCost.byModel, model)) {
        setOwnValue(sessionCost.byModel, model, { tokens: 0, costUsd: 0, requests: 0 });
      }
      const slot = expectDefined(ownValue(sessionCost.byModel, model));
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

    registerCostTools(api, cfg, sessionCost);

    // Write cost data to session log on shutdown, then start the next
    // session from zero.
    //
    // `sessionCost` is per SESSION, but this plugin is set up once per
    // PROCESS and the host outlives any single session: the WebUI opens
    // additional sessions in the same process (`session.new`) and clears
    // context without reloading plugins. Nothing cleared these totals, so
    // `cost_summary` reported the sum of every session the process had ever
    // served while calling it "this session" — and the summary appended for
    // session N+1 included session N's spend. The `cost_reset` tool did
    // exactly this reset, but only when a user thought to ask for it.
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
      sessionCost.requests = [];
      sessionCost.totalPromptTokens = 0;
      sessionCost.totalCompletionTokens = 0;
      sessionCost.totalTokens = 0;
      sessionCost.totalCostUsd = 0;
      sessionCost.byModel = {};
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
