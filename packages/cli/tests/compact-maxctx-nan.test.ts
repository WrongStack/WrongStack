import { describe, expect, it } from 'vitest';
import { buildCompactCommand } from '../src/slash-commands/compact.js';

describe('compact command effectiveMaxContext validation', () => {
  it('falls back to provider maxContext when effectiveMaxContext meta is NaN', async () => {
    const cmd = buildCompactCommand({
      renderer: { writeWarning: () => {}, writeInfo: () => {} },
      compactor: {
        compact: async () => ({
          before: 1000,
          after: 500,
          fullRequestTokensAfter: 500,
          reductions: [],
        }),
      },
    } as never);

    const res = await cmd.run('', {
      meta: { effectiveMaxContext: Number.NaN },
      provider: { capabilities: { maxContext: 1000 } },
      messages: [],
    } as never);
    expect(res && res.message).toContain('50%');
  });
});
