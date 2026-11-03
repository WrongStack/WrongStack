import { describe, expect, it } from 'vitest';
import { measureToolSchemas } from '../../src/utils/tool-schema-budget.js';

describe('provider schema budget', () => {
  const tool = {
    name: 'read',
    description: 'Read a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  };
  it('charges schemas actually sent to the provider, including input-schema growth', () => {
    const initial = measureToolSchemas([tool]);
    const expanded = measureToolSchemas([
      {
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          enum: Array.from({ length: 100 }, (_, i) => `choice_${i}`),
        },
      },
    ]);
    expect(expanded.wireBytes).toBeGreaterThan(initial.wireBytes);
    expect(expanded.estimatedTokens).toBeGreaterThan(initial.estimatedTokens);
    expect(measureToolSchemas([]).count).toBe(0);
  });
  it('does not charge host-only lifecycle and discovery metadata', () => {
    const enriched = {
      ...tool,
      usageHint: 'long help '.repeat(1000),
      aliases: ['old'],
      cost: { kind: 'paid' },
    };
    expect(measureToolSchemas([enriched])).toEqual(measureToolSchemas([tool]));
  });
});
