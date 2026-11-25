import { describe, expect, it } from 'vitest';
import { runOptionalPluginLlm } from '../src/runtime/llm.js';

describe('runOptionalPluginLlm null-prototype rejection handling', () => {
  it('falls back cleanly instead of throwing when provider rejects with a null-prototype object', async () => {
    const res = await runOptionalPluginLlm({
      requested: true,
      prompt: 'hi',
      parse: () => null,
      label: 'test',
      api: {
        llm: {
          complete: async () => {
            throw Object.create(null);
          },
        } as never,
        log: { warn: () => {} } as never,
      },
    });
    expect(res).toEqual({ used: false, value: null, fallbackReason: 'provider-error' });
  });
});
