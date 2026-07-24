import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_CONSTANTS } from '../src/constants.js';
import { SSEReader, SSETransport } from '../src/transport.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('SSETransport coverage', () => {
  it('routes streamed notifications during connect and cleans up the reader', async () => {
    const transport = new SSETransport({ name: 'sse', url: 'https://example.test' });
    const resources = vi.fn();
    const prompts = vi.fn();
    transport.onResourcesChanged(resources);
    transport.onPromptsChanged(prompts);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              'data: {"method":"notifications/resources/list_changed"}',
              '',
              'data: {"method":"notifications/prompts/list_changed"}',
              '',
              'data: {"method":"notifications/tools/list_changed"}',
              '',
              'data: {"method":"notifications/unknown"}',
              '',
              'data: {"method":"ignored","id":1}',
              '',
              'data: {"id":2}',
              '',
            ].join('\n'),
          ),
        );
        controller.close();
      },
    });
    globalThis.fetch = vi.fn(async () => new Response(stream));
    const internals = transport as never as {
      httpPost: (method: string, params: unknown) => Promise<unknown>;
    };
    vi.spyOn(internals, 'httpPost').mockImplementation(async (method) => {
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'fixture', version: '1.0.0' },
          },
        };
      }
      if (method === 'notifications/initialized') throw new Error('not required');
      return { jsonrpc: '2.0', id: 2, error: { code: 1, message: 'unavailable' } };
    });

    await transport.connect();
    await vi.waitFor(() => {
      expect(resources).toHaveBeenCalledOnce();
      expect(prompts).toHaveBeenCalledOnce();
    });
    await transport.close();
  });

  it('rejects missing SSE bodies and initialize errors', async () => {
    const missingBody = new SSETransport({ name: 'sse', url: 'https://example.test' });
    globalThis.fetch = vi.fn(async () => {
      return { ok: true, body: null, headers: new Headers() } as unknown as Response;
    });
    await expect(missingBody.connect()).rejects.toThrow(/no body/);

    const initializeError = new SSETransport({ name: 'sse', url: 'https://example.test' });
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream()));
    vi.spyOn(
      initializeError as never as {
        httpPost: (method: string, params: unknown) => Promise<unknown>;
      },
      'httpPost',
    ).mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      error: { code: 1, message: 'rejected' },
    });
    await expect(initializeError.connect()).rejects.toThrow(/initialize failed: rejected/);
  });

  it('refreshes tools and isolates catalog listener failures', async () => {
    const transport = new SSETransport({ name: 'sse', url: 'https://example.test' });
    const changed = vi.fn();
    transport.onToolsChanged(changed);
    transport.onToolsChanged(() => {
      throw new Error('listener failed');
    });
    const internals = transport as never as {
      handleToolsListChanged: () => Promise<void>;
      httpPost: (method: string, params: unknown) => Promise<unknown>;
    };
    vi.spyOn(internals, 'httpPost')
      .mockResolvedValueOnce({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'one', inputSchema: { type: 'object' } }] },
      })
      .mockResolvedValueOnce({
        jsonrpc: '2.0',
        id: 2,
        error: { code: 1, message: 'unavailable' },
      })
      .mockRejectedValueOnce(new Error('offline'));

    await internals.handleToolsListChanged();
    expect(changed).toHaveBeenCalledOnce();
    expect(transport.listTools()).toHaveLength(1);
    await internals.handleToolsListChanged();
    await internals.handleToolsListChanged();
  });

  it('reads SSE chunks and reports unexpected reader failure', async () => {
    const transport = new SSETransport({ name: 'sse', url: 'https://example.test' });
    const disconnected = vi.fn();
    transport.onDisconnect(disconnected);
    transport.onDisconnect(() => {
      throw new Error('listener failed');
    });
    const sseReader = new SSEReader();
    const message = vi.fn();
    sseReader.onMessage(message);
    const chunks = [
      { done: false, value: new TextEncoder().encode('data: {"id":1}\n\n') },
      { done: true, value: undefined },
    ];
    const readSSEBody = (
      transport as never as {
        readSSEBody: (
          reader: { read: () => Promise<(typeof chunks)[number]> },
          decoder: TextDecoder,
          sseReader: SSEReader,
        ) => Promise<void>;
      }
    ).readSSEBody.bind(transport);

    await readSSEBody(
      { read: vi.fn(async () => chunks.shift() ?? { done: true, value: undefined }) },
      new TextDecoder(),
      sseReader,
    );
    expect(message).toHaveBeenCalledOnce();

    await readSSEBody(
      {
        read: vi.fn(async () => {
          throw new Error('stream failed');
        }),
      },
      new TextDecoder(),
      sseReader,
    );
    expect(transport.getState()).toBe('disconnected');
    expect(disconnected).toHaveBeenCalledOnce();

    await readSSEBody(
      {
        read: vi.fn(async () => {
          throw new Error('still failed');
        }),
      },
      new TextDecoder(),
      sseReader,
    );
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('falls back to the original URL if SSE URL construction fails', () => {
    const transport = new SSETransport({ name: 'sse', url: 'https://example.test' });
    (transport as never as { url: string }).url = 'not a url';
    const url = (
      transport as never as {
        buildSSEUrl: () => string;
      }
    ).buildSSEUrl();
    expect(url).toBe('not a url');
  });

  it('caps long HTTP error bodies and preserves short ones', async () => {
    const transport = new SSETransport({ name: 'sse', url: 'https://example.test' });
    const httpPost = (
      transport as never as {
        httpPost: (method: string, params: unknown) => Promise<unknown>;
      }
    ).httpPost.bind(transport);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('x'.repeat(MCP_CONSTANTS.REQUEST_LOG_CAP + 1), { status: 500 }),
      )
      .mockResolvedValueOnce(new Response('short', { status: 500 }));

    await expect(httpPost('tools/list', {})).rejects.toThrow(/bytes total/);
    await expect(httpPost('tools/list', {})).rejects.toThrow(/short/);
  });

  it('covers httpPost cancellation and failed cancellation notification', async () => {
    const transport = new SSETransport({ name: 'sse', url: 'https://example.test' });
    const internals = transport as never as {
      abortController: AbortController;
      httpPost: (
        method: string,
        params: unknown,
        opts?: { signal?: AbortSignal },
      ) => Promise<unknown>;
    };
    internals.abortController = new AbortController();
    const originalHttpPost = internals.httpPost.bind(transport);
    vi.spyOn(internals, 'httpPost').mockRejectedValue(new Error('cancel failed'));
    const external = new AbortController();
    external.abort();

    await expect(
      originalHttpPost('tools/list', {}, { signal: external.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('describes a non-Error httpPost parse failure', async () => {
    const transport = new SSETransport({ name: 'sse', url: 'https://example.test' });
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => Promise.reject('non-error failure'),
            releaseLock: vi.fn(),
          }),
        },
        headers: new Headers(),
      } as unknown as Response;
    });
    const httpPost = (
      transport as never as {
        httpPost: (method: string, params: unknown) => Promise<unknown>;
      }
    ).httpPost.bind(transport);

    await expect(httpPost('tools/list', {})).rejects.toThrow(/parse failed/);
  });

  it('defaults an empty successful tool result', async () => {
    const transport = new SSETransport({ name: 'sse', url: 'https://example.test' });
    const internals = transport as never as {
      state: 'connected';
      httpPost: (method: string, params: unknown) => Promise<unknown>;
    };
    internals.state = 'connected';
    vi.spyOn(internals, 'httpPost').mockResolvedValue({ jsonrpc: '2.0', id: 1 });
    await expect(transport.callTool('empty', {})).resolves.toEqual({
      content: '',
      isError: false,
    });

    vi.spyOn(internals, 'httpPost').mockResolvedValue({
      jsonrpc: '2.0',
      id: 2,
      error: { code: 1, message: 'tool failed' },
    });
    await expect(transport.callTool('failed', {})).resolves.toEqual({
      content: 'tool failed',
      isError: true,
    });
  });

  it('handles generic request success, HTTP failure, and parse failures', async () => {
    const transport = new SSETransport({ name: 'sse', url: 'https://example.test' });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'))
      .mockResolvedValueOnce(new Response('failed', { status: 503 }))
      .mockResolvedValueOnce(new Response('not-json'))
      .mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => ({
            read: async () => Promise.reject('non-error failure'),
            releaseLock: vi.fn(),
          }),
        },
        headers: new Headers(),
      } as unknown as Response);

    await expect(transport.request('resources/list', {}, 1_000)).resolves.toMatchObject({
      result: { ok: true },
    });
    await expect(transport.request('resources/list', {})).rejects.toThrow(/HTTP 503/);
    await expect(transport.request('resources/list', {})).rejects.toThrow(/Unexpected token|JSON/);
    await expect(transport.request('resources/list', {})).rejects.toThrow(/parse failed/);
  });

  it('reports generic request cancellation when notification delivery fails', async () => {
    const transport = new SSETransport({ name: 'sse', url: 'https://example.test' });
    const internals = transport as never as {
      abortController: AbortController;
      httpPost: (method: string, params: unknown) => Promise<unknown>;
    };
    internals.abortController = new AbortController();
    vi.spyOn(internals, 'httpPost').mockRejectedValue(new Error('cancel failed'));
    const external = new AbortController();
    external.abort();

    await expect(
      transport.request('resources/list', {}, undefined, { signal: external.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ignores reader cleanup failures on close', async () => {
    const transport = new SSETransport({ name: 'sse', url: 'https://example.test' });
    (transport as never as { reader: { cancel: () => void; releaseLock: () => void } }).reader = {
      cancel: () => {
        throw new Error('cancel failed');
      },
      releaseLock: () => {
        throw new Error('release failed');
      },
    };

    await expect(transport.close()).resolves.toBeUndefined();
  });
});
