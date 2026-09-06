import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WrongStackACPServer,
  wrongStackACPServerCoverage,
} from '../src/agent/wrongstack-acp-agent.js';

const servers: WrongStackACPServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

async function startServer(options: ConstructorParameters<typeof WrongStackACPServer>[0] = {}) {
  const server = new WrongStackACPServer({ transport: 0, authToken: 'secret', ...options });
  servers.push(server);
  await server.start();
  const address = (
    server as unknown as {
      httpServer: { address(): { port: number } };
    }
  ).httpServer.address();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

describe('WrongStackACPServer HTTP transport coverage', () => {
  it('enforces authentication, origin, preflight, and HTTP methods', async () => {
    const { base } = await startServer();

    const unauthorized = await fetch(base, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ error: { message: 'Unauthorized' } });

    const forbidden = await fetch(`${base}?token=secret`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: '{}',
    });
    expect(forbidden.status).toBe(403);

    const preflight = await fetch(base, {
      method: 'OPTIONS',
      headers: {
        Authorization: 'Bearer secret',
        Origin: 'http://127.0.0.1:0',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:0');

    const method = await fetch(base, {
      method: 'GET',
      headers: { Authorization: 'Bearer secret' },
    });
    expect(method.status).toBe(405);
  });

  it('handles parse errors, notifications, and regular JSON-RPC requests', async () => {
    const { base } = await startServer({ host: '127.0.0.1' });
    const headers = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };

    const malformed = await fetch(base, { method: 'POST', headers, body: '{' });
    expect(malformed.status).toBe(400);

    const notification = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: {} }),
    });
    expect(notification.status).toBe(200);
    expect(await notification.json()).toEqual({ notifications: [] });

    const initialized = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({ id: 1, notifications: [] });

    const unknown = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'unknown/method', params: {} }),
    });
    expect(await unknown.json()).toMatchObject({ id: 2, error: expect.any(Object) });
  });

  it('rejects request bodies larger than the transport limit', async () => {
    const { base } = await startServer();
    const result = await rawRequest(base, Buffer.alloc(10 * 1024 * 1024 + 1, 32));
    expect(result.status).toBe(413);
  });

  it('streams turn updates, uses the default turn, and captures non-response messages', async () => {
    const { base } = await startServer({
      authToken: undefined,
      runTurn: async (_input, emit) => {
        await emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
        return { stopReason: 'end_turn' };
      },
    });
    const headers = { 'Content-Type': 'application/json' };
    const initialized = await post(base, headers, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    expect(initialized.id).toBe(1);
    const created = await post(base, headers, {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: process.cwd() },
    });
    const sessionId = (created.result as { sessionId: string }).sessionId;
    const prompted = await post(base, headers, {
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
    });
    expect(prompted.notifications).toHaveLength(1);

    const internal = servers.at(-1) as unknown as {
      handler: { handleMessage(message: unknown): Promise<void> };
      transport: { send(message: unknown): Promise<void> };
    };
    internal.handler.handleMessage = async () => {
      await internal.transport.send({ jsonrpc: '2.0', method: 'custom/notification' });
    };
    const custom = await post(base, headers, {
      jsonrpc: '2.0',
      id: 4,
      method: 'custom',
    });
    expect(custom).toEqual({
      notifications: [{ jsonrpc: '2.0', method: 'custom/notification' }],
    });
  });

  it('acknowledges throwing notifications and terminates throwing requests', async () => {
    const { base, server } = await startServer();
    const internal = server as unknown as {
      handler: { handleMessage(message: unknown): Promise<void> };
    };
    internal.handler.handleMessage = async () => {
      throw new Error('handler failed');
    };
    const headers = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };

    const notification = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel' }),
    });
    expect(notification.status).toBe(200);

    const requestResult = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(requestResult.status).toBe(500);
  });

  it('rejects unauthenticated non-loopback HTTP binds', async () => {
    const server = new WrongStackACPServer({ transport: 0, host: '0.0.0.0' });
    await expect(server.start()).rejects.toThrow(/requires authToken for non-loopback hosts/);
  });

  it('normalizes optional headers, request paths, and loopback hosts', () => {
    expect(wrongStackACPServerCoverage.headerValue(['first', 'second'])).toBe('first');
    expect(wrongStackACPServerCoverage.headerValue('single')).toBe('single');
    expect(wrongStackACPServerCoverage.headerValue(undefined)).toBeUndefined();
    expect(wrongStackACPServerCoverage.requestPath('/rpc')).toBe('/rpc');
    expect(wrongStackACPServerCoverage.requestPath(undefined)).toBe('/');
    expect(wrongStackACPServerCoverage.isLoopbackHost('localhost')).toBe(true);
    expect(wrongStackACPServerCoverage.isLoopbackHost('127.0.0.42')).toBe(true);
    expect(wrongStackACPServerCoverage.isLoopbackHost('::1')).toBe(true);
    expect(wrongStackACPServerCoverage.isLoopbackHost('[::1]')).toBe(true);
    expect(wrongStackACPServerCoverage.isLoopbackHost('0:0:0:0:0:0:0:1')).toBe(true);
    expect(wrongStackACPServerCoverage.isLoopbackHost('[0:0:0:0:0:0:0:1]')).toBe(true);
    expect(wrongStackACPServerCoverage.isLoopbackHost('0:0:0:0:0:0:0:2')).toBe(false);
    expect(wrongStackACPServerCoverage.isLoopbackHost('127.999.0.1')).toBe(false);
    expect(wrongStackACPServerCoverage.isLoopbackHost('0.0.0.0')).toBe(false);
  });

  it('provides an end-turn default implementation', async () => {
    await expect(
      wrongStackACPServerCoverage.defaultEchoRunTurn(
        {} as never,
        async () => undefined,
        {} as never,
      ),
    ).resolves.toEqual({ stopReason: 'end_turn' });
  });
});

async function post(
  base: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

function rawRequest(url: string, body: Buffer): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Length': body.length,
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
