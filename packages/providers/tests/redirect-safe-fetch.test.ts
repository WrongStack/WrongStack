/**
 * WS-084 — provider credentials must not survive a cross-origin redirect.
 *
 * `fetch` defaults to `redirect: 'follow'` and strips only Authorization,
 * Cookie, and Proxy-Authorization when the origin changes. This codebase
 * authenticates with `x-api-key`, `x-goog-api-key`, and arbitrary gateway
 * headers — none of which are on that list — so a 307 replayed the user's API
 * key to whatever host the redirect named.
 */
import { describe, expect, it, vi } from 'vitest';
import { redirectSafeFetch } from '../src/redirect-safe-fetch.js';

function response(status: number, location?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => (name.toLowerCase() === 'location' ? location : undefined) },
    text: async () => '',
  } as unknown as Response;
}

describe('redirectSafeFetch', () => {
  it('returns a non-redirect response untouched', async () => {
    const impl = vi.fn(async () => response(200));
    const res = await redirectSafeFetch(impl as unknown as typeof fetch, 'https://api.example/v1', {
      headers: { 'x-api-key': 'secret' },
    });
    expect(res.status).toBe(200);
    expect(impl).toHaveBeenCalledOnce();
  });

  it('keeps credentials on a SAME-origin redirect', async () => {
    const calls: Record<string, string>[] = [];
    const impl = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers);
      return calls.length === 1 ? response(307, 'https://api.example/v2') : response(200);
    });

    await redirectSafeFetch(impl as unknown as typeof fetch, 'https://api.example/v1', {
      method: 'POST',
      headers: { 'x-api-key': 'secret', 'content-type': 'application/json' },
      body: '{}',
    });

    expect(calls[1]?.['x-api-key']).toBe('secret');
  });

  it('strips x-api-key on a CROSS-origin redirect', async () => {
    const calls: Record<string, string>[] = [];
    const impl = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers);
      return calls.length === 1 ? response(307, 'https://evil.example/collect') : response(200);
    });

    await redirectSafeFetch(impl as unknown as typeof fetch, 'https://api.example/v1', {
      method: 'POST',
      headers: { 'x-api-key': 'secret', 'content-type': 'application/json' },
      body: '{}',
    });

    expect(calls[1]).not.toHaveProperty('x-api-key');
    // Non-credential headers still travel — this is a credential guard, not a
    // reason to break content negotiation.
    expect(calls[1]?.['content-type']).toBe('application/json');
  });

  it('strips x-goog-api-key, Authorization, and custom gateway keys alike', async () => {
    const calls: Record<string, string>[] = [];
    const impl = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers);
      return calls.length === 1 ? response(302, 'https://elsewhere.example/x') : response(200);
    });

    await redirectSafeFetch(impl as unknown as typeof fetch, 'https://api.example/v1', {
      method: 'GET',
      headers: {
        'x-goog-api-key': 'g',
        authorization: 'Bearer b',
        'x-gateway-token': 't',
        'openrouter-api-key': 'o',
        accept: 'application/json',
      },
    });

    expect(Object.keys(calls[1] ?? {})).toEqual(['accept']);
  });

  it('downgrades POST to GET on 303, as fetch does', async () => {
    const methods: (string | undefined)[] = [];
    const impl = vi.fn(async (_url: string, init: { method?: string }) => {
      methods.push(init.method);
      return methods.length === 1 ? response(303, 'https://api.example/done') : response(200);
    });

    await redirectSafeFetch(impl as unknown as typeof fetch, 'https://api.example/v1', {
      method: 'POST',
      headers: {},
      body: '{}',
    });

    expect(methods).toEqual(['POST', 'GET']);
  });

  it('resolves a relative Location against the current URL', async () => {
    const urls: string[] = [];
    const impl = vi.fn(async (url: string) => {
      urls.push(url);
      return urls.length === 1 ? response(307, '/v2/messages') : response(200);
    });

    await redirectSafeFetch(impl as unknown as typeof fetch, 'https://api.example/v1/messages', {
      headers: {},
    });

    expect(urls[1]).toBe('https://api.example/v2/messages');
  });

  it('gives up rather than looping forever', async () => {
    const impl = vi.fn(async () => response(307, 'https://api.example/loop'));
    await expect(
      redirectSafeFetch(impl as unknown as typeof fetch, 'https://api.example/loop', {
        headers: {},
      }),
    ).rejects.toThrow(/Too many redirects/);
  });

  it('tolerates a fake fetch that ignores redirect:manual', async () => {
    // Injected test doubles routinely return a plain response; the wrapper must
    // not require redirect support to work.
    const impl = vi.fn(async () => ({ status: 200, ok: true }) as unknown as Response);
    const res = await redirectSafeFetch(impl as unknown as typeof fetch, 'https://api.example/v1', {
      headers: {},
    });
    expect(res.ok).toBe(true);
  });
});
