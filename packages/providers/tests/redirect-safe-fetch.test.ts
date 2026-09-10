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

  it('strips payload headers (content-type, content-length, etc.) on POST to GET downgrade', async () => {
    const calls: Array<{ method?: string; headers: Record<string, string>; body?: string }> = [];
    const impl = vi.fn(async (_url: string, init: any) => {
      calls.push({ method: init.method, headers: { ...init.headers }, body: init.body });
      return calls.length === 1 ? response(303, 'https://api.example/done') : response(200);
    });

    await redirectSafeFetch(impl as unknown as typeof fetch, 'https://api.example/v1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '25',
        'content-encoding': 'gzip',
        'content-language': 'en',
        'content-location': '/v1',
        'content-range': 'bytes 0-24/25',
        'x-request-id': 'keep-me',
      },
      body: '{"message":"hello world"}',
    });

    expect(calls).toHaveLength(2);
    const hop2 = calls[1]!;
    expect(hop2.method).toBe('GET');
    expect(hop2.body).toBeUndefined();
    expect(hop2.headers['content-type']).toBeUndefined();
    expect(hop2.headers['content-length']).toBeUndefined();
    expect(hop2.headers['content-encoding']).toBeUndefined();
    expect(hop2.headers['content-language']).toBeUndefined();
    expect(hop2.headers['content-location']).toBeUndefined();
    expect(hop2.headers['content-range']).toBeUndefined();
    expect(hop2.headers['x-request-id']).toBe('keep-me');
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

  // Regression for J2 (NEW-02): the previous redirect loop only
  // checked the protocol of the redirect target — a provider
  // endpoint that 302s to `http://169.254.169.254/…` (AWS IMDS) or
  // to any loopback service was followed and the redirected
  // request went out with the same headers. The fix rejects
  // literal-IP redirect targets that classify as private/loopback.
  it('rejects a redirect to a literal loopback IP', async () => {
    const impl = vi.fn(async () => response(307, 'http://127.0.0.1:8080/internal'));
    await expect(
      redirectSafeFetch(impl as unknown as typeof fetch, 'https://api.example/v1', {
        headers: { 'x-api-key': 'secret' },
      }),
    ).rejects.toThrow(/private\/loopback/);
  });

  it('rejects a redirect to a literal link-local metadata IP (169.254.169.254)', async () => {
    const impl = vi.fn(async () => response(302, 'http://169.254.169.254/latest/meta-data/'));
    await expect(
      redirectSafeFetch(impl as unknown as typeof fetch, 'https://api.example/v1', {
        headers: { 'x-api-key': 'secret' },
      }),
    ).rejects.toThrow(/private\/loopback/);
  });

  /**
   * Every one of these walked straight through.
   *
   * `URL.hostname` keeps the brackets on an IPv6 literal, and the guard tested
   * the host against `/^[0-9.:]+$/` — a pattern that cannot match a string
   * starting with `[`. So the check applied to IPv4 literals only, and the
   * entire v6 family, loopback and metadata included, was unguarded. Both
   * sibling guards in this repo (`core/utils/ip-guard.ts`,
   * `mcp/transport-security.ts`) unbracket correctly; this one did not.
   */
  describe('IPv6 literal redirect targets (bracket bypass)', () => {
    it.each([
      ['loopback', 'http://[::1]:8080/internal'],
      ['link-local', 'http://[fe80::1]/'],
      ['unique-local', 'http://[fd12:3456::1]/'],
      ['AWS IPv6 metadata endpoint', 'http://[fd00:ec2::254]/latest/meta-data/'],
      ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/internal'],
    ])('rejects a redirect to an IPv6 %s literal', async (_label, target) => {
      const impl = vi.fn(async () => response(307, target));
      await expect(
        redirectSafeFetch(impl as unknown as typeof fetch, 'https://api.example/v1', {
          headers: { 'x-api-key': 'secret' },
        }),
      ).rejects.toThrow(/private\/loopback/);
    });

    it('still allows a public IPv6 literal', async () => {
      // The fix must not turn every v6 literal into a block: that would be a
      // silent outage for anyone whose gateway redirects to one.
      const impl = vi.fn(async (_url: string) =>
        _url === 'https://api.example/v1'
          ? response(307, 'http://[2606:4700:4700::1111]/v2')
          : response(200),
      );
      const res = await redirectSafeFetch(
        impl as unknown as typeof fetch,
        'https://api.example/v1',
        { headers: { 'x-api-key': 'secret' } },
      );
      expect(res.status).toBe(200);
    });

    it('still allows an ordinary hostname', async () => {
      // `isPrivateIPv6` returns true for anything that fails v6 expansion, so
      // a naive unbracket-and-check would classify every hostname as private.
      const impl = vi.fn(async (_url: string) =>
        _url === 'https://api.example/v1' ? response(307, 'https://cdn.example.net/v2') : response(200),
      );
      const res = await redirectSafeFetch(
        impl as unknown as typeof fetch,
        'https://api.example/v1',
        { headers: { 'x-api-key': 'secret' } },
      );
      expect(res.status).toBe(200);
    });
  });
});
