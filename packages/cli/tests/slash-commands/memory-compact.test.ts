import { describe, expect, it } from 'vitest';
import type { SlashCommandContext } from '../../src/slash-commands/command-context.js';
import { runCompact } from '../../src/slash-commands/memory-compact.js';

describe('runCompact', () => {
  it('preserves literal $& and $$ sequences in memory entries when building the compact prompt', async () => {
    let capturedSystem = '';
    const literalDollar = 'check regex $& and $$ in shell';
    const ctx = {
      memoryStore: {
        getCapability: () => undefined,
        list: async () => ['entry-1'],
        read: async () => `- [2026-11-01T00:00:00Z] mem_1730419200_abcd ${literalDollar}`,
      },
      llmProvider: {
        complete: async (req: { system?: Array<{ type: string; text: string }> }) => {
          capturedSystem = req.system?.[0]?.text ?? '';
          return {
            content: [{ type: 'text', text: '{"operations":[],"summary":"noop"}' }],
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: 'end_turn',
          };
        },
      },
      llmModel: 'test-model',
    } as unknown as SlashCommandContext;

    await runCompact(ctx);
    expect(capturedSystem).toContain(literalDollar);
  });
});
