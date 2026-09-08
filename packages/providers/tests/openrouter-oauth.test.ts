import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterAuthStrategy } from '../src/oauth/openrouter.js';

describe('OpenRouter OAuth strategy', () => {
  it('uses S256 PKCE and turns the authorization code into a saved API-key outcome', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        code: 'auth-code',
        code_challenge_method: 'S256',
      });
      expect(JSON.parse(String(init?.body)).code_verifier).toEqual(expect.any(String));
      return new Response(JSON.stringify({ key: 'sk-or-oauth' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const session = await createOpenRouterAuthStrategy(fetchImpl).begin();
    try {
      expect(session.interaction.type).toBe('browser');
      if (session.interaction.type !== 'browser') throw new Error('expected browser flow');
      const url = new URL(session.interaction.authorizeUrl);
      expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('callback_url')).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\//,
      );

      const result = await session.completeWithCode('auth-code');
      expect(result).toMatchObject({
        providerId: 'openrouter',
        family: 'openai-compatible',
        credential: { apiKey: 'sk-or-oauth', authMethod: 'oauth' },
      });
    } finally {
      session.close();
    }
  });

  it('rejects a successful response without a key', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}')) as typeof fetch;
    const session = await createOpenRouterAuthStrategy(fetchImpl).begin();
    try {
      await expect(session.completeWithCode('auth-code')).rejects.toThrow(/carries no API key/);
    } finally {
      session.close();
    }
  });
});
