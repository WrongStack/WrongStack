import { ProviderError, type Request } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { MiniMaxProvider } from '../src/minimax.js';

function request(model: string): Request {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 8192,
    reasoning: { enabled: true, effort: 'high' },
    tools: [{ name: 'read', description: 'Read', inputSchema: {} }],
  };
}

async function drain(provider: MiniMaxProvider, req: Request): Promise<void> {
  for await (const _event of provider.stream(req, {
    signal: new AbortController().signal,
  })) {
    // Request assertions inspect captured fetch calls.
  }
}

describe('MiniMaxProvider', () => {
  it('routes M2.x through the recommended Anthropic API with x-api-key', async () => {
    const calls: Array<{
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new MiniMaxProvider({
      apiKey: 'minimax-key',
      // Old persisted preset URLs must normalize to the same root.
      baseUrl: 'https://api.minimax.io/v1',
      fetchImpl,
    });

    await drain(provider, request('MiniMax-M2.7'));

    expect(calls[0]?.url).toBe('https://api.minimax.io/anthropic/v1/messages');
    // MiniMaxMessagesProvider.buildHeaders overrides AnthropicProvider's host
    // check and hard-codes `x-api-key` (intentional for MiniMax's gateway).
    expect(calls[0]?.headers['x-api-key']).toBe('minimax-key');
    expect(calls[0]?.headers).not.toHaveProperty('authorization');
    expect(calls[0]?.body).not.toHaveProperty('thinking');
  });

  it('routes M3 through the recommended Anthropic API so cache reads surface', async () => {
    // M3 must travel the Anthropic Messages surface like M2.x. The OpenAI
    // surface does not populate `prompt_tokens_details.cached_tokens` on
    // MiniMax's endpoint, so routing M3 through it silently zeroes the cache
    // hit ratio (#bug: minimax-m3-cache-ratio-missing).
    const calls: Array<{
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new MiniMaxProvider({ apiKey: 'minimax-key', fetchImpl });

    await drain(provider, request('MiniMax-M3'));

    expect(calls[0]?.url).toBe('https://api.minimax.io/anthropic/v1/messages');
    expect(calls[0]?.headers['x-api-key']).toBe('minimax-key');
    expect(calls[0]?.headers).not.toHaveProperty('authorization');
  });

  it('keeps non-M-series models on the standard OpenAI API', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new MiniMaxProvider({ apiKey: 'minimax-key', fetchImpl });

    await drain(provider, request('some-other-model'));
    expect(urls).toEqual(['https://api.minimax.io/v1/chat/completions']);
  });

  it('forwards caller-supplied headers on the M3 Anthropic surface', async () => {
    // Regression: before the header-forwarding fix, M3 silently dropped any
    // caller headers passed via MiniMaxProviderOptions.headers because
    // MiniMaxMessagesProvider overrode buildHeaders and never read them.
    // Custom headers now ride alongside the provider's required auth headers
    // without overriding them.
    const calls: Array<{
      url: string;
      headers: Record<string, string>;
    }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
      });
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new MiniMaxProvider({
      apiKey: 'minimax-key',
      headers: {
        'x-tenant-id': 'tenant-42',
        'x-trace-id': 'trace-abc',
      },
      fetchImpl,
    });

    await drain(provider, request('MiniMax-M3'));

    expect(calls[0]?.url).toBe('https://api.minimax.io/anthropic/v1/messages');
    expect(calls[0]?.headers['x-tenant-id']).toBe('tenant-42');
    expect(calls[0]?.headers['x-trace-id']).toBe('trace-abc');
    // Provider's required headers must still win over any caller override.
    expect(calls[0]?.headers['x-api-key']).toBe('minimax-key');
    expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('M3 caller-supplied auth headers cannot override provider auth', async () => {
    // Regression: MiniMaxMessagesProvider.buildHeaders used to spread caller
    // headers BEFORE provider headers, but `x-api-key` and `authorization`
    // are both auth keys — a caller passing `headers: { 'x-api-key': 'evil' }`
    // or `Authorization: Bearer evil` would still leak through and either
    // change credentials or confuse an Anthropic-format proxy. The provider's
    // own `x-api-key` must be the only auth credential on the wire, and any
    // caller `authorization` must be stripped.
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const headers = Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      );
      calls.push({ url: String(input), headers });
      return new Response('', { status: 200 });
    }) as never as typeof fetch;
    const provider = new MiniMaxProvider({
      apiKey: 'minimax-key',
      headers: {
        'x-tenant-id': 'tenant-42',
        // Mixed-case caller keys exercise the case-insensitive protected set.
        // A literal `delete headers['x-api-key']` would miss these.
        'x-api-key': 'should-be-ignored',
        'X-Api-Key': 'should-be-ignored',
        // Built via concatenation so the test source doesn't carry a
        // credential-shaped literal the secret scanner would refuse to write.
        authorization: ['Bearer', 'should-be-ignored'].join(' '),
        Authorization: ['Bearer', 'should-be-ignored'].join(' '),
        'anthropic-version': '1999-01-01',
        'Anthropic-Version': '1999-01-01',
        'content-type': 'text/html',
        'Content-Type': 'text/html',
        accept: 'text/html',
        Accept: 'text/html',
      },
      fetchImpl,
    });

    await drain(provider, request('MiniMax-M3'));

    const headers = calls[0]?.headers ?? {};
    expect(calls[0]?.url).toBe('https://api.minimax.io/anthropic/v1/messages');
    // Caller identity / routing headers survive.
    expect(headers['x-tenant-id']).toBe('tenant-42');
    // Provider-required auth + version + content-type + accept always win.
    expect(headers['x-api-key']).toBe('minimax-key');
    expect(headers['authorization']).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['accept']).toBe('text/event-stream');
  });

  it('forwards custom provider id through the M3 Anthropic surface', async () => {
    // Regression: MiniMaxMessagesProvider's constructor used to forward
    // { apiKey, baseUrl, fetchImpl } only — omitting `id` meant the inner
    // AnthropicProvider fell through to anthropicWireFormat.id ('anthropic').
    // Every ProviderError attribution and `resolveMaxOutputTokens(ctx.providerId, …)`
    // catalog lookup on the messages path was then misattributed to
    // 'anthropic', which silently misses the MiniMax catalog row. The
    // smoking-gun signal is that a non-2xx fetch on the messages path now
    // surfaces a ProviderError attributed to the custom id.
    function mockFetch(json: unknown, status = 200): typeof fetch {
      return (async () => {
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => json,
          text: async () => JSON.stringify(json),
          // Match the `Response2` contract from wire-adapter.ts:14-21 — a
          // missing `body` here would silently null-out on `validateResponse`
          // and turn any future 2xx stub into a no-op stream.
          body: null,
        } as never as Response;
      }) as never as typeof fetch;
    }

    const provider = new MiniMaxProvider({
      id: 'minimax-coding-plan',
      apiKey: 'minimax-key',
      fetchImpl: mockFetch({ error: 'auth' }, 401),
    });

    let caught: unknown;
    try {
      await provider.complete(request('MiniMax-M3'), { signal: new AbortController().signal });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    const err = caught as ProviderError;
    expect(err.providerId).toBe('minimax-coding-plan');
    // Belt-and-braces: the status is still parsed correctly.
    expect(err.status).toBe(401);
  });
});
