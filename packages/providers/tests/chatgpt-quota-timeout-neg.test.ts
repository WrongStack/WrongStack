import { describe, expect, it } from 'vitest';
import { readChatGPTQuota } from '../src/chatgpt-account-quota.js';

describe('readChatGPTQuota timeout sanitization', () => {
  it('handles negative, zero, and non-finite timeoutMs without throwing', async () => {
    const host = {
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
      access: 'tok',
      accountId: 'acc',
      ensureFreshToken: async () => {},
      doRefresh: async () => {},
    };

    for (const timeoutMs of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await readChatGPTQuota.call(host, 'openai-codex', 'client-1', { timeoutMs });
      expect(result).toEqual([]);
    }
  });
});
