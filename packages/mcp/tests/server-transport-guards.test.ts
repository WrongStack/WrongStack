/**
 * WS-024 / WS-026 — the MCP HTTP transport and the `tools/call` contract.
 *
 * `serveHttp` binds a loopback port that executes tools. Any page in the
 * user's browser can reach a loopback port, so the transport needs the same
 * guards a local control-plane needs — and it had none of them:
 *
 *   - `GET` on any path answered 200 with the server identity BEFORE the token
 *     check, so an unauthenticated caller could fingerprint the server.
 *   - No `Origin` check, so a foreign page's request was indistinguishable
 *     from a local client's.
 *   - No `Host` check, so a DNS-rebinding name pointing at 127.0.0.1 made a
 *     foreign page same-origin.
 *   - No `Content-Type` requirement, so a POST could be a CORS *simple*
 *     request — no preflight, nothing to refuse — and drive tool execution.
 *   - `auth !== expected`, a short-circuiting compare that leaks the token
 *     prefix to a caller that can time responses.
 *
 * WS-026: `tools/call` forwarded `arguments` to the host after checking only
 * that it was an object, so every `enum`, `required`, and bound in the
 * `inputSchema` this server publishes on `tools/list` was advisory. Enforcement
 * now runs through the shared `validateAgainstSchema`, which covers
 * type/enum/required but NOT `additionalProperties` or bounds — a boundary the
 * WS-026 block below pins explicitly rather than leaving to assumption.
 */
import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MCPServer,
  type MCPServerCallResult,
  type MCPServerTool,
  type ServeHttpHandle,
  serveHttp,
} from '../src/server.js';

const TOOL: MCPServerTool = {
  name: 'write_note',
  description: 'test tool',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['read', 'write'] },
      count: { type: 'number', minimum: 1, maximum: 10 },
      path: { type: 'string' },
    },
    required: ['mode', 'path'],
    additionalProperties: false,
  },
};

let received: Array<Record<string, unknown>> = [];
let handle: ServeHttpHandle | undefined;

function makeServer(): MCPServer {
  received = [];
  return new MCPServer({
    host: {
      listTools: () => [TOOL],
      callTool: (_name, args): Promise<MCPServerCallResult> => {
        received.push(args);
        return Promise.resolve({ content: 'ok', isError: false });
      },
    },
  });
}

async function start(token?: string): Promise<ServeHttpHandle> {
  handle = await serveHttp(makeServer(), { port: 0, ...(token ? { token } : {}) });
  return handle;
}

function callBody(args: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'write_note', arguments: args },
  });
}

const VALID = { mode: 'read', path: 'a.txt' };

/** POST with an explicit Host header, which `fetch` will not let us set. */
function rawPost(h: ServeHttpHandle, hostHeader: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: h.port,
        path: '/',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: hostHeader,
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe('MCP HTTP transport guards (WS-024)', () => {
  it('refuses a foreign browser Origin', async () => {
    const h = await start();
    const res = await fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: callBody(VALID),
    });
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it('accepts a same-origin loopback Origin', async () => {
    const h = await start();
    const res = await fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: h.url.replace(/\/$/, '') },
      body: callBody(VALID),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it('accepts a request with no Origin — non-browser clients never send one', async () => {
    const h = await start();
    const res = await fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: callBody(VALID),
    });
    expect(res.status).toBe(200);
  });

  it('refuses a rebound Host header', async () => {
    // `fetch` refuses to set Host (undici forbids it), so this goes through
    // the raw client — which is what a rebinding attacker's browser does
    // anyway: the browser sets Host from the name it resolved.
    const h = await start();
    const status = await rawPost(h, 'evil.example', callBody(VALID));
    expect(status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it('accepts a loopback Host header', async () => {
    const h = await start();
    const status = await rawPost(h, `127.0.0.1:${h.port}`, callBody(VALID));
    expect(status).toBe(200);
  });

  it('refuses a simple-request POST that carries no JSON content type', async () => {
    // `text/plain` is CORS-simple: no preflight, so nothing would have refused
    // it. This is the drive-by tool execution path.
    const h = await start();
    const res = await fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: callBody(VALID),
    });
    expect(res.status).toBe(415);
    expect(received).toHaveLength(0);
  });

  it('accepts application/json with parameters', async () => {
    const h = await start();
    const res = await fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: callBody(VALID),
    });
    expect(res.status).toBe(200);
  });

  it('requires the token on GET, not only on POST', async () => {
    const h = await start('s3cret');
    const anonymous = await fetch(h.url);
    expect(anonymous.status).toBe(401);

    const authorized = await fetch(h.url, { headers: { authorization: 'Bearer s3cret' } });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({ status: 'ok' });
  });

  it('refuses a token of the right length but wrong bytes', async () => {
    const h = await start('s3cret');
    const res = await fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer s3crea' },
      body: callBody(VALID),
    });
    expect(res.status).toBe(401);
  });

  it('never emits CORS headers a cross-origin reader could use', async () => {
    const h = await start();
    const res = await fetch(h.url);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('MCP tools/call schema enforcement (WS-026)', () => {
  async function call(args: Record<string, unknown>): Promise<{
    status: number;
    body: { error?: { code: number; message: string }; result?: unknown };
  }> {
    const h = handle ?? (await start());
    const res = await fetch(h.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: callBody(args),
    });
    return { status: res.status, body: (await res.json()) as never };
  }

  it('rejects a value outside a declared enum', async () => {
    const { body } = await call({ mode: '../../etc/passwd', path: 'a.txt' });
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toContain('mode');
    expect(received).toHaveLength(0);
  });

  it('rejects a missing required property', async () => {
    const { body } = await call({ mode: 'read' });
    expect(body.error?.code).toBe(-32602);
    expect(received).toHaveLength(0);
  });

  // SCOPE, pinned deliberately: the shared `validateAgainstSchema` — which
  // also gates the agent's own tool executor — checks type/enum/required and
  // nothing else. `additionalProperties: false` and numeric bounds therefore
  // remain advisory. Teaching the shared validator about them changes what the
  // agent accepts on EVERY tool call in the product, so it is a separate
  // decision, not a rider on a transport fix. These two tests exist so that
  // gap is a stated fact rather than an assumption someone has to rediscover.
  it('does NOT yet enforce additionalProperties: false', async () => {
    const { body } = await call({ ...VALID, injected: 'yes' });
    expect(body.error).toBeUndefined();
  });

  it('does NOT yet enforce numeric bounds', async () => {
    const { body } = await call({ ...VALID, count: 999 });
    expect(body.error).toBeUndefined();
  });

  it('rejects a wrong type, which the shared validator does check', async () => {
    const { body } = await call({ ...VALID, count: 'not-a-number' });
    expect(body.error?.code).toBe(-32602);
    expect(received).toHaveLength(0);
  });

  it('passes valid arguments straight through', async () => {
    const { body } = await call(VALID);
    expect(body.error).toBeUndefined();
    expect(received).toEqual([VALID]);
  });

  it('uses -32602 Invalid params, not the generic internal-error code', async () => {
    // Clients back off differently on an internal error than on bad input;
    // reporting -32603 would make a caller retry an argument that can never
    // succeed.
    const { body } = await call({ mode: 'nope', path: 'a.txt' });
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.code).not.toBe(-32603);
  });
});
