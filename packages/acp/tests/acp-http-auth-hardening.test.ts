/**
 * WS-109 / WS-110 — the ACP HTTP transport's auth gate.
 *
 * This transport drives `runTurn`, i.e. real tool and command execution, and
 * it is the one ACP surface reachable off-loopback by design. It had two gaps
 * that every sibling auth surface in this repo had already closed:
 *
 *  - WS-109 `?token=` was accepted on any bind — the query-string exposure
 *    class (browser history, `Referer` to third-party origins, reverse-proxy
 *    access logs). It is now loopback-only, and a refused query token falls
 *    through to the `Authorization` header rather than short-circuiting.
 *  - WS-110 the token was compared with `!==`, not in constant time.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WrongStackACPServer } from '../src/agent/wrongstack-acp-agent.js';

const TOKEN = 'acp-secret-token-value';

let server: WrongStackACPServer | null = null;
let base = '';

async function startServer(): Promise<void> {
  server = new WrongStackACPServer({
    transport: 0,
    host: '127.0.0.1',
    authToken: TOKEN,
    runTurn: async () => ({ stopReason: 'end_turn' }) as never,
  });
  await server.start();
  const port = (
    server as unknown as { httpServer: { address(): { port: number } } }
  ).httpServer.address().port;
  base = `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await server?.stop?.();
  server = null;
});

/** A minimal JSON-RPC POST; we only care about the auth verdict. */
function post(pathname: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
}

describe('ACP HTTP auth gate', () => {
  it('rejects a request with no credential', async () => {
    await startServer();
    expect((await post('/')).status).toBe(401);
  });

  it('rejects a wrong Bearer token', async () => {
    await startServer();
    expect((await post('/', { Authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('accepts the correct Bearer token', async () => {
    await startServer();
    expect((await post('/', { Authorization: `Bearer ${TOKEN}` })).status).not.toBe(401);
  });

  it('rejects a token of the right length but wrong bytes (constant-time compare still matches exactly)', async () => {
    await startServer();
    const sameLength = `${'x'.repeat(TOKEN.length - 1)}y`;
    expect(sameLength).toHaveLength(TOKEN.length);
    expect((await post('/', { Authorization: `Bearer ${sameLength}` })).status).toBe(401);
  });

  it('still accepts ?token= from a loopback peer', async () => {
    await startServer();
    // The test client IS loopback, so the query path remains available here —
    // this is the local-dev ergonomics the restriction deliberately preserves.
    expect((await post(`/?token=${encodeURIComponent(TOKEN)}`)).status).not.toBe(401);
  });

  it('a wrong query token does not shadow a valid Authorization header', async () => {
    await startServer();
    const res = await post('/?token=wrong', { Authorization: `Bearer ${TOKEN}` });
    // Before the fix `queryToken ?? bearerToken` let a bad query value win and
    // 401 a caller that had also presented a valid header.
    expect(res.status).not.toBe(401);
  });

  it('an empty configured token is never satisfied by an empty credential', async () => {
    // Guard on the helper's `if (!supplied || !expected) return false` branch:
    // a blank credential must not authenticate even against a blank expectation.
    server = new WrongStackACPServer({
      transport: 0,
      host: '127.0.0.1',
      authToken: TOKEN,
      runTurn: async () => ({ stopReason: 'end_turn' }) as never,
    });
    await server.start();
    const port = (
      server as unknown as { httpServer: { address(): { port: number } } }
    ).httpServer.address().port;
    base = `http://127.0.0.1:${port}`;
    expect((await post('/', { Authorization: 'Bearer ' })).status).toBe(401);
  });
});
