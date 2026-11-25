import { describe, expect, it } from 'vitest';
import { registerCostTools } from '../src/cost-tracker/cost-session.js';

describe('cost_summary non-finite cost guard', () => {
  it('sanitizes non-finite totalCostUsd so summary fields never emit NaN', async () => {
    let summaryTool: { execute: () => Promise<Record<string, unknown>> } | undefined;
    registerCostTools(
      {
        tools: {
          register: (tool: { name: string; execute: () => Promise<Record<string, unknown>> }) => {
            if (tool.name === 'cost_summary') summaryTool = tool;
          },
        },
      } as never,
      {
        budgetLimit: 10,
        warningThreshold: 80,
        mailboxDigestEveryN: 0,
        mailboxDigestTo: 'cost-tracker',
      },
      {
        requests: [],
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        totalCostUsd: Number.NaN,
        byModel: {},
      },
    );

    const out = await summaryTool!.execute();
    const usage = out.usage as { totalCostUsd: number };
    const budgetStatus = out.budgetStatus as { percentUsed: number; spent: number };
    expect(usage.totalCostUsd).toBe(0);
    expect(budgetStatus.spent).toBe(0);
    expect(budgetStatus.percentUsed).toBe(0);
  });
});
