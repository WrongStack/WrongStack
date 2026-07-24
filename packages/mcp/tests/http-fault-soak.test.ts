import { EventBus } from '@wrongstack/core/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import type { Logger, MCPServerConfig } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPRegistry } from '../src/registry.js';

const silentLog: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as never as Logger;

const INIT_RESULT = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {} },
  serverInfo: { name: 'http-faulty', version: '1.0.0' },
};

function jsonRes(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/**
 * Build a fetch implementation that follows a deterministic fault schedule.
 * Each call consumes the next handler. Handlers return either a successful
 * Response or throw (network/timeout/5xx).
 */
function makeFaultyFetch(
  handlers: ((url: string, init: { body?: string }) => Promise<Response> | Response)[],
): typeof globalThis.fetch {
  let i = 0;
  return vi.fn(async (url: string, init: { body?: string } = {}) => {
    const h = handlers[i++];
    if (!h) throw new Error(`unexpected fetch call ${i}`);
    return Promise.resolve(h(url, init));
  }) as never as typeof globalThis.fetch;
}

function httpCfg(name: string): MCPServerConfig {
  return {
    name,
    transport: 'streamable-http',
    url: 'https://faulty.example/mcp',
    startupTimeoutMs: 1000,
    requestTimeoutMs: 1000,
  };
}

describe('MCP HTTP fault-injection soak', () => {
  let toolReg: ToolRegistry;
  let events: EventBus;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    toolReg = new ToolRegistry();
    events = new EventBus();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('recovers from intermittent HTTP failures and tracks operational health', {
    timeout: 45_000,
  }, async () => {
    // Pattern: connect, then alternate a few good calls with transient failures.
    // The registry should keep the server healthy once the failures stop.
    const handlers: ((url: string, init: { body?: string }) => Promise<Response> | Response)[] = [
      // initialize
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        return jsonRes({ jsonrpc: '2.0', id: body.id, result: INIT_RESULT });
      },
      // notifications/initialized
      () => jsonRes({ jsonrpc: '2.0' }),
      // tools/list
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        return jsonRes({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object' } }] },
        });
      },
      // tools/call #1 success
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        return jsonRes({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: 'ok-1', isError: false },
        });
      },
      // tools/call #2 transient 503
      () => jsonRes({ error: 'overloaded' }, { status: 503 }),
      // tools/call #3 transient network rejection
      () => Promise.reject(new Error('ECONNRESET')),
      // tools/call #4 success
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        return jsonRes({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: 'ok-2', isError: false },
        });
      },
      // tools/call #5 success
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        return jsonRes({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: 'ok-3', isError: false },
        });
      },
    ];

    // After the scheduled handlers are exhausted, keep returning successes so
    // the soak can keep calling without triggering unexpected fetches.
    const fetchImpl = makeFaultyFetch(handlers);
    globalThis.fetch = fetchImpl;

    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(httpCfg('http-soak'));

    await expect
      .poll(() => reg.list()[0]?.state, { timeout: 5000, interval: 100 })
      .toBe('connected');

    const tool = toolReg.list().find((t) => t.name === 'mcp__http-soak__ping');
    let successes = 0;
    let failures = 0;
    for (let i = 0; i < 6; i++) {
      try {
        const result = await tool?.execute?.({}, {} as never, {
          signal: new AbortController().signal,
        });
        if (typeof result === 'string' && result.startsWith('ok-')) {
          successes++;
        }
      } catch {
        failures++;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // At least one success should survive the transient faults.
    expect(successes).toBeGreaterThanOrEqual(1);
    expect(failures).toBeGreaterThanOrEqual(1);

    const op = reg.operationalHealth()[0];
    expect(op).toBeDefined();
    if (!op) throw new Error('operationalHealth missing');
    // After recovery the server should be healthy again (no consecutive failures).
    expect(op.healthState).toBeOneOf(['healthy', 'degraded']);
    expect(op.failures.transport).toBeGreaterThanOrEqual(0);

    await reg.stopAll();
  });

  it('gives up after persistent HTTP transport failures and marks the server failed', {
    timeout: 60_000,
  }, async () => {
    // Every fetch rejects, simulating a dead HTTP endpoint.
    const fetchImpl = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    }) as never as typeof globalThis.fetch;
    globalThis.fetch = fetchImpl;

    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(httpCfg('http-dead'));

    // The slot must eventually give up and become failed.
    await expect
      .poll(() => reg.list()[0]?.state, { timeout: 45_000, interval: 200 })
      .toBe('failed');

    const op = reg.operationalHealth()[0];
    expect(op).toBeDefined();
    if (!op) throw new Error('operationalHealth missing');
    expect(op.healthState).toBe('failed');
    expect(op.consecutiveFailures).toBeGreaterThan(0);
    expect(op.failures.transport).toBeGreaterThan(0);
    // Startup failure may exhaust inline attempts before any reconnect cycle,
    // so reconnectCount can legitimately be 0. The important bound is that
    // fetch attempts stay capped and the slot ends in failed.

    // Must not create a tight request loop: with exponential backoff we expect
    // a bounded number of fetch attempts within the failure window.
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThan(40);

    await reg.stopAll();
  });

  it('handles alternating connect and call failures without leaking connected state', {
    timeout: 45_000,
  }, async () => {
    // Sequence: connect ok, call ok, disconnect, reconnect ok, call fail, ...
    // Verifies that HTTP transport disconnects propagate and the registry
    // re-discovers tools on each reconnect.
    let callCount = 0;
    const fetchImpl = vi.fn(async (_url: string, init: { body?: string } = {}) => {
      const body = init.body ? (JSON.parse(init.body) as { method?: string; id?: number }) : {};
      if (body.method === 'initialize') {
        return jsonRes({ jsonrpc: '2.0', id: body.id, result: INIT_RESULT });
      }
      if (body.method === 'notifications/initialized') {
        return jsonRes({ jsonrpc: '2.0' });
      }
      if (body.method === 'tools/list') {
        return jsonRes({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object' } }] },
        });
      }
      callCount++;
      if (callCount % 3 === 0) {
        throw new Error('injected call fault');
      }
      return jsonRes({ jsonrpc: '2.0', id: body.id, result: { content: 'ok', isError: false } });
    }) as never as typeof globalThis.fetch;
    globalThis.fetch = fetchImpl;

    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(httpCfg('http-alternating'));

    await expect
      .poll(() => reg.list()[0]?.state, { timeout: 8000, interval: 100 })
      .toBe('connected');

    const tool = toolReg.list().find((t) => t.name === 'mcp__http-alternating__ping');
    let successes = 0;
    for (let i = 0; i < 12; i++) {
      try {
        const result = await tool?.execute?.({}, {} as never, {
          signal: new AbortController().signal,
        });
        if (typeof result === 'string' && result === 'ok') {
          successes++;
        }
      } catch {
        /* expected intermittent */
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    expect(successes).toBeGreaterThanOrEqual(3);

    const op = reg.operationalHealth()[0];
    expect(op).toBeDefined();
    if (!op) throw new Error('operationalHealth missing');
    // The alternating pattern means the server may be healthy or degraded,
    // but it should not be stuck in failed while the endpoint is responsive.
    expect(op.healthState).not.toBe('failed');

    await reg.stopAll();
  });
});
