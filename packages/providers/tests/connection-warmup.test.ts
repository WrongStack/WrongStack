/**
 * `warm()` opens the endpoint's connection ahead of the request. Checked
 * against a real server through the real `fetch`: what matters is that the
 * request which follows rides the warmed socket instead of opening its own.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogRoutedProvider } from '../src/catalog-routed.js';
import { warmConnection } from '../src/connection-warmup.js';
import { OpenAICompatibleProvider } from '../src/openai-compatible.js';

interface CountingServer {
  base: string;
  connections: () => number;
  methods: string[];
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function countingServer(): Promise<CountingServer> {
  let connections = 0;
  const methods: string[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    methods.push(`${req.method} ${req.url}`);
    for await (const _ of req) {
      // drain
    }
    if (req.method === 'GET') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, connections: () => connections, methods };
}

const REQUEST: Request = {
  model: 'm',
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  maxTokens: 16,
} as unknown as Request;

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // consume
  }
}

describe('warmConnection', () => {
  it('the real request reuses the socket a warm-up opened', async () => {
    const srv = await countingServer();
    const provider = new OpenAICompatibleProvider({
      id: 'local',
      apiKey: 'k',
      baseUrl: `${srv.base}/v1`,
    });
    await provider.warm('m');
    expect(srv.connections()).toBe(1);
    // fetch hands the socket back to its pool a moment after the response
    // ends; the real request comes seconds later, when the user submits.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await drain(provider.stream(REQUEST, { signal: new AbortController().signal }));
    expect(srv.methods).toEqual(['GET /', 'POST /v1/chat/completions']);
    expect(srv.connections()).toBe(1);
  });

  it('throttles repeat warm-ups of one origin and shares one in flight', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const base = `https://warm-${Math.random().toString(36).slice(2)}.example/v1`;
    await Promise.all([
      warmConnection(base, fetchImpl as never, 1_000),
      warmConnection(`${base}/chat`, fetchImpl as never, 1_000),
    ]);
    await warmConnection(base, fetchImpl as never, 2_500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await warmConnection(base, fetchImpl as never, 4_500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]).toEqual([
      new URL(base).origin + '/',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    ]);
  });

  it('never rejects, and ignores what is not an http(s) URL', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      warmConnection('https://down.example/v1', failing as never, 1),
    ).resolves.toBeUndefined();
    const unused = vi.fn();
    await warmConnection('not a url', unused as never);
    await warmConnection('file:///tmp/x', unused as never);
    expect(unused).not.toHaveBeenCalled();
  });

  it('a fetch failure inside the warm-up window does not throttle the next attempt', async () => {
    // Regression for the r43 connection-warmup bug: `lastWarmAt` was updated
    // synchronously, before the fetch resolved. A transient outage therefore
    // pinned the throttle gate for the full 3 s window even though no socket
    // had been placed in the keep-alive pool — the next warm-up was skipped.
    const fetchImpl = vi
      .fn<(input: unknown, init?: unknown) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const base = 'https://down-then-up.example/v1';

    await warmConnection(base, fetchImpl as never, 1_000);
    // Let the IIFE's catch/finally run so any throttle state from the
    // rejected attempt is cleared before the next dispatch.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 50 ms later (well inside the 3 s interval) the host is back up. The
    // retry must issue a fresh GET instead of staying throttled.
    await warmConnection(base, fetchImpl as never, 1_050);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a routed provider warms the endpoint its model routes to', async () => {
    const srv = await countingServer();
    const provider = new CatalogRoutedProvider({
      id: 'routed',
      apiKey: 'k',
      defaultNpm: '@ai-sdk/openai-compatible',
      baseUrl: `${srv.base}/v1`,
    });
    await provider.warm('m');
    expect(srv.methods).toEqual(['GET /']);
  });
});
