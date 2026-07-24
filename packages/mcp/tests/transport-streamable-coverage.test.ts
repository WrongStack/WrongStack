import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamableHTTPTransport } from '../src/transport.js';

const originalFetch = globalThis.fetch;
const INITIALIZE_RESULT = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {}, resources: {}, prompts: {} },
  serverInfo: { name: 'fixture', version: '1.0.0' },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('StreamableHTTPTransport coverage', () => {
  it('dispatches all catalog notifications and refreshes tools safely', async () => {
    const transport = new StreamableHTTPTransport({
      name: 'streamable',
      url: 'https://example.test',
    });
    const resources = vi.fn();
    const prompts = vi.fn();
    const tools = vi.fn();
    transport.onResourcesChanged(resources);
    transport.onPromptsChanged(prompts);
    transport.onToolsChanged(tools);
    transport.onToolsChanged(() => {
      throw new Error('listener failed');
    });
    const internals = transport as never as {
      handleNotification: (method: string) => void;
      postRaw: (method: string, params: unknown) => Promise<unknown>;
    };
    const postRaw = vi
      .spyOn(internals, 'postRaw')
      .mockResolvedValueOnce({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'one', inputSchema: { type: 'object' } }] },
      })
      .mockResolvedValueOnce({ jsonrpc: '2.0', id: 2, error: { code: 1, message: 'no' } })
      .mockRejectedValueOnce(new Error('offline'));

    internals.handleNotification('notifications/resources/list_changed');
    internals.handleNotification('notifications/prompts/list_changed');
    internals.handleNotification('notifications/tools/list_changed');
    await vi.waitFor(() => expect(tools).toHaveBeenCalledOnce());
    expect(transport.listTools()).toHaveLength(1);

    internals.handleNotification('notifications/tools/list_changed');
    await vi.waitFor(() => expect(postRaw).toHaveBeenCalledTimes(2));
    internals.handleNotification('notifications/tools/list_changed');
    await vi.waitFor(() => expect(postRaw).toHaveBeenCalledTimes(3));
    internals.handleNotification('notifications/unknown');
    expect(resources).toHaveBeenCalledOnce();
    expect(prompts).toHaveBeenCalledOnce();
  });

  it('connects even when the initial tool catalog returns an error', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 1, result: INITIALIZE_RESULT }))
      .mockResolvedValueOnce(new Response('', { status: 202 }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: '2.0',
          id: 3,
          error: { code: -1, message: 'catalog unavailable' },
        }),
      );
    const transport = new StreamableHTTPTransport({
      name: 'streamable',
      url: 'https://example.test',
    });

    await transport.connect();
    expect(transport.getState()).toBe('connected');
    expect(transport.listTools()).toEqual([]);
  });

  it('parses an initialize response without a content-type header', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        text: vi.fn(async () =>
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: INITIALIZE_RESULT }),
        ),
      } as unknown as Response)
      .mockResolvedValueOnce(new Response('', { status: 202 }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: '2.0', id: 3, result: { tools: [] } }));
    const transport = new StreamableHTTPTransport({
      name: 'streamable',
      url: 'https://example.test',
    });

    await expect(transport.connect()).resolves.toBeUndefined();
  });

  it('rejects an application/json initialize body that is not JSON-RPC', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ unexpected: true }));
    const transport = new StreamableHTTPTransport({
      name: 'streamable',
      url: 'https://example.test',
    });

    await expect(transport.connect()).rejects.toThrow(/Could not parse initialize/);
  });

  it('tolerates unreadable notification bodies in both request paths', async () => {
    const transport = new StreamableHTTPTransport({
      name: 'streamable',
      url: 'https://example.test',
    });
    const unreadable = () =>
      ({
        ok: true,
        status: 202,
        headers: new Headers(),
        text: vi.fn(async () => {
          throw new Error('unreadable');
        }),
      }) as unknown as Response;
    globalThis.fetch = vi.fn(async () => unreadable());
    const postRaw = (
      transport as never as {
        postRaw: (method: string, params: unknown) => Promise<unknown>;
      }
    ).postRaw.bind(transport);

    await expect(postRaw('notifications/ping', {})).resolves.toMatchObject({ jsonrpc: '2.0' });
    await expect(transport.request('notifications/ping', {})).resolves.toMatchObject({
      jsonrpc: '2.0',
    });
  });

  it('uses response fallback order and processes embedded notifications', () => {
    const transport = new StreamableHTTPTransport({
      name: 'streamable',
      url: 'https://example.test',
    });
    const changed = vi.fn();
    transport.onResourcesChanged(changed);
    const consume = (
      transport as never as {
        consumeResponseText: (text: string, id: number) => { id?: number } | undefined;
      }
    ).consumeResponseText.bind(transport);

    expect(
      consume(
        [
          '{"jsonrpc":"2.0","id":9,"method":"server/request"}',
          '{"jsonrpc":"2.0","method":"notifications/resources/list_changed"}',
          '{"jsonrpc":"2.0","id":2,"result":"fallback"}',
        ].join('\n'),
        1,
      ),
    ).toMatchObject({ id: 2 });
    expect(consume('noise', 1)).toBeUndefined();
    expect(changed).toHaveBeenCalledOnce();
  });

  it('covers postRaw HTTP, parse, session, and cancellation failures', async () => {
    const transport = new StreamableHTTPTransport({
      name: 'streamable',
      url: 'https://example.test',
    });
    const internals = transport as never as {
      abortController: AbortController;
      sessionId: string;
      postRaw: (
        method: string,
        params: unknown,
        opts?: { signal?: AbortSignal },
      ) => Promise<unknown>;
    };
    internals.sessionId = 'session';
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('failed', { status: 500 }))
      .mockResolvedValueOnce(new Response('noise'));
    await expect(internals.postRaw('tools/list', {})).rejects.toThrow(/HTTP 500/);
    await expect(internals.postRaw('tools/list', {})).rejects.toThrow(/Could not parse/);

    internals.abortController = new AbortController();
    const originalPostRaw = internals.postRaw.bind(transport);
    vi.spyOn(internals, 'postRaw').mockRejectedValue(new Error('cancel notification failed'));
    const external = new AbortController();
    external.abort();
    await expect(
      originalPostRaw('tools/list', {}, { signal: external.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports request cancellation even if the cancellation notification fails', async () => {
    const transport = new StreamableHTTPTransport({
      name: 'streamable',
      url: 'https://example.test',
    });
    const internals = transport as never as {
      abortController: AbortController;
      postRaw: (method: string, params: unknown) => Promise<unknown>;
    };
    internals.abortController = new AbortController();
    vi.spyOn(internals, 'postRaw').mockRejectedValue(new Error('cancel notification failed'));
    const external = new AbortController();
    external.abort();

    await expect(
      transport.request('resources/list', {}, undefined, { signal: external.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('defaults an empty successful tool result', async () => {
    const transport = new StreamableHTTPTransport({
      name: 'streamable',
      url: 'https://example.test',
    });
    const internals = transport as never as {
      state: 'connected';
      postRaw: (method: string, params: unknown) => Promise<unknown>;
    };
    internals.state = 'connected';
    vi.spyOn(internals, 'postRaw').mockResolvedValue({ jsonrpc: '2.0', id: 1 });

    await expect(transport.callTool('empty', {})).resolves.toEqual({
      content: '',
      isError: false,
    });
  });

  it('sends an existing session id with generic requests', async () => {
    const transport = new StreamableHTTPTransport({
      name: 'streamable',
      url: 'https://example.test',
    });
    (transport as never as { sessionId: string }).sessionId = 'session-1';
    globalThis.fetch = vi.fn(async (_input, init) => {
      expect(new Headers(init?.headers).get('Mcp-Session-Id')).toBe('session-1');
      return new Response('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    });

    await expect(transport.request('resources/list', {})).resolves.toMatchObject({
      result: { ok: true },
    });
  });
});
