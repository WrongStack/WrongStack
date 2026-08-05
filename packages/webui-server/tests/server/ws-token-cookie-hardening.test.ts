/**
 * WS-107 / WS-108 — the WebUI auth cookie and the HTTP token sources.
 *
 * Both are lessons the HQ server already learned and this one had not:
 *  - WS-107 the `ws_token` cookie was never `Secure`, even on the tunnel
 *    deployments this server explicitly supports.
 *  - WS-108 `?token=` was accepted on every route regardless of bind, which is
 *    the query-string exposure class (C-598) the WS path had already closed.
 */
import type * as http from 'node:http';
import * as os from 'node:os';
import * as nodeFs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHttpServer, requestToken } from '../../src/server/http-server.js';
import { extractTokenFromCookie } from '../../src/server/ws-auth.js';

function req(opts: {
  remoteAddress?: string | undefined;
  cookie?: string | undefined;
  header?: string | undefined;
}): http.IncomingMessage {
  return {
    socket: { remoteAddress: opts.remoteAddress },
    headers: {
      ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
      ...(opts.header !== undefined ? { 'x-ws-token': opts.header } : {}),
    },
  } as unknown as http.IncomingMessage;
}

const url = (search = ''): URL => new URL(`http://example.test/api/sessions${search}`);

describe('WS-108 — query token is loopback-only', () => {
  it('accepts ?token= from a loopback peer (the local dev flow)', () => {
    expect(requestToken(req({ remoteAddress: '127.0.0.1' }), url('?token=abc'))).toBe('abc');
    expect(requestToken(req({ remoteAddress: '::1' }), url('?token=abc'))).toBe('abc');
    expect(requestToken(req({ remoteAddress: '::ffff:127.0.0.1' }), url('?token=abc'))).toBe('abc');
  });

  it('refuses ?token= from a remote peer — it leaks via proxy logs and Referer', () => {
    expect(requestToken(req({ remoteAddress: '203.0.113.9' }), url('?token=abc'))).toBeUndefined();
  });

  it('falls through to the header rather than returning early when the query is refused', () => {
    expect(
      requestToken(req({ remoteAddress: '203.0.113.9', header: 'hdr' }), url('?token=abc')),
    ).toBe('hdr');
  });

  it('falls through to the cookie when the query is refused', () => {
    expect(
      requestToken(req({ remoteAddress: '203.0.113.9', cookie: 'ws_token=ck' }), url('?token=abc')),
    ).toBe('ck');
  });

  it('allowQuery re-enables the query source for /ws-auth and the page load', () => {
    expect(
      requestToken(req({ remoteAddress: '203.0.113.9' }), url('?token=abc'), { allowQuery: true }),
    ).toBe('abc');
  });

  it('header and cookie remain available with no query at all', () => {
    expect(requestToken(req({ remoteAddress: '203.0.113.9', header: 'hdr' }), url())).toBe('hdr');
    expect(requestToken(req({ remoteAddress: '203.0.113.9', cookie: 'ws_token=ck' }), url())).toBe(
      'ck',
    );
  });
});

describe('WS-107 — __Host- prefixed cookie wins', () => {
  it('prefers __Host-ws_token over an injected plain ws_token', () => {
    expect(extractTokenFromCookie('ws_token=injected; __Host-ws_token=genuine')).toBe('genuine');
    expect(extractTokenFromCookie('__Host-ws_token=genuine; ws_token=injected')).toBe('genuine');
  });

  it('still reads the plain name on a loopback HTTP deployment', () => {
    expect(extractTokenFromCookie('ws_token=loopback')).toBe('loopback');
  });

  it('decodes percent-encoding and ignores unrelated cookies', () => {
    expect(extractTokenFromCookie('other=1; ws_token=a%2Bb; another=2')).toBe('a+b');
  });

  it('returns undefined when neither cookie is present', () => {
    expect(extractTokenFromCookie('other=1')).toBeUndefined();
    expect(extractTokenFromCookie(undefined)).toBeUndefined();
  });
});

describe('WS-107 — Set-Cookie flags follow the deployment', () => {
  const TOKEN = 'cookie-flag-token';

  async function withServer(
    opts: { publicWsUrl?: string; secureCookies?: boolean },
    run: (base: string) => Promise<void>,
  ): Promise<void> {
    const distDir = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), 'wsc-dist-'));
    await nodeFs.writeFile(nodePath.join(distDir, 'index.html'), '<!doctype html><title>t</title>');
    const server = createHttpServer({ host: '127.0.0.1', distDir, apiToken: TOKEN, ...opts });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('bad listen address');
    try {
      await run(`http://127.0.0.1:${addr.port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await nodeFs.rm(distDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  }

  const wsAuthCookie = async (base: string): Promise<string> => {
    const res = await fetch(`${base}/ws-auth?token=${encodeURIComponent(TOKEN)}`);
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie') ?? '';
  };

  it('plain HTTP loopback keeps the unprefixed, non-Secure cookie', async () => {
    await withServer({}, async (base) => {
      const cookie = await wsAuthCookie(base);
      expect(cookie).toContain('ws_token=');
      expect(cookie).not.toContain('__Host-');
      // A Secure cookie would simply never be sent back over plain HTTP.
      expect(cookie).not.toMatch(/;\s*Secure/i);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
    });
  });

  it('infers Secure + __Host- from a wss:// public URL (tunnel deployment)', async () => {
    await withServer({ publicWsUrl: 'wss://relay.example.test/ws' }, async (base) => {
      const cookie = await wsAuthCookie(base);
      expect(cookie).toContain('__Host-ws_token=');
      expect(cookie).toMatch(/;\s*Secure/i);
      expect(cookie).toContain('Path=/');
      expect(cookie).not.toMatch(/Domain=/i);
    });
  });

  it('a ws:// public URL does not imply TLS', async () => {
    await withServer({ publicWsUrl: 'ws://relay.example.test/ws' }, async (base) => {
      expect(await wsAuthCookie(base)).not.toMatch(/;\s*Secure/i);
    });
  });

  it('an explicit secureCookies flag overrides the inference', async () => {
    await withServer({ secureCookies: true }, async (base) => {
      const cookie = await wsAuthCookie(base);
      expect(cookie).toContain('__Host-ws_token=');
      expect(cookie).toMatch(/;\s*Secure/i);
    });
    await withServer(
      { publicWsUrl: 'wss://relay.example.test/ws', secureCookies: false },
      async (base) => {
        expect(await wsAuthCookie(base)).not.toMatch(/;\s*Secure/i);
      },
    );
  });

  it('the hardened cookie still authenticates an ordinary API call', async () => {
    await withServer({ publicWsUrl: 'wss://relay.example.test/ws' }, async (base) => {
      const cookie = await wsAuthCookie(base);
      const jar = cookie.split(';')[0] ?? '';
      const api = await fetch(`${base}/api/sessions`, { headers: { cookie: jar } });
      expect(api.status).not.toBe(401);
    });
  });
});
