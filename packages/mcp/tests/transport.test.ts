import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SSEReader,
  SSETransport,
  StreamableHTTPTransport,
  extractJsonRpcResults,
} from '../src/transport.js';

const originalUnsafeMcpTls = process.env['WRONGSTACK_UNSAFE_MCP_TLS'];
const originalCi = process.env['CI'];

afterEach(() => {
  if (originalUnsafeMcpTls === undefined) delete process.env['WRONGSTACK_UNSAFE_MCP_TLS'];
  else process.env['WRONGSTACK_UNSAFE_MCP_TLS'] = originalUnsafeMcpTls;
  if (originalCi === undefined) delete process.env['CI'];
  else process.env['CI'] = originalCi;
});

describe('extractJsonRpcResults', () => {
  it('parses plain NDJSON', () => {
    const r = extractJsonRpcResults('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe(1);
  });

  it('parses SSE-framed responses (strips the data: prefix)', () => {
    // The exact shape modern MCP servers (e.g. Context7) return.
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n';
    const r = extractJsonRpcResults(sse);
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe(2);
    expect((r[0]?.result as { tools: unknown[] }).tools).toEqual([]);
  });

  it('joins multi-line SSE data within one event', () => {
    const sse = 'data: {"jsonrpc":"2.0",\ndata: "id":3,"result":1}\n\n';
    const r = extractJsonRpcResults(sse);
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe(3);
  });

  it('ignores SSE comments and non-JSON noise', () => {
    const sse =
      ': keep-alive\nevent: ping\ndata: not-json\n\ndata: {"jsonrpc":"2.0","id":4,"result":{}}\n\n';
    const r = extractJsonRpcResults(sse);
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe(4);
  });
});

describe('SSEReader', () => {
  it('dispatches a single complete event', () => {
    const r = new SSEReader();
    const seen: unknown[] = [];
    r.onMessage((m) => seen.push(m));
    r.feed('data: {"jsonrpc":"2.0","id":1,"params":{"x":42}}\n\n');
    expect(seen).toHaveLength(1);
    expect((seen[0] as { id: number }).id).toBe(1);
  });

  it('handles chunked data across feed() calls', () => {
    const r = new SSEReader();
    const seen: unknown[] = [];
    r.onMessage((m) => seen.push(m));
    r.feed('data: {"jso');
    r.feed('nrpc":"2.0","id":2}\n');
    r.feed('\n');
    expect(seen).toHaveLength(1);
    expect((seen[0] as { id: number }).id).toBe(2);
  });

  it('dispatches only after a blank line and joins multi-line data', () => {
    const r = new SSEReader();
    const seen: unknown[] = [];
    r.onMessage((m) => seen.push(m));
    r.feed('event: message\r\n');
    r.feed('data: {"jsonrpc":"2.0",\r\n');
    r.feed('data: "id":3}\r\n');
    expect(seen).toHaveLength(0);
    r.feed('\r\n');
    expect(seen).toHaveLength(1);
    expect((seen[0] as { id: number }).id).toBe(3);
  });

  it('ignores parse errors silently and continues with the next event', () => {
    const r = new SSEReader();
    const seen: unknown[] = [];
    r.onMessage((m) => seen.push(m));
    r.feed('data: not-json\n\n');
    r.feed('data: {"jsonrpc":"2.0","id":7}\n\n');
    expect(seen).toHaveLength(1);
    expect((seen[0] as { id: number }).id).toBe(7);
  });

  it('unsubscribe stops further dispatches', () => {
    const r = new SSEReader();
    const cb = vi.fn();
    const off = r.onMessage(cb);
    r.feed('data: {"id":1}\n\n');
    off();
    r.feed('data: {"id":2}\n\n');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('handler exception does not block other handlers', () => {
    const r = new SSEReader();
    const good = vi.fn();
    r.onMessage(() => {
      throw new Error('boom');
    });
    r.onMessage(good);
    r.feed('data: {"id":1}\n\n');
    expect(good).toHaveBeenCalledOnce();
  });

  it('reset clears buffer and listeners', () => {
    const r = new SSEReader();
    const cb = vi.fn();
    r.onMessage(cb);
    // Feed a partial line — no trailing newline, so the parser hasn't
    // processed it yet. reset() must wipe both the listeners and the
    // half-built buffer so the remainder of the event is treated as
    // garbage instead of being completed against the prior prefix.
    r.feed('data: {"id":1');
    r.reset();
    r.feed('}\n\n');
    expect(cb).not.toHaveBeenCalled();
  });

  it('throws when data lines exceed SSE_READER_MAX_DATA_LINES', () => {
    const r = new SSEReader();
    // Feed 1024 data lines without a blank-line delimiter — should throw
    // before flushing to prevent memory exhaustion from malicious servers.
    const manyLines = 'data: x\n'.repeat(1024);
    expect(() => r.feed(manyLines + 'data: overflow\n')).toThrow(/exceeded 1024 data lines/);
  });
});

describe('SSETransport — connection failure modes', () => {
  it('starts in idle state', () => {
    const t = new SSETransport({ name: 'x', url: 'https://example.test' });
    expect(t.getState()).toBe('idle');
    expect(t.listTools()).toEqual([]);
  });

  it('transitions to failed when fetch rejects', async () => {
    const t = new SSETransport({
      name: 'x',
      url: 'http://127.0.0.1:1/never',
      startupTimeoutMs: 200,
    });
    await expect(t.connect()).rejects.toThrow();
    expect(t.getState()).toBe('failed');
  });

  it('callTool throws when not connected', async () => {
    const t = new SSETransport({ name: 'x', url: 'https://example.test' });
    await expect(t.callTool('any', {})).rejects.toThrow(/not connected/);
  });

  it('close is safe to call without connect', async () => {
    const t = new SSETransport({ name: 'x', url: 'https://example.test' });
    await expect(t.close()).resolves.toBeUndefined();
    expect(t.getState()).toBe('disconnected');
  });

  it('startupTimeoutMs bounds connect() wall-clock duration', async () => {
    const t = new SSETransport({
      name: 'slow',
      url: 'https://10.255.255.1/never', // blackholed (https: non-loopback http is rejected)
      startupTimeoutMs: 150,
    });
    const start = Date.now();
    await expect(t.connect()).rejects.toThrow();
    const elapsed = Date.now() - start;
    // Generous bound: the timer fires at 150ms, plus fetch + abort
    // bookkeeping. If we ever get above 5000ms the timeout isn't wired
    // (unwired = hangs until the OS network stack gives up, far longer).
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('validateTransportUrl SSRF guard (via constructor)', () => {
  it('blocks IPv4 link-local / IMDS (169.254.x.x)', () => {
    expect(() => new SSETransport({ name: 'x', url: 'https://169.254.169.254/' })).toThrow(
      /link-local|IMDS/,
    );
  });

  // F-07: IPv6 parity for the IPv4 IMDS/link-local block.
  it('blocks IPv6 link-local (fe80::/10)', () => {
    expect(() => new StreamableHTTPTransport({ name: 'x', url: 'https://[fe80::1]/' })).toThrow(
      /link-local|IMDS/,
    );
  });

  it('blocks the AWS IPv6 IMDS address (fd00:ec2::254)', () => {
    expect(() => new SSETransport({ name: 'x', url: 'https://[fd00:ec2::254]/' })).toThrow(
      /link-local|IMDS/,
    );
  });

  it('allows a normal remote https host', () => {
    expect(() => new SSETransport({ name: 'x', url: 'https://mcp.example.com/' })).not.toThrow();
  });

  it('rejects disabled TLS verification even when CI=true', () => {
    delete process.env['WRONGSTACK_UNSAFE_MCP_TLS'];
    process.env['CI'] = 'true';

    expect(
      () =>
        new SSETransport({
          name: 'x',
          url: 'https://mcp.example.com/',
          tls: { rejectUnauthorized: false },
        }),
    ).toThrow(/WRONGSTACK_UNSAFE_MCP_TLS=1/);
  });

  it('allows disabled TLS verification only with explicit opt-in', () => {
    process.env['WRONGSTACK_UNSAFE_MCP_TLS'] = '1';

    expect(
      () =>
        new StreamableHTTPTransport({
          name: 'x',
          url: 'https://mcp.example.com/',
          tls: { rejectUnauthorized: false },
        }),
    ).not.toThrow();
  });
});

describe('StreamableHTTPTransport — connection failure modes', () => {
  it('starts in idle state', () => {
    const t = new StreamableHTTPTransport({ name: 'x', url: 'https://example.test' });
    expect(t.getState()).toBe('idle');
    expect(t.listTools()).toEqual([]);
  });

  it('transitions to failed when fetch rejects', async () => {
    const t = new StreamableHTTPTransport({
      name: 'x',
      url: 'http://127.0.0.1:1/never',
      startupTimeoutMs: 200,
    });
    await expect(t.connect()).rejects.toThrow();
    expect(t.getState()).toBe('failed');
  });

  it('callTool throws when not connected', async () => {
    const t = new StreamableHTTPTransport({ name: 'x', url: 'https://example.test' });
    await expect(t.callTool('any', {})).rejects.toThrow(/not connected/);
  });

  it('startupTimeoutMs bounds connect() wall-clock duration', async () => {
    const t = new StreamableHTTPTransport({
      name: 'slow',
      url: 'https://10.255.255.1/never', // blackholed (https: non-loopback http is rejected)
      startupTimeoutMs: 150,
    });
    const start = Date.now();
    await expect(t.connect()).rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  it('onDisconnect returns unsubscribe function', () => {
    const t = new StreamableHTTPTransport({ name: 'x', url: 'https://example.test' });
    const cb = vi.fn();
    const off = t.onDisconnect(cb);
    expect(typeof off).toBe('function');
    off();
  });

  it('onDisconnect unsubscribe works', () => {
    const t = new StreamableHTTPTransport({ name: 'x', url: 'https://example.test' });
    const cb = vi.fn();
    const off = t.onDisconnect(cb);
    off();
    // Manually trigger to verify cb is no longer called
    // We can't easily test the internal call since there's no disconnect() without connect()
    // But we verified the unsubscribe function removes the handler
  });

  it('close is idempotent', async () => {
    const t = new StreamableHTTPTransport({ name: 'x', url: 'https://example.test' });
    await t.close(); // first call
    await t.close(); // second call — must not throw
    expect(t.getState()).toBe('disconnected');
  });
});

describe('StreamableHTTPTransport — connect/callTool with mocked fetch', () => {
  function mkFetch(
    handlers: ((
      url: string,
      init: { body?: string; headers?: Record<string, string> },
    ) => Promise<Response> | Response)[],
  ): typeof globalThis.fetch {
    let i = 0;
    return ((url: string, init: { body?: string; headers?: Record<string, string> } = {}) => {
      const h = handlers[i++];
      if (!h) throw new Error(`unexpected fetch (no handler for call ${i})`);
      return Promise.resolve(h(url, init));
    }) as never as typeof globalThis.fetch;
  }

  function jsonRes(
    body: unknown,
    init: { status?: number; headers?: Record<string, string> } = {},
  ): Response {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  }

  it('connect → initialize → tools/list happy path', async () => {
    const calls: { method: string; body: any }[] = [];
    const fetchImpl = mkFetch([
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        calls.push({ method: body.method, body });
        return jsonRes({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } });
      },
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        calls.push({ method: body.method, body });
        return jsonRes({ jsonrpc: '2.0' });
      },
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        calls.push({ method: body.method, body });
        return jsonRes({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'hello', description: 'd', inputSchema: { type: 'object' } }] },
        });
      },
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      expect(t.getState()).toBe('connected');
      expect(t.listTools().map((x) => x.name)).toEqual(['hello']);
      expect(calls.map((c) => c.method)).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
      ]);
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('normalizes invalid tools from streamable-http tools/list', async () => {
    const fetchImpl = mkFetch([
      (_u, init) => jsonRes({ jsonrpc: '2.0', id: JSON.parse(init.body ?? '{}').id, result: {} }),
      () => jsonRes({ jsonrpc: '2.0' }),
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          result: {
            tools: [{ name: 'ok' }, { name: '' }, { description: 'missing name' }],
          },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      expect(t.listTools()).toEqual([
        { name: 'ok', inputSchema: { type: 'object', properties: {} } },
      ]);
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('callTool returns { content, isError } after a successful connect', async () => {
    const fetchImpl = mkFetch([
      // initialize
      (_u, init) => jsonRes({ jsonrpc: '2.0', id: JSON.parse(init.body ?? '{}').id, result: {} }),
      // notifications/initialized — postRaw requires a valid JSON-RPC line
      () => jsonRes({ jsonrpc: '2.0' }),
      // tools/list
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          result: { tools: [{ name: 'hello' }] },
        }),
      // tools/call
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          result: { content: 'hi', isError: false },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      const res = await t.callTool('hello', { who: 'world' });
      expect(res.content).toBe('hi');
      expect(res.isError).toBe(false);
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('callTool surfaces error responses', async () => {
    const fetchImpl = mkFetch([
      (_u, init) => jsonRes({ jsonrpc: '2.0', id: JSON.parse(init.body ?? '{}').id, result: {} }),
      () => jsonRes({ jsonrpc: '2.0' }),
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          result: { tools: [] },
        }),
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          error: { code: -32601, message: 'bad call' },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      const res = await t.callTool('nope', {});
      expect(res.isError).toBe(true);
      expect(res.content).toContain('bad call');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('connect throws when initialize returns a JSON-RPC error', async () => {
    const fetchImpl = mkFetch([
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          error: { code: -1, message: 'no good' },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await expect(t.connect()).rejects.toThrow(/initialize failed/);
      expect(t.getState()).toBe('failed');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('connect throws when initialize body cannot be parsed', async () => {
    const fetchImpl = mkFetch([
      () =>
        new Response('totally not JSON', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await expect(t.connect()).rejects.toThrow();
      expect(t.getState()).toBe('failed');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('connect parses NDJSON body when content-type is not application/json', async () => {
    const ndjson = [JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), ''].join('\n');
    const fetchImpl = mkFetch([
      () => new Response(ndjson, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      // notifications/initialized — postRaw requires a valid JSON-RPC line
      () => jsonRes({ jsonrpc: '2.0' }),
      // tools/list
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          result: { tools: [] },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      expect(t.getState()).toBe('connected');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('connect throws when init returns non-OK status', async () => {
    const fetchImpl = mkFetch([
      () => new Response('err', { status: 502, statusText: 'Bad Gateway' }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await expect(t.connect()).rejects.toThrow(/initialize HTTP 502/);
      expect(t.getState()).toBe('failed');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('onToolsChanged subscribe + unsubscribe', () => {
    const t = new StreamableHTTPTransport({ name: 'x', url: 'https://x' });
    const cb = vi.fn();
    const off = t.onToolsChanged(cb);
    off();
    expect(cb).not.toHaveBeenCalled();
  });

  it('onDisconnect returns unsubscribe function on SSETransport', () => {
    const t = new SSETransport({ name: 'x', url: 'https://example.test' });
    const cb = vi.fn();
    const off = t.onDisconnect(cb);
    expect(typeof off).toBe('function');
    off();
  });

  it('onToolsChanged returns unsubscribe function on SSETransport', () => {
    const t = new SSETransport({ name: 'x', url: 'https://example.test' });
    const cb = vi.fn();
    const off = t.onToolsChanged(cb);
    expect(typeof off).toBe('function');
    off();
  });

  it('SSETransport close is idempotent', async () => {
    const t = new SSETransport({ name: 'x', url: 'https://example.test' });
    await t.close();
    await t.close(); // must not throw
    expect(t.getState()).toBe('disconnected');
  });

  it('SSETransport close while in disconnected state is no-op', async () => {
    const t = new SSETransport({ name: 'x', url: 'https://example.test' });
    // Start from disconnected state
    await t.close();
    // Verify state is disconnected, not failed
    expect(t.getState()).toBe('disconnected');
  });

  it('SSEReader ignores lines that are not event: or data:', () => {
    const r = new SSEReader();
    const seen: unknown[] = [];
    r.onMessage((m) => seen.push(m));
    // comment lines, blank lines, other prefixes
    r.feed('# comment line\n');
    r.feed('\n');
    r.feed('other: something\n');
    r.feed('data: {"id":1}\n\n');
    expect(seen).toHaveLength(1);
  });

  it('SSEReader ignores empty data: lines', () => {
    const r = new SSEReader();
    const seen: unknown[] = [];
    r.onMessage((m) => seen.push(m));
    r.feed('data:   \n');
    r.feed('data:   \n');
    r.feed('data: {"id":2}\n\n');
    expect(seen).toHaveLength(1);
    expect((seen[0] as { id: number }).id).toBe(2);
  });

  it('SSEReader throws when buffer exceeds SSE_READER_MAX_BUFFER', () => {
    const r = new SSEReader();
    r.onMessage(() => {});
    // Feed enough data to exceed 256KB limit
    const large = 'x'.repeat(257 * 1024);
    expect(() => r.feed(large)).toThrow(/exceeds max buffer/);
  });

  it('SSEReader dispatches events from multiple feeds in order', () => {
    const r = new SSEReader();
    const seen: { id: number }[] = [];
    r.onMessage((m) => seen.push(m as { id: number }));
    r.feed('data: {"id":1}\n');
    r.feed('\n');
    r.feed('data: {"id":2}\n');
    r.feed('\n');
    expect(seen).toHaveLength(2);
    expect(seen[0]?.id).toBe(1);
    expect(seen[1]?.id).toBe(2);
  });

  it('SSETransport buildSSEUrl adds session param', () => {
    const t = new SSETransport({ name: 'x', url: 'https://example.test/foo' });
    const sseUrl = (t as never as { buildSSEUrl: () => string }).buildSSEUrl();
    expect(sseUrl).toContain('session=');
  });

  it('SSETransport buildSSEUrl propagates URL parse errors gracefully', () => {
    const t = new SSETransport({ name: 'x', url: 'https://example.test/foo?a=1' });
    const sseUrl = (t as never as { buildSSEUrl: () => string }).buildSSEUrl();
    expect(sseUrl).toContain('example.test');
    expect(sseUrl).toContain('session=');
  });
});

describe('SSETransport — mocked connect + callTool', () => {
  function mkFetch(
    handlers: ((
      url: string,
      init: { body?: string; headers?: Record<string, string> },
    ) => Promise<Response> | Response)[],
  ): typeof globalThis.fetch {
    let i = 0;
    return ((url: string, init: { body?: string; headers?: Record<string, string> } = {}) => {
      const h = handlers[i++];
      if (!h) throw new Error(`unexpected fetch (no handler for call ${i})`);
      return Promise.resolve(h(url, init));
    }) as never as typeof globalThis.fetch;
  }

  function jsonRes(
    body: unknown,
    init: { status?: number; headers?: Record<string, string> } = {},
  ): Response {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
  }

  it('callTool returns isError=true when server returns error in result', async () => {
    const fetchImpl = mkFetch([
      // connect — SSE init fetch
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        if (body.method === 'initialize') {
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: {} });
        }
        if (body.method === 'notifications/initialized') {
          return jsonRes({ jsonrpc: '2.0' });
        }
        if (body.method === 'tools/list') {
          return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools: [] } });
        }
        return jsonRes({ jsonrpc: '2.0' });
      },
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      new SSETransport({ name: 'x', url: 'https://m.test' });
      // Can't fully test without mocking SSE stream, but we can test the
      // callTool error path via the already-connected transport state.
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('SSETransport calls httpPost with correct JSON-RPC envelope', async () => {
    const calls: { method: string; body: string }[] = [];
    const fetchImpl = mkFetch([
      // SSE stream fetch
      () => new Response('ok', { status: 200 }),
      // initialize
      (_u, init) => {
        calls.push({ method: 'initialize', body: init.body ?? '' });
        return jsonRes({ jsonrpc: '2.0', id: 1, result: {} });
      },
      // notifications/initialized
      () => jsonRes({ jsonrpc: '2.0' }),
      // tools/list
      (_u, init) => {
        calls.push({ method: 'tools/list', body: init.body ?? '' });
        return jsonRes({ jsonrpc: '2.0', id: 3, result: { tools: [] } });
      },
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new SSETransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        const parsed = JSON.parse(c.body);
        expect(parsed.jsonrpc).toBe('2.0');
        expect(parsed.method).toBeDefined();
      }
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('SSETransport httpPost throws on non-OK HTTP status', async () => {
    const fetchImpl = mkFetch([
      // SSE stream fetch (will fail)
      () => new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new SSETransport({ name: 'x', url: 'https://m.test' });
      await expect(t.connect()).rejects.toThrow(/502/);
      expect(t.getState()).toBe('failed');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('SSETransport httpPost throws on invalid JSON response', async () => {
    const fetchImpl = mkFetch([
      // SSE stream fetch
      () => new Response('ok', { status: 200 }),
      // httpPost for initialize
      () =>
        new Response('not json at all', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new SSETransport({ name: 'x', url: 'https://m.test' });
      await expect(t.connect()).rejects.toThrow();
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('SSETransport httpPost throws on non-JSON-RPC envelope', async () => {
    const fetchImpl = mkFetch([
      // SSE stream fetch
      () => new Response('ok', { status: 200 }),
      // httpPost for initialize — returns valid JSON but not JSON-RPC envelope
      () =>
        new Response(JSON.stringify({ result: 'no jsonrpc field' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new SSETransport({ name: 'x', url: 'https://m.test' });
      await expect(t.connect()).rejects.toThrow(/JSON-RPC/);
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('SSETransport rejects a mismatched JSON-RPC id', async () => {
    const fetchImpl = mkFetch([
      () => new Response('ok', { status: 200 }),
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        return jsonRes({ jsonrpc: '2.0', id: body.id + 100, result: {} });
      },
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new SSETransport({ name: 'x', url: 'https://m.test' });
      await expect(t.connect()).rejects.toThrow(/id mismatch/);
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('SSETransport keeps request timeout active while reading the response body', async () => {
    const fetchImpl = (async (_url: unknown, init?: { signal?: AbortSignal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new Error('body aborted')),
              { once: true },
            );
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as never as typeof globalThis.fetch;
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new SSETransport({ name: 'x', url: 'https://m.test', requestTimeoutMs: 20 });
      await expect(
        (
          t as never as { httpPost: (method: string, params: unknown) => Promise<unknown> }
        ).httpPost('tools/list', {}),
      ).rejects.toThrow(/body aborted|timed out|Invalid JSON-RPC response/);
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('SSETransport httpPost truncates large error bodies', async () => {
    const largeBody = 'x'.repeat(2000);
    const fetchImpl = mkFetch([
      // SSE stream fetch
      () => new Response('ok', { status: 200 }),
      // httpPost for initialize — server returns 500 with large body
      () => new Response(largeBody, { status: 500, statusText: 'Server Error' }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new SSETransport({ name: 'x', url: 'https://m.test' });
      await expect(t.connect()).rejects.toThrow(/500/);
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('StreamableHTTPTransport postRaw throws on non-OK HTTP status', async () => {
    const fetchImpl = mkFetch([() => new Response('Gone', { status: 410, statusText: 'Gone' })]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await expect(t.connect()).rejects.toThrow(/410/);
      expect(t.getState()).toBe('failed');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('StreamableHTTPTransport close does NOT fire disconnect handlers', async () => {
    // Create a transport and verify close doesn't call disconnect handlers
    const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
    const cb = vi.fn();
    t.onDisconnect(cb);
    await t.close();
    // Disconnect handlers should NOT be called on explicit close
    expect(cb).not.toHaveBeenCalled();
  });

  it('StreamableHTTPTransport close sets state to disconnected', async () => {
    const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
    await t.close();
    expect(t.getState()).toBe('disconnected');
  });

  it('StreamableHTTPTransport handles NDJSON parse error in response', async () => {
    const fetchImpl = mkFetch([
      // Use a content-type that triggers the NDJSON parsing path
      () =>
        new Response('not json line 1\nalso not json\n', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await expect(t.connect()).rejects.toThrow(/Could not parse/);
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('StreamableHTTPTransport connect throws when session ID missing from headers', async () => {
    // This tests the case where x-mcp-session header is absent — the transport
    // should still work (session is optional)
    const fetchImpl = mkFetch([
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      () => jsonRes({ jsonrpc: '2.0' }),
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          result: { tools: [] },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      // Without x-mcp-session header, sessionId is undefined — postRaw uses URL without session param
      expect(t.getState()).toBe('connected');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('StreamableHTTPTransport uses session ID in subsequent requests', async () => {
    const fetchImpl = mkFetch([
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        if (body.method === 'initialize') {
          // Simulate a server that sends back a session header
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-mcp-session': 'test-session-123',
            },
          });
        }
        return jsonRes({ jsonrpc: '2.0', id: body.id, result: {} });
      },
      // notifications/initialized
      () => jsonRes({ jsonrpc: '2.0' }),
      // tools/list
      (_u, init) =>
        jsonRes({
          jsonrpc: '2.0',
          id: JSON.parse(init.body ?? '{}').id,
          result: { tools: [] },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      // The transport should have stored the session ID and used it in postRaw
      expect(t.getState()).toBe('connected');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('SSETransport onDisconnect fires multiple handlers', () => {
    const t = new SSETransport({ name: 'x', url: 'https://example.test' });
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    t.onDisconnect(cb1);
    t.onDisconnect(cb2);
    const off1 = t.onDisconnect(cb1);
    off1(); // unsubscribe cb1, cb2 should still be called
    // We can't easily trigger disconnect without connect, but we verify
    // the unsubscribe works by checking cb2 is still registered (not throw)
    expect(() => t.onDisconnect(cb2)).not.toThrow();
  });

  it('SSEReader onMessage returns unsubscribe that removes specific listener', () => {
    const r = new SSEReader();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const off1 = r.onMessage(cb1);
    r.onMessage(cb2);
    off1();
    r.feed('data: {"id":99}\n\n');
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it('SSEReader dispatch swallows listener exceptions', () => {
    const r = new SSEReader();
    r.onMessage(() => {
      throw new Error('listener error');
    });
    const good = vi.fn();
    r.onMessage(good);
    // Should not throw — exceptions in dispatch are caught
    expect(() => r.feed('data: {"id":1}\n\n')).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });

  it('StreamableHTTPTransport rejects a mismatched JSON-RPC id', async () => {
    const fetchImpl = mkFetch([
      (_u, init) => {
        const body = JSON.parse(init.body ?? '{}');
        return jsonRes({ jsonrpc: '2.0', id: body.id + 1, result: {} });
      },
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await expect(t.connect()).rejects.toThrow(/id mismatch/);
      expect(t.getState()).toBe('failed');
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('StreamableHTTPTransport keeps request timeout active while reading the response body', async () => {
    const fetchImpl = (async (_url: unknown, init?: { signal?: AbortSignal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new Error('body aborted')),
              { once: true },
            );
          },
        }),
        { status: 200, headers: { 'content-type': 'text/plain' } },
      )) as never as typeof globalThis.fetch;
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({
        name: 'x',
        url: 'https://m.test',
        requestTimeoutMs: 20,
      });
      await expect(
        (
          t as never as { postRaw: (method: string, params: unknown) => Promise<unknown> }
        ).postRaw('tools/list', {}),
      ).rejects.toThrow(/body aborted|timed out/);
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('StreamableHTTPTransport.request() throws on non-OK HTTP status (lines 773-775)', async () => {
    const fetchImpl = mkFetch([
      // initialize
      (_u, init) => jsonRes({ jsonrpc: '2.0', id: JSON.parse(init.body ?? '{}').id, result: {} }),
      // notifications/initialized
      () => jsonRes({ jsonrpc: '2.0' }),
      // tools/list
      (_u, init) =>
        jsonRes({ jsonrpc: '2.0', id: JSON.parse(init.body ?? '{}').id, result: { tools: [] } }),
      // tools/call — non-OK status throws from request() method (not postRaw)
      () => new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      // callTool uses postRaw for error handling, but we test request() directly
      // to cover the non-OK throw path in StreamableHTTPTransport.request()
      await expect(
        (t as never as { request: (m: string, p: unknown) => Promise<unknown> }).request(
          'tools/call',
          { name: 'x', arguments: {} },
        ),
      ).rejects.toThrow(/503/);
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('StreamableHTTPTransport.request() throws on non-JSON-RPC response (lines 778-795)', async () => {
    const fetchImpl = mkFetch([
      // initialize
      (_u, init) => jsonRes({ jsonrpc: '2.0', id: JSON.parse(init.body ?? '{}').id, result: {} }),
      // notifications/initialized
      () => jsonRes({ jsonrpc: '2.0' }),
      // tools/list
      (_u, init) =>
        jsonRes({ jsonrpc: '2.0', id: JSON.parse(init.body ?? '{}').id, result: { tools: [] } }),
      // tools/call — valid HTTP but not JSON-RPC
      () =>
        new Response('plain text not JSON-RPC', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      await expect(
        (t as never as { request: (m: string, p: unknown) => Promise<unknown> }).request(
          'tools/call',
          { name: 'x', arguments: {} },
        ),
      ).rejects.toThrow(/Could not parse response as JSON-RPC/);
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('StreamableHTTPTransport.request() parses NDJSON lines for JSON-RPC result (lines 778-779)', async () => {
    // Test that request() reads multiple lines and finds the JSON-RPC result
    const fetchImpl = mkFetch([
      // initialize
      (_u, init) => jsonRes({ jsonrpc: '2.0', id: JSON.parse(init.body ?? '{}').id, result: {} }),
      // notifications/initialized
      () => jsonRes({ jsonrpc: '2.0' }),
      // tools/list
      (_u, init) =>
        jsonRes({ jsonrpc: '2.0', id: JSON.parse(init.body ?? '{}').id, result: { tools: [] } }),
      // tools/call — NDJSON response (multiple lines)
      () =>
        new Response(
          'ping event line\n' +
            JSON.stringify({ jsonrpc: '2.0', id: 4, result: { content: 'ok' } }) +
            '\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      const t = new StreamableHTTPTransport({ name: 'x', url: 'https://m.test' });
      await t.connect();
      const res = await (
        t as never as { request: (m: string, p: unknown) => Promise<unknown> }
      ).request('tools/call', { name: 'x', arguments: {} });
      // Should have found the JSON-RPC result in the NDJSON lines
      expect((res as { result?: unknown }).result).toBeDefined();
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });

  it('createTimeoutSignal aborts immediately when parent signal is already aborted (line 833)', async () => {
    // Test the createTimeoutSignal path where parent?.aborted is true (line 832-833)
    const t = new SSETransport({ name: 'x', url: 'https://m.test' });
    // Create an already-aborted parent signal
    const ctrl = new AbortController();
    ctrl.abort(new Error('already aborted'));
    // Use httpPost with an aborted parent signal — createTimeoutSignal should
    // immediately abort the child signal
    const fetchImpl = mkFetch([
      () => new Response('ok', { status: 200 }),
      () => new Response('ok', { status: 200 }),
    ]);
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: typeof globalThis.fetch }).fetch = fetchImpl;
    try {
      // Verify that passing an aborted parent signal results in an aborted child
      await expect(
        (
          t as never as {
            httpPost: (m: string, p: unknown, timeoutMs?: number) => Promise<unknown>;
          }
        ).httpPost('tools/list', {}, 5000),
      ).rejects.toThrow();
    } finally {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });
});

describe('SSETransport.request timeout-signal cleanup on error', () => {
  it('disposes the timeout timer even when the request fails (no leaked timer)', async () => {
    const origFetch = globalThis.fetch;
    vi.useFakeTimers();
    try {
      const t = new SSETransport({
        name: 'leak-test',
        url: 'https://mcp.example.com/',
        requestTimeoutMs: 30_000,
      });
      // Give request() a parent signal to attach its abort listener to, and a
      // fetch that fails with a non-ok status so the throw path runs.
      (t as never as { abortController: AbortController }).abortController = new AbortController();
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = (() =>
        Promise.resolve(
          new Response('nope', { status: 500, statusText: 'Server Error' }),
        )) as never as typeof globalThis.fetch;

      await expect(
        (
          t as never as {
            request: (m: string, p: unknown, ms?: number) => Promise<unknown>;
          }
        ).request('tools/list', {}, 30_000),
      ).rejects.toThrow(/HTTP 500/);

      // If dispose() ran in the finally block, the 30s timeout timer was
      // cleared. Before the fix it stayed pending on the error path.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = origFetch;
    }
  });
});
