import type { PluginAPI } from '@wrongstack/contracts/types';
import type { CostTrackerConfig } from './cost-config.js';

// ---------------------------------------------------------------------------
// Per-session usage ledger and the tools that read/reset/export it.
// ---------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  timestamp: string;
  costUsd?: number | undefined;
}

export interface SessionCost {
  requests: TokenUsage[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  byModel: Record<string, { tokens: number; costUsd: number; requests: number }>;
}

/**
 * Register `cost_summary`, `cost_reset` and `cost_export` over the session
 * ledger the plugin's `setup()` owns.
 */
export function registerCostTools(
  api: PluginAPI,
  cfg: CostTrackerConfig,
  sessionCost: SessionCost,
): void {
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
}
