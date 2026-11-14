import { describe, expect, it } from 'vitest';
import { startMcpOAuthCallbackServer } from '../src/authorization-callback-server.js';

async function get(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}

describe('startMcpOAuthCallbackServer', () => {
  it('binds loopback and resolves with the full callback URL', async () => {
    const listener = await startMcpOAuthCallbackServer();
    try {
      expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      const pending = listener.waitForCallback();
      const response = await get(`${listener.redirectUri}?code=abc&state=xyz`);
      expect(response.status).toBe(200);

      const callbackUrl = await pending;
      const parsed = new URL(callbackUrl);
      expect(parsed.hostname).toBe('127.0.0.1');
      expect(parsed.pathname).toBe('/callback');
      expect(parsed.searchParams.get('code')).toBe('abc');
      expect(parsed.searchParams.get('state')).toBe('xyz');
    } finally {
      listener.close();
    }
  });

  it('answers only its own path', async () => {
    const listener = await startMcpOAuthCallbackServer();
    try {
      const base = new URL(listener.redirectUri).origin;
      expect((await get(`${base}/favicon.ico`)).status).toBe(404);
      expect((await get(`${base}/`)).status).toBe(404);
    } finally {
      listener.close();
    }
  });

  it('gives up when no redirect arrives', async () => {
    const listener = await startMcpOAuthCallbackServer({ timeoutMs: 20 });
    await expect(listener.waitForCallback()).rejects.toThrow(/not received within/);
  });

  it('stops waiting when the caller aborts', async () => {
    const controller = new AbortController();
    const listener = await startMcpOAuthCallbackServer({ signal: controller.signal });
    const pending = listener.waitForCallback();
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('refuses a callback path that carries a query of its own', async () => {
    await expect(startMcpOAuthCallbackServer({ path: '/cb?x=1' })).rejects.toThrow(
      /absolute path without query/,
    );
  });

  it('chunks timeouts above 2^31-1 ms and returns 400 for malformed request URLs', async () => {
    const { request: httpRequest } = await import('node:http');
    const listener = await startMcpOAuthCallbackServer({ timeoutMs: 2_147_483_648 });
    let earlyTimeout = false;
    listener.waitForCallback().catch(() => {
      earlyTimeout = true;
    });
    try {
      await new Promise((r) => setTimeout(r, 30));
      expect(earlyTimeout).toBe(false);

      const port = Number(new URL(listener.redirectUri).port);
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: 'http://[invalid', method: 'GET' },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(400);
    } finally {
      listener.close();
    }
  });
});
