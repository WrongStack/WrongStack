import type { PluginAPI } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { registerCostTools, type SessionCost } from '../src/cost-tracker/cost-session.js';

describe('cost_export CSV field escaping', () => {
  it('escapes commas, quotes, and newlines in exported model names', async () => {
    const tools = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    const api = {
      tools: {
        register(def: {
          name: string;
          execute: (input: Record<string, unknown>) => Promise<unknown>;
        }) {
          tools.set(def.name, def.execute);
        },
      },
    } as unknown as PluginAPI;

    const sessionCost: SessionCost = {
      requests: [
        {
          model: 'acme,v2 "pro"\ninjected',
          timestamp: '2026-01-01T00:01:00Z',
          promptTokens: 20,
          completionTokens: 10,
          totalTokens: 30,
          costUsd: 0.02,
        },
      ],
      totalPromptTokens: 20,
      totalCompletionTokens: 10,
      totalTokens: 30,
      totalCostUsd: 0.02,
      byModel: {},
    };
    registerCostTools(
      api,
      { budgetLimit: 0, warningThreshold: 80, mailboxDigestEveryN: 0, mailboxDigestTo: 'x' },
      sessionCost,
    );
    const res = (await tools.get('cost_export')!({ format: 'csv' })) as { data: string };
    expect(res.data).toContain('"acme,v2 ""pro""\ninjected"');
  });
});
